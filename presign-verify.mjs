/**
 * Shared Morpho withdraw calldata verification for presigned bundles.
 * Used by proxy (pre-save), webapp-server (POST /api/presign), and monitor (pre-broadcast).
 */
import {
  parseTransaction,
  decodeFunctionData,
  keccak256,
  encodeAbiParameters,
  recoverTransactionAddress,
} from "viem";

export const MORPHO_WITHDRAW_ABI = [{
  type: "function",
  name: "withdraw",
  inputs: [
    {
      name: "marketParams",
      type: "tuple",
      internalType: "MarketParams",
      components: [
        { name: "loanToken", type: "address" },
        { name: "collateralToken", type: "address" },
        { name: "oracle", type: "address" },
        { name: "irm", type: "address" },
        { name: "lltv", type: "uint256" },
      ],
    },
    { name: "assets", type: "uint256" },
    { name: "shares", type: "uint256" },
    { name: "onBehalf", type: "address" },
    { name: "receiver", type: "address" },
  ],
  outputs: [
    { name: "withdrawnAssets", type: "uint256" },
    { name: "withdrawnShares", type: "uint256" },
  ],
  stateMutability: "nonpayable",
}];

const MARKET_PARAMS_TYPES = [
  { type: "address" },
  { type: "address" },
  { type: "address" },
  { type: "address" },
  { type: "uint256" },
];

// ============================================================
// MÃ LỖI VERIFY (audit vòng 2, D2)
// ============================================================
// Phân biệt lỗi do MÔI TRƯỜNG (operator đổi .env: LENDER_ADDRESS /
// MORPHO_BLUE_ADDRESS) với lỗi thuộc về NỘI DUNG bundle. Trước đây broadcaster
// đánh `invalid` cho mọi lỗi verify, nên một lần lệch .env giết IM LẶNG + VĨNH
// VIỄN mọi bundle đã ký (không thử lại, không cảnh báo).
/** Thiếu cấu hình để verify (không có morphoBlueAddress/lenderAddress/marketId). */
export const VERIFY_CONFIG_MISSING = "CONFIG_MISSING";
/** Cấu hình hiện tại KHÁC bundle đã ký (lệch .env) — bundle vẫn tốt. */
export const VERIFY_CONFIG_MISMATCH = "CONFIG_MISMATCH";
/** Bundle/calldata thật sự sai — không bao giờ broadcast được. */
export const VERIFY_BUNDLE_INVALID = "BUNDLE_INVALID";

const CONFIG_ERROR_CODES = new Set([VERIFY_CONFIG_MISSING, VERIFY_CONFIG_MISMATCH]);

/** True khi lỗi verify là do MÔI TRƯỜNG, không phải do bundle hỏng. */
export function isConfigVerifyError(code) {
  return CONFIG_ERROR_CODES.has(code);
}

/** Compute Morpho Blue market Id from MarketParams (abi.encode + keccak256). */
export function computeMarketId(marketParams) {
  const p = marketParams;
  return keccak256(
    encodeAbiParameters(MARKET_PARAMS_TYPES, [
      p.loanToken,
      p.collateralToken,
      p.oracle,
      p.irm,
      p.lltv,
    ])
  );
}

/**
 * Decode + verify one signed Morpho withdraw tx against expected labels/config.
 * Fail-closed: any mismatch returns { ok: false, error }.
 * Also recovers ECDSA sender and requires from === lenderAddress.
 *
 * @param {string} signedTx - raw signed tx hex
 * @param {object} expected
 * @param {string} expected.morphoBlueAddress
 * @param {string} expected.lenderAddress
 * @param {string} expected.marketId
 * @param {string|number|bigint|null} [expected.nonce]
 * @param {string} [expected.amountWei] - for fixed-amount tiers
 * @param {string} [expected.sharesWei] - for all-shares tiers
 * @param {boolean} [expected.isAllShares]
 * @param {boolean} [expected.skipAmountChecks] - capture-time: only to/fn/onBehalf/receiver/market/from
 * @returns {Promise<{ ok: true, decoded: object } | { ok: false, error: string, code: string }>}
 *   `code` là VERIFY_CONFIG_MISSING | VERIFY_CONFIG_MISMATCH | VERIFY_BUNDLE_INVALID
 *   (additive — chỉ xuất hiện ở nhánh lỗi; nhánh thành công không đổi shape).
 */
export async function verifyWithdrawCalldata(signedTx, expected) {
  if (!signedTx || typeof signedTx !== "string") {
    return { ok: false, code: VERIFY_BUNDLE_INVALID, error: "missing signedTx" };
  }

  let tx;
  try {
    tx = parseTransaction(signedTx);
  } catch (err) {
    return { ok: false, code: VERIFY_BUNDLE_INVALID, error: `parse signedTx: ${err.message}` };
  }

  const morpho = expected.morphoBlueAddress?.toLowerCase();
  if (!morpho || tx.to?.toLowerCase() !== morpho) {
    return {
      ok: false,
      // tx.to phụ thuộc MORPHO_BLUE_ADDRESS trong .env ⇒ đổi .env là "lệch cấu hình".
      code: VERIFY_CONFIG_MISMATCH,
      error: `tx.to ${tx.to} !== Morpho Blue ${expected.morphoBlueAddress}`,
    };
  }

  if (tx.chainId != null && Number(tx.chainId) !== 1) {
    return { ok: false, code: VERIFY_BUNDLE_INVALID, error: `chainId ${tx.chainId} !== 1` };
  }

  if (expected.nonce != null && expected.nonce !== "" && Number(tx.nonce) !== Number(expected.nonce)) {
    return {
      ok: false,
      code: VERIFY_BUNDLE_INVALID,
      error: `tx nonce ${tx.nonce} !== bundle nonce ${expected.nonce}`,
    };
  }

  if (!tx.data || tx.data === "0x") {
    return { ok: false, code: VERIFY_BUNDLE_INVALID, error: "missing calldata" };
  }

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: MORPHO_WITHDRAW_ABI, data: tx.data });
  } catch (err) {
    return { ok: false, code: VERIFY_BUNDLE_INVALID, error: `decode calldata: ${err.message}` };
  }

  if (decoded.functionName !== "withdraw") {
    return { ok: false, code: VERIFY_BUNDLE_INVALID, error: `function ${decoded.functionName} !== withdraw` };
  }

  const [marketParams, assets, shares, onBehalf, receiver] = decoded.args;
  const lender = expected.lenderAddress?.toLowerCase();
  if (!lender) {
    return { ok: false, code: VERIFY_CONFIG_MISSING, error: "missing expected lenderAddress" };
  }
  if (onBehalf?.toLowerCase() !== lender) {
    return { ok: false, code: VERIFY_CONFIG_MISMATCH, error: `onBehalf ${onBehalf} !== lender ${expected.lenderAddress}` };
  }
  if (receiver?.toLowerCase() !== lender) {
    return { ok: false, code: VERIFY_CONFIG_MISMATCH, error: `receiver ${receiver} !== lender ${expected.lenderAddress}` };
  }

  let from;
  try {
    from = await recoverTransactionAddress({ serializedTransaction: signedTx });
  } catch (err) {
    return { ok: false, code: VERIFY_BUNDLE_INVALID, error: `recover sender: ${err.message}` };
  }
  if (from.toLowerCase() !== lender) {
    return {
      ok: false,
      // Chữ ký hợp lệ nhưng không phải ví lender ⇒ LENDER_ADDRESS trong .env đã đổi.
      code: VERIFY_CONFIG_MISMATCH,
      error: `sender ${from} !== lender ${expected.lenderAddress}`,
    };
  }

  if (expected.marketId) {
    const computedId = computeMarketId(marketParams);
    if (computedId.toLowerCase() !== expected.marketId.toLowerCase()) {
      return {
        ok: false,
        code: VERIFY_BUNDLE_INVALID,
        error: `marketId ${computedId} !== expected ${expected.marketId}`,
      };
    }
  }

  if (!expected.skipAmountChecks) {
    const isAllShares = expected.isAllShares || expected.type === "all-shares";
    if (isAllShares) {
      if (expected.sharesWei == null || expected.sharesWei === "") {
        return { ok: false, code: VERIFY_BUNDLE_INVALID, error: "all-shares missing sharesWei label" };
      }
      if (BigInt(shares) !== BigInt(expected.sharesWei)) {
        return {
          ok: false,
          code: VERIFY_BUNDLE_INVALID,
          error: `shares ${shares} !== sharesWei ${expected.sharesWei}`,
        };
      }
      // assets should be 0 for shares-based withdraw
      if (assets != null && BigInt(assets) !== 0n) {
        return { ok: false, code: VERIFY_BUNDLE_INVALID, error: `all-shares assets should be 0, got ${assets}` };
      }
    } else {
      if (expected.amountWei == null || expected.amountWei === "") {
        return { ok: false, code: VERIFY_BUNDLE_INVALID, error: "missing amountWei label" };
      }
      if (BigInt(assets) !== BigInt(expected.amountWei)) {
        return {
          ok: false,
          code: VERIFY_BUNDLE_INVALID,
          error: `assets ${assets} !== amountWei ${expected.amountWei}`,
        };
      }
      // fixed-amount: shares must be 0
      if (shares != null && BigInt(shares) !== 0n) {
        return { ok: false, code: VERIFY_BUNDLE_INVALID, error: `fixed-amount shares should be 0, got ${shares}` };
      }
    }
  }

  return {
    ok: true,
    decoded: {
      marketParams,
      assets,
      shares,
      onBehalf,
      receiver,
      nonce: tx.nonce,
      to: tx.to,
      from,
    },
  };
}

/**
 * Gate eth_sendRawTransaction capture: sender must be lender + Morpho withdraw shape.
 * Does not require amountWei/sharesWei labels (unknown until /bundle metadata).
 * Reuses verifyWithdrawCalldata (single ECDSA recover).
 *
 * @returns {Promise<{ ok: true, from: string, decoded: object } | { ok: false, error: string }>}
 */
export async function assertCaptureTx(signedTx, expected) {
  const shape = await verifyWithdrawCalldata(signedTx, {
    ...expected,
    skipAmountChecks: true,
  });
  if (!shape.ok) return shape;
  return { ok: true, from: shape.decoded.from, decoded: shape.decoded };
}

/**
 * Verify every withdrawal in a bundle against config + per-tier labels.
 *
 * @returns {Promise<{ ok: true } | { ok: false, error: string, index?: number, code: string }>}
 *
 * Audit vòng 2 (D2): mọi nhánh lỗi mang thêm `code`
 * (VERIFY_CONFIG_MISSING / VERIFY_CONFIG_MISMATCH / VERIFY_BUNDLE_INVALID) để caller
 * phân biệt "môi trường lệch" với "bundle hỏng". Nhánh thành công KHÔNG đổi shape.
 */
export async function verifyPresignedBundle(bundle, config = {}) {
  if (!bundle || typeof bundle !== "object") {
    return { ok: false, code: VERIFY_BUNDLE_INVALID, error: "bundle must be an object" };
  }
  if (!Array.isArray(bundle.withdrawals) || bundle.withdrawals.length === 0) {
    return { ok: false, code: VERIFY_BUNDLE_INVALID, error: "withdrawals empty" };
  }

  const morphoBlueAddress = config.morphoBlueAddress || bundle.morphoBlueAddress;
  const lenderAddress = config.lenderAddress || bundle.lenderAddress;
  const marketId = config.marketId || bundle.marketId;

  if (!morphoBlueAddress) return { ok: false, code: VERIFY_CONFIG_MISSING, error: "missing morphoBlueAddress" };
  if (!lenderAddress) return { ok: false, code: VERIFY_CONFIG_MISSING, error: "missing lenderAddress" };
  if (!marketId) return { ok: false, code: VERIFY_CONFIG_MISSING, error: "missing marketId" };

  // Ba so sánh dưới đây là DẤU HIỆU LỆCH .env: bundle tự khai địa chỉ/market mà nó
  // được ký, khác với cấu hình hiện tại ⇒ bundle vẫn tốt, chỉ môi trường đổi.
  if (config.lenderAddress && bundle.lenderAddress &&
      config.lenderAddress.toLowerCase() !== bundle.lenderAddress.toLowerCase()) {
    return { ok: false, code: VERIFY_CONFIG_MISMATCH, error: "bundle.lenderAddress !== config lender" };
  }
  if (config.marketId && bundle.marketId &&
      config.marketId.toLowerCase() !== bundle.marketId.toLowerCase()) {
    return { ok: false, code: VERIFY_CONFIG_MISMATCH, error: "bundle.marketId !== config market" };
  }
  if (config.morphoBlueAddress && bundle.morphoBlueAddress &&
      config.morphoBlueAddress.toLowerCase() !== bundle.morphoBlueAddress.toLowerCase()) {
    return { ok: false, code: VERIFY_CONFIG_MISMATCH, error: "bundle.morphoBlueAddress !== config Morpho" };
  }

  const txNonces = [];
  for (let i = 0; i < bundle.withdrawals.length; i++) {
    const w = bundle.withdrawals[i];
    const result = await verifyWithdrawCalldata(w.signedTx, {
      morphoBlueAddress,
      lenderAddress,
      marketId,
      nonce: bundle.nonce,
      amountWei: w.amountWei,
      sharesWei: w.sharesWei,
      isAllShares: w.type === "all-shares",
    });
    if (!result.ok) {
      // Propagate mã lỗi của tier (config vs nội dung) — broadcaster dựa vào đây.
      return { ok: false, code: result.code, error: `withdrawals[${i}]: ${result.error}`, index: i };
    }
    txNonces.push(result.decoded.nonce);
  }

  const unique = [...new Set(txNonces.map(Number))];
  if (unique.length > 1) {
    return { ok: false, code: VERIFY_BUNDLE_INVALID, error: `inconsistent tx nonces: ${unique.join(", ")}` };
  }

  return { ok: true };
}

/**
 * Match tier metadata to captured txs by txHash (case-insensitive).
 * Fail closed on any unmatched tier (no partial bundles).
 */
export function matchTiersToCaptured(tiers, capturedTxs) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { ok: false, error: "tiers empty" };
  }
  if (!Array.isArray(capturedTxs) || capturedTxs.length === 0) {
    return { ok: false, error: "No captured transactions" };
  }

  const txMap = new Map(
    capturedTxs.map((tx) => [tx.hash?.toLowerCase(), tx.signedTx])
  );
  const matchedHashes = [];
  const withdrawals = [];

  for (const tier of tiers) {
    const key = tier.txHash?.toLowerCase();
    const signedTx = key ? txMap.get(key) : null;
    if (!signedTx) {
      return {
        ok: false,
        error: "Tier txHash không match captured txs (partial match rejected)",
        unmatched: tier.txHash || null,
      };
    }
    matchedHashes.push(tier.txHash);
    const entry = {
      label: tier.label,
      amountWei: tier.amountWei,
      amountFormatted: tier.amountFormatted,
      signedTx,
    };
    if (tier.type === "all-shares") {
      entry.type = "all-shares";
      entry.sharesWei = tier.sharesWei;
    }
    withdrawals.push(entry);
  }

  if (withdrawals.length !== tiers.length) {
    return { ok: false, error: "Partial tier match rejected" };
  }

  return { ok: true, withdrawals, matchedHashes };
}

/**
 * Always use configured WEBAPP_URL — never trust client meta.serverUrl (SSRF).
 */
export function resolveBundleServerUrl(_meta, webappUrl) {
  return (webappUrl || "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Remove only matched hashes from captured buffer (keep unmatched).
 */
export function clearMatchedCaptured(capturedTxs, matchedHashes) {
  const matchedSet = new Set(matchedHashes.map((h) => h?.toLowerCase()));
  for (let i = capturedTxs.length - 1; i >= 0; i--) {
    if (matchedSet.has(capturedTxs[i].hash?.toLowerCase())) {
      capturedTxs.splice(i, 1);
    }
  }
  return capturedTxs;
}
