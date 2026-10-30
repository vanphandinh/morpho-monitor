/**
 * Chẩn đoán 2026-10-30 — ví có mô phỏng (Ambire) không ký được giao dịch ký sẵn
 * vì withdraw revert `insufficient liquidity` tại thời điểm ký.
 *
 * Test này ghim ba thứ:
 *  1. Nhận diện ĐÚNG call/revert (và không nhận nhầm lỗi khác).
 *  2. `stateOverride` cấp thanh khoản: nhân đôi cả hai nửa word storage, merge
 *     với override sẵn có của ví.
 *  3. Đường `eth_call` của proxy: revert liquidity → trả kết quả thành công;
 *     mọi ca khác (flag tắt, market lạ, revert khác, storage lỗi) giữ nguyên lỗi.
 */
import { describe, it, expect } from "vitest";
import { encodeErrorResult, encodeFunctionData, encodeFunctionResult } from "viem";
import { createRpcDispatcher } from "../proxy-dispatcher.mjs";
import { buildWebappConfig } from "../webapp-config.mjs";
import { computeMarketId, MORPHO_WITHDRAW_ABI } from "../presign-verify.mjs";
import {
  MORPHO_MARKET_SLOT,
  MORPHO_WITHDRAW_SELECTOR,
  doubleSupplyWord,
  findPresignTarget,
  isInsufficientLiquidityRevert,
  marketStorageKey,
  mergeLiquidityOverride,
} from "../presign-simulation.mjs";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const LENDER = "0x0a5e1db3671faccd146404925bda5c59929f66c3";
const OTHER_ACCOUNT = "0x1111111111111111111111111111111111111111";

// Market thật của deployment (config/markets.json), đã đối chiếu on-chain.
const MARKET_PARAMS = {
  loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  collateralToken: "0x91d14789071e5e195ffc9f745348736677de3292",
  oracle: "0x0798de3ddb22c289a653c020863aaa7ef33c05d7",
  irm: "0x870ac11d48b15db9a138cf899d20f13f79ba00bc",
  lltv: 625000000000000000n,
};
const MARKET_ID = computeMarketId(MARKET_PARAMS);
// Word storage thật của market trên mainnet (low 128 = assets, high 128 = shares).
const STORAGE_WORD = "0x0000000000000000ba8e68fa79a45cc3000000000000000000000d17232384e7";
const SUCCESS_RESULT = encodeFunctionResult({
  abi: MORPHO_WITHDRAW_ABI,
  functionName: "withdraw",
  result: [20_000_000_000n, 18_679_592_027_534_151n],
});

const ERROR_STRING_ABI = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
];
const LIQUIDITY_REVERT = encodeErrorResult({
  abi: ERROR_STRING_ABI,
  args: ["insufficient liquidity"],
});
const PANIC_REVERT = "0x4e487b71" + "0".repeat(57) + "11";
const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
];

function withdrawCalldata({ assets = 20_000_000_000n, shares = 0n, onBehalf = LENDER, receiver = LENDER, params = MARKET_PARAMS } = {}) {
  return encodeFunctionData({
    abi: MORPHO_WITHDRAW_ABI,
    functionName: "withdraw",
    args: [params, assets, shares, onBehalf, receiver],
  });
}

/** Ví Ambire mô phỏng qua account wrapper: `execute([{ to: Morpho, data: withdraw }])`. */
function wrappedCalldata(data) {
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: [[{ to: MORPHO, value: 0n, data }]],
  });
}

describe("presign-simulation — nhận diện revert", () => {
  it("nhận string revert của Morpho (0x08c379a0) và custom error (0xbb55fd27)", () => {
    expect(isInsufficientLiquidityRevert({ data: LIQUIDITY_REVERT })).toBe(true);
    expect(isInsufficientLiquidityRevert({ data: "0xbb55fd27" })).toBe(true);
  });

  it("nhận message-only (node không trả data)", () => {
    expect(isInsufficientLiquidityRevert({ details: "execution reverted: insufficient liquidity" })).toBe(true);
    expect(isInsufficientLiquidityRevert({ message: "execution reverted: insufficient liquidity" })).toBe(true);
  });

  it("KHÔNG che lỗi khác: unauthorized, panic, lỗi rỗng", () => {
    expect(isInsufficientLiquidityRevert({ data: PANIC_REVERT })).toBe(false);
    expect(isInsufficientLiquidityRevert({ data: encodeErrorResult({ abi: ERROR_STRING_ABI, args: ["unauthorized"] }) })).toBe(false);
    expect(isInsufficientLiquidityRevert({})).toBe(false);
    expect(isInsufficientLiquidityRevert(null)).toBe(false);
  });
});

describe("presign-simulation — nhận diện call", () => {
  const ctx = { morphoBlueAddress: MORPHO, lenderAddress: LENDER, markets: [{ id: MARKET_ID }] };

  it("withdraw trực tiếp của lender tới market đã cấu hình", () => {
    expect(findPresignTarget({ to: MORPHO, data: withdrawCalldata() }, ctx)).toEqual({
      marketId: MARKET_ID.toLowerCase(),
      shape: "direct",
    });
  });

  it("all-shares (assets=0) vẫn là presign hợp lệ", () => {
    const target = findPresignTarget({ to: MORPHO, data: withdrawCalldata({ assets: 0n, shares: 414_649_453_043_776_137n }) }, ctx);
    expect(target?.shape).toBe("direct");
  });

  it("receiver không phải lender ⇒ không can thiệp", () => {
    const target = findPresignTarget({ to: MORPHO, data: withdrawCalldata({ receiver: OTHER_ACCOUNT }) }, ctx);
    expect(target).toBeNull();
  });

  it("market ngoài allow-list ⇒ không can thiệp", () => {
    const foreign = { ...MARKET_PARAMS, lltv: 860000000000000000n };
    const target = findPresignTarget({ to: MORPHO, data: withdrawCalldata({ params: foreign }) }, ctx);
    expect(target).toBeNull();
  });

  it("withdraw 0/0 (ZERO_ASSETS) ⇒ không can thiệp", () => {
    const target = findPresignTarget({ to: MORPHO, data: withdrawCalldata({ assets: 0n, shares: 0n }) }, ctx);
    expect(target).toBeNull();
  });

  it("calldata khác trên Morpho ⇒ không can thiệp", () => {
    expect(findPresignTarget({ to: MORPHO, data: "0x12345678" }, ctx)).toBeNull();
  });

  it("ví bọc qua execute(...)/deployless: tìm thấy withdraw lồng bên trong", () => {
    const target = findPresignTarget({ to: LENDER, data: wrappedCalldata(withdrawCalldata()) }, ctx);
    expect(target).toEqual({ marketId: MARKET_ID.toLowerCase(), shape: "embedded" });
  });

  it("data có selector + market nhưng thiếu lender ⇒ không can thiệp", () => {
    const withoutLender = "0x" + MORPHO_WITHDRAW_SELECTOR.slice(2) + "0".repeat(64) + MARKET_ID.slice(2);
    expect(findPresignTarget({ to: OTHER_ACCOUNT, data: withoutLender }, ctx)).toBeNull();
  });
});

describe("presign-simulation — storage override", () => {
  it("slot market là 3 và key = keccak256(abi.encode(id, 3))", () => {
    expect(MORPHO_MARKET_SLOT).toBe(3n);
    expect(marketStorageKey(MARKET_ID)).toBe(
      "0xbc3926d85195c0315fac539007e57a57c8c7f8c3bd830ca2604189885959e22e"
    );
  });

  it("nhân đôi cả assets lẫn shares (giữ giá share), đúng word thật của market", () => {
    const assets = 0x0d17232384e7n;
    const shares = 0xba8e68fa79a45cc3n;
    expect(doubleSupplyWord(STORAGE_WORD)).toBe(
      "0x" + ((shares * 2n) << 128n | (assets * 2n)).toString(16).padStart(64, "0")
    );
  });

  it("saturate ở uint128 max thay vì tràn", () => {
    const max = (1n << 128n) - 1n;
    expect(doubleSupplyWord("0x" + max.toString(16).padStart(64, "0"))).toBe(
      "0x" + max.toString(16).padStart(64, "0")
    );
  });

  it("merge override của ví (balance, account khác) thay vì thay thế", () => {
    const slotKey = marketStorageKey(MARKET_ID);
    const merged = mergeLiquidityOverride(
      [
        { to: MORPHO, data: withdrawCalldata() },
        "latest",
        { [MORPHO.toLowerCase()]: { balance: "0x1" }, [OTHER_ACCOUNT]: { stateDiff: { "0x01": "0x02" } } },
      ],
      { morphoBlueAddress: MORPHO, slotKey, word: "0x" + "11".repeat(32) }
    );
    expect(merged[1]).toBe("latest");
    expect(merged[2][MORPHO.toLowerCase()].balance).toBe("0x1");
    expect(merged[2][MORPHO.toLowerCase()].stateDiff[slotKey]).toBe("0x" + "11".repeat(32));
    expect(merged[2][OTHER_ACCOUNT]).toEqual({ stateDiff: { "0x01": "0x02" } });
  });
});

describe("proxy-dispatcher — eth_call unlock", () => {
  function makeClient({ onStorage = async () => STORAGE_WORD, revert = LIQUIDITY_REVERT } = {}) {
    const requests = [];
    const client = {
      requests,
      getTransactionCount: async () => 7,
      getBlockNumber: async () => 1n,
      getGasPrice: async () => 1n,
      estimateMaxPriorityFeePerGas: async () => 1n,
      getBlock: async () => ({ number: 1n, hash: "0x" + "ab".repeat(32), baseFeePerGas: 1n }),
      request: async ({ method, params }) => {
        requests.push({ method, params });
        if (method === "eth_getStorageAt") return onStorage();
        if (method === "eth_call") {
          const hasOverride = params?.[2] && Object.keys(params[2]).length > 0;
          if (!hasOverride) {
            const message = revert === PANIC_REVERT
              ? "execution reverted: panic: arithmetic underflow or overflow (0x11)"
              : "execution reverted: insufficient liquidity";
            throw Object.assign(new Error(message), { data: revert });
          }
          return SUCCESS_RESULT;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    return client;
  }

  function makeDispatcher({ client, presignSimUnlock = true, markets = [{ id: MARKET_ID }] } = {}) {
    return createRpcDispatcher({
      markets,
      lenderAddress: LENDER,
      morphoBlueAddress: MORPHO,
      chainId: 1,
      client,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      presignSimUnlock,
    });
  }

  it("revert liquidity của presign withdraw ⇒ gọi lại với override và trả thành công", async () => {
    const client = makeClient();
    const { handleRpc } = makeDispatcher({ client });
    const result = await handleRpc("eth_call", [{ from: LENDER, to: MORPHO, data: withdrawCalldata() }, "latest"]);
    expect(result).toBe(SUCCESS_RESULT);

    const storageCall = client.requests.find((r) => r.method === "eth_getStorageAt");
    expect(storageCall.params).toEqual([MORPHO, marketStorageKey(MARKET_ID), "latest"]);

    const retry = client.requests.filter((r) => r.method === "eth_call")[1];
    expect(retry.params[2][MORPHO].stateDiff[marketStorageKey(MARKET_ID)]).toBe(doubleSupplyWord(STORAGE_WORD));
  });

  it("mô phỏng bọc qua execute(...) cũng được unlock", async () => {
    const client = makeClient();
    const { handleRpc } = makeDispatcher({ client });
    const result = await handleRpc("eth_call", [{ from: LENDER, to: LENDER, data: wrappedCalldata(withdrawCalldata()) }, "latest"]);
    expect(result).toBe(SUCCESS_RESULT);
  });

  it("PRESIGN_SIM_UNLOCK=0 ⇒ không retry, trả đúng revert của chain", async () => {
    const client = makeClient();
    const { handleRpc } = makeDispatcher({ client, presignSimUnlock: false });
    const result = await handleRpc("eth_call", [{ from: LENDER, to: MORPHO, data: withdrawCalldata() }, "latest"]);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/insufficient liquidity/);
    expect(client.requests.filter((r) => r.method === "eth_call")).toHaveLength(1);
    expect(client.requests.some((r) => r.method === "eth_getStorageAt")).toBe(false);
  });

  it("revert KHÔNG phải liquidity (panic) ⇒ trả nguyên lỗi, không retry", async () => {
    const client = makeClient({ revert: PANIC_REVERT });
    const { handleRpc } = makeDispatcher({ client });
    const result = await handleRpc("eth_call", [{ from: LENDER, to: MORPHO, data: withdrawCalldata() }, "latest"]);
    expect(result).toBeInstanceOf(Error);
    expect(client.requests.filter((r) => r.method === "eth_call")).toHaveLength(1);
  });

  it("market ngoài allow-list ⇒ không retry", async () => {
    const client = makeClient();
    const { handleRpc } = makeDispatcher({ client, markets: [{ id: "0x" + "11".repeat(32) }] });
    const result = await handleRpc("eth_call", [{ from: LENDER, to: MORPHO, data: withdrawCalldata() }, "latest"]);
    expect(result).toBeInstanceOf(Error);
    expect(client.requests.filter((r) => r.method === "eth_call")).toHaveLength(1);
  });

  it("đọc storage lỗi ⇒ fail closed về revert gốc", async () => {
    const client = makeClient({ onStorage: async () => { throw new Error("rpc down"); } });
    const { handleRpc } = makeDispatcher({ client });
    const result = await handleRpc("eth_call", [{ from: LENDER, to: MORPHO, data: withdrawCalldata() }, "latest"]);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/insufficient liquidity/);
  });
});

describe("webapp config — cờ presignSimUnlock", () => {
  const base = {
    markets: [{ id: MARKET_ID }],
    lenderAddress: LENDER,
    publicRpcUrls: ["https://ethereum-rpc.publicnode.com"],
    chainId: 1,
    chainName: "Ethereum",
    morphoBlueAddress: MORPHO,
  };

  it("mặc định bật (để ví mô phỏng ký được ngay sau deploy)", () => {
    expect(buildWebappConfig(base).presignSimUnlock).toBe(true);
  });

  it("tắt được tường minh", () => {
    expect(buildWebappConfig({ ...base, presignSimUnlock: false }).presignSimUnlock).toBe(false);
  });
});
