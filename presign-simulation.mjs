/**
 * Cho ví có mô phỏng trước khi ký (Ambire) ký được giao dịch ký sẵn.
 *
 * VẤN ĐỀ (chẩn đoán 2026-10-30): giao dịch ký sẵn được thiết kế để REVERT
 * ngay lúc ký — nó rút một khoản lớn hơn thanh khoản hiện có, và monitor chỉ
 * broadcast khi thanh khoản xuất hiện. Ví có mô phỏng (Ambire) thấy revert
 * `insufficient liquidity` của Morpho và TỪ CHỐI ký, nên không tạo được presign.
 *
 * CÁCH SỬA: proxy là RPC mà ví dùng để mô phỏng. Khi ví mô phỏng ĐÚNG một
 * `withdraw` hợp lệ của lender tới market đã cấu hình và thất bại CHỈ vì
 * thiếu thanh khoản, proxy gọi lại `eth_call` kèm `stateOverride` cấp
 * "thanh khoản ảo" cho market, rồi trả kết quả thành công cho ví.
 *
 * Module này là phần THUẦN (không I/O): nhận diện call, nhận diện revert,
 * dựng word storage. Việc đọc storage + gọi lại nằm ở `proxy-dispatcher.mjs`.
 *
 * AN TOÀN — ba lớp:
 *  1. Chỉ đúng revert `insufficient liquidity`. Panic/unauthorized/revert khác
 *     đi qua nguyên trạng (đã kiểm chứng: withdraw vượt số shares của lender
 *     vẫn là panic 0x11 và KHÔNG bị che).
 *  2. Chỉ withdraw của LENDER (`onBehalf == receiver == lender`) tới market
 *     nằm trong allow-list. Không bao giờ che một lệnh rút của người khác.
 *  3. Override chỉ nhân đôi CẢ `totalSupplyAssets` lẫn `totalSupplyShares` ⇒
 *     giá share giữ nguyên, chỉ thanh khoản tăng. Giao dịch ký ra vẫn chỉ được
 *     capture, không bao giờ được proxy broadcast.
 */
import { decodeErrorResult, decodeFunctionData, encodeAbiParameters, keccak256, toFunctionSelector } from "viem";
import { MORPHO_WITHDRAW_ABI, computeMarketId } from "./presign-verify.mjs";

/**
 * Slot của `mapping(Id => Market) public market` trong storage Morpho Blue.
 *
 * Đã kiểm chứng trên mainnet (2026-10-30): key `keccak256(abi.encode(id, 3))`
 * đọc ra đúng word có low 128 = `market(id).totalSupplyAssets` và high 128 =
 * `totalSupplyShares`. Layout này thuộc về bytecode Morpho Blue (không đổi theo
 * chain), không phải cấu hình của deployment này.
 */
export const MORPHO_MARKET_SLOT = 3n;

/** `withdraw(MarketParams,uint256,uint256,address,address)` — tính từ ABI, không hardcode. */
export const MORPHO_WITHDRAW_SELECTOR = toFunctionSelector(MORPHO_WITHDRAW_ABI[0]);

const UINT128_MAX = (1n << 128n) - 1n;
/** `Error(string)` — Morpho bản đang chạy revert bằng string, không phải custom error. */
const ERROR_STRING_SELECTOR = "0x08c379a0";
/** `InsufficientLiquidity()` — custom error ở các bản Morpho khác; nhận cả hai. */
const INSUFFICIENT_LIQUIDITY_SELECTOR = "0xbb55fd27";
const ERROR_STRING_ABI = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
];

/** Revert có phải "insufficient liquidity" của Morpho? */
export function isInsufficientLiquidityRevert(err) {
  const data = typeof err?.data === "string" ? err.data.toLowerCase() : "";
  if (data.startsWith(INSUFFICIENT_LIQUIDITY_SELECTOR)) return true;
  if (data.startsWith(ERROR_STRING_SELECTOR)) {
    try {
      const decoded = decodeErrorResult({ abi: ERROR_STRING_ABI, data });
      if (isInsufficientLiquidityMessage(decoded.args?.[0])) return true;
    } catch {
      // data hỏng/không decode được — rơi xuống xét message bên dưới.
    }
  }
  // Nhiều node chỉ trả message mà không kèm `data`; cả hai đều là bằng chứng.
  return (
    isInsufficientLiquidityMessage(err?.details) ||
    isInsufficientLiquidityMessage(err?.cause?.message) ||
    isInsufficientLiquidityMessage(err?.message)
  );
}

function isInsufficientLiquidityMessage(value) {
  return typeof value === "string" && /insufficient liquidity\b/i.test(value);
}

/** Storage key của market trong Morpho Blue: `keccak256(abi.encode(marketId, 3))`. */
export function marketStorageKey(marketId) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [marketId, MORPHO_MARKET_SLOT]
    )
  );
}

/**
 * Nhân đôi `totalSupplyAssets` (low 128) và `totalSupplyShares` (high 128).
 *
 * Vì sao nhân ĐÔI cả hai chứ không chỉ bơm assets: conversion shares↔assets của
 * Morpho dùng chính hai tổng này. Chỉ bơm assets sẽ làm giá share tăng ⇒ mô phỏng
 * tính ra số shares/assets khác thực tế. Nhân đôi cả hai giữ nguyên giá share
 * (sai số làm tròn ≤ 1 wei) và thêm đúng `totalSupplyAssets` thanh khoản ảo —
 * đủ cho MỌI vị thế hợp lệ, vì vị thế của một lender ≤ tổng cung của market.
 *
 * Saturate ở uint128 max thay vì tràn (một market không bao giờ gần ngưỡng này,
 * nhưng fail closed vẫn hơn một word rác).
 */
export function doubleSupplyWord(currentWordHex) {
  const word = BigInt(currentWordHex);
  const supplyAssets = word & UINT128_MAX;
  const supplyShares = (word >> 128n) & UINT128_MAX;
  const doubledAssets = supplyAssets > UINT128_MAX / 2n ? UINT128_MAX : supplyAssets * 2n;
  const doubledShares = supplyShares > UINT128_MAX / 2n ? UINT128_MAX : supplyShares * 2n;
  return "0x" + ((doubledShares << 128n) | doubledAssets).toString(16).padStart(64, "0");
}

/**
 * Call này có phải mô phỏng một presign withdraw của lender không?
 *
 * Trả `{ marketId, shape }` hoặc `null`. `shape` chỉ để log:
 *  - `direct`   — ví gọi thẳng Morpho với calldata `withdraw` (đường chuẩn).
 *  - `embedded` — ví mô phỏng qua wrapper/deployless (`execute([{to: Morpho,
 *                 data: withdraw}])`): calldata withdraw nằm LỒNG trong data,
 *                 nên `to` không phải Morpho. Quét mọi vị trí của selector
 *                 withdraw và THỬ DECODE phần đuôi từ đó — chỉ một calldata
 *                 ABI hợp lệ mới decode được, và vẫn phải qua đủ cửa lender +
 *                 market allow-list. Không dựa vào việc tìm chuỗi marketId:
 *                 calldata chứa marketParams, KHÔNG chứa id (id là hash).
 *
 * Không bao giờ "đoán" một market: marketId phải khớp allow-list đã cấu hình.
 */
export function findPresignTarget(call, { morphoBlueAddress, lenderAddress, markets } = {}) {
  const lender = String(lenderAddress ?? "").toLowerCase();
  const morpho = String(morphoBlueAddress ?? "").toLowerCase();
  const marketIds = new Set(
    (Array.isArray(markets) ? markets : []).map((market) => String(market?.id ?? market ?? "").toLowerCase())
  );
  if (!lender || lender === "0x" || !morpho || marketIds.size === 0) return null;

  const to = String(call?.to ?? "").toLowerCase();
  const data = String(call?.data ?? "");
  if (!data.startsWith("0x") || data.length < 10) return null;

  if (to === morpho) {
    // `to` là Morpho: chỉ có withdraw hợp lệ mới đáng can thiệp. Calldata khác
    // (supply/repay/…) hoặc withdraw sai người nhận ⇒ KHÔNG rơi xuống nhánh
    // embedded — nếu không, một cuộc gọi lạ tới Morpho có thể khớp nhầm dấu vết.
    if (!data.toLowerCase().startsWith(MORPHO_WITHDRAW_SELECTOR)) return null;
    return decodeDirectWithdraw(data, lender, marketIds);
  }
  return findEmbeddedWithdraw(data.toLowerCase(), lender, marketIds);
}

function decodeDirectWithdraw(data, lender, marketIds) {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: MORPHO_WITHDRAW_ABI, data });
  } catch {
    return null;
  }
  if (decoded.functionName !== "withdraw") return null;
  const [marketParams, assets, shares, onBehalf, receiver] = decoded.args;
  // Morpho revert ZERO_ASSETS cho 0/0 — không phải ca thiếu thanh khoản.
  if (BigInt(assets) === 0n && BigInt(shares) === 0n) return null;
  if (String(onBehalf).toLowerCase() !== lender) return null;
  if (String(receiver).toLowerCase() !== lender) return null;
  let marketId;
  try {
    marketId = computeMarketId(marketParams).toLowerCase();
  } catch {
    return null;
  }
  if (!marketIds.has(marketId)) return null;
  return { marketId, shape: "direct" };
}

function findEmbeddedWithdraw(dataLower, lender, marketIds) {
  const selector = MORPHO_WITHDRAW_SELECTOR.slice(2).toLowerCase();
  let index = dataLower.indexOf(selector);
  while (index !== -1) {
    // Bytes của calldata được nhúng nguyên văn trong wrapper/deployless data ⇒
    // decode từ đúng vị trí selector cho ra đủ tham số. Byte rác/độ lệch sẽ
    // khiến decode ném; vòng lặp chỉ chấp nhận một calldata hợp lệ.
    const target = decodeDirectWithdraw("0x" + dataLower.slice(index), lender, marketIds);
    if (target) return { marketId: target.marketId, shape: "embedded" };
    index = dataLower.indexOf(selector, index + 1);
  }
  return null;
}

/**
 * Gắn state override cấp thanh khoản vào params của `eth_call`.
 *
 * MERGE với override sẵn có của ví (Ambire gửi `params[2]` để spoof origin/state):
 * thay thế cả object sẽ làm hỏng mô phỏng của ví theo cách khó chẩn đoán. Tìm
 * đúng key Morpho theo kiểu không phân biệt hoa thường, giữ mọi account khác và
 * mọi field khác (`balance`, `code`, `state`, …) của chính Morpho.
 *
 * @returns {Array|null} params mới cho lần `eth_call` thứ hai, hoặc null nếu
 *   params không dùng được (caller trả revert gốc).
 */
export function mergeLiquidityOverride(params, { morphoBlueAddress, slotKey, word } = {}) {
  if (!Array.isArray(params) || !params[0] || typeof params[0] !== "object") return null;
  if (!morphoBlueAddress || !slotKey || !word) return null;
  const [call, blockTag, rawOverrides] = params;
  const overrides =
    rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides) ? rawOverrides : {};
  const key =
    Object.keys(overrides).find((item) => String(item).toLowerCase() === morphoBlueAddress.toLowerCase()) ??
    morphoBlueAddress;
  const existing = overrides[key] && typeof overrides[key] === "object" ? overrides[key] : {};
  const stateDiff =
    existing.stateDiff && typeof existing.stateDiff === "object" ? existing.stateDiff : {};
  return [
    call,
    blockTag ?? "latest",
    { ...overrides, [key]: { ...existing, stateDiff: { ...stateDiff, [slotKey]: word } } },
  ];
}
