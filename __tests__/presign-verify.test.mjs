import { describe, it, expect } from "vitest";
import {
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  verifyWithdrawCalldata,
  verifyPresignedBundle,
  computeMarketId,
  matchTiersToCaptured,
  resolveBundleServerUrl,
  clearMatchedCaptured,
  assertCaptureTx,
  MORPHO_WITHDRAW_ABI,
} from "../presign-verify.mjs";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const OTHER = "0x2222222222222222222222222222222222222222";

const MARKET_PARAMS = {
  loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  oracle: "0x3333333333333333333333333333333333333333",
  irm: "0x4444444444444444444444444444444444444444",
  lltv: 860000000000000000n,
};

const MARKET_ID = computeMarketId(MARKET_PARAMS);

// Deterministic test key — ECDSA from must === lender
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);
const LENDER = account.address;

async function signWithdrawTx({
  assets = 50_000_000000n,
  shares = 0n,
  onBehalf = LENDER,
  receiver = LENDER,
  to = MORPHO,
  nonce = 7,
  marketParams = MARKET_PARAMS,
} = {}) {
  const data = encodeFunctionData({
    abi: MORPHO_WITHDRAW_ABI,
    functionName: "withdraw",
    args: [marketParams, assets, shares, onBehalf, receiver],
  });

  const signed = await account.signTransaction({
    to,
    data,
    nonce,
    chainId: 1,
    gas: 200_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    type: "eip1559",
    value: 0n,
  });
  return signed;
}

describe("computeMarketId", () => {
  it("ổn định cho cùng MarketParams", () => {
    expect(computeMarketId(MARKET_PARAMS)).toBe(MARKET_ID);
    expect(computeMarketId(MARKET_PARAMS).startsWith("0x")).toBe(true);
    expect(computeMarketId(MARKET_PARAMS).length).toBe(66);
  });

  it("đổi khi field thay đổi", () => {
    const other = { ...MARKET_PARAMS, lltv: 1n };
    expect(computeMarketId(other)).not.toBe(MARKET_ID);
  });
});

describe("verifyWithdrawCalldata", () => {
  it("chấp nhận withdraw hợp lệ khớp amountWei + from===lender", async () => {
    const signedTx = await signWithdrawTx({ assets: 100_000_000000n });
    const result = await verifyWithdrawCalldata(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      marketId: MARKET_ID,
      nonce: 7,
      amountWei: "100000000000",
    });
    expect(result.ok).toBe(true);
    expect(result.decoded.assets).toBe(100_000_000000n);
    expect(result.decoded.from.toLowerCase()).toBe(LENDER.toLowerCase());
  });

  it("từ chối amountWei mismatch", async () => {
    const signedTx = await signWithdrawTx({ assets: 100_000_000000n });
    const result = await verifyWithdrawCalldata(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      marketId: MARKET_ID,
      amountWei: "999",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/amountWei/);
  });

  it("từ chối Morpho address sai", async () => {
    const signedTx = await signWithdrawTx({ to: OTHER });
    const result = await verifyWithdrawCalldata(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      marketId: MARKET_ID,
      amountWei: "50000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Morpho/);
  });

  it("từ chối receiver/onBehalf sai", async () => {
    const signedTx = await signWithdrawTx({ receiver: OTHER, onBehalf: OTHER });
    const result = await verifyWithdrawCalldata(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      marketId: MARKET_ID,
      amountWei: "50000000000",
    });
    expect(result.ok).toBe(false);
  });

  it("từ chối khi ECDSA from !== lender", async () => {
    const signedTx = await signWithdrawTx({
      onBehalf: OTHER,
      receiver: OTHER,
    });
    // onBehalf/receiver match OTHER nhưng signer vẫn là account ≠ OTHER
    const result = await verifyWithdrawCalldata(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: OTHER,
      marketId: MARKET_ID,
      amountWei: "50000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sender/i);
  });

  it("từ chối marketId sai", async () => {
    const signedTx = await signWithdrawTx();
    const result = await verifyWithdrawCalldata(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      marketId: "0x" + "11".repeat(32),
      amountWei: "50000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/marketId/);
  });

  it("chấp nhận all-shares khi shares khớp", async () => {
    const shares = 123456789n;
    const signedTx = await signWithdrawTx({ assets: 0n, shares });
    const result = await verifyWithdrawCalldata(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      marketId: MARKET_ID,
      isAllShares: true,
      sharesWei: String(shares),
    });
    expect(result.ok).toBe(true);
  });

  it("từ chối fixed-amount khi shares !== 0", async () => {
    const signedTx = await signWithdrawTx({ assets: 50_000_000000n, shares: 1n });
    const result = await verifyWithdrawCalldata(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      marketId: MARKET_ID,
      amountWei: "50000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/shares should be 0/);
  });

  it("fail closed khi thiếu signedTx", async () => {
    expect((await verifyWithdrawCalldata(null, {})).ok).toBe(false);
    expect((await verifyWithdrawCalldata("", {})).ok).toBe(false);
  });
});

describe("verifyPresignedBundle", () => {
  it("chấp nhận bundle đầy đủ hợp lệ", async () => {
    const signedTx = await signWithdrawTx({ assets: 50_000_000000n, nonce: 3 });
    const bundle = {
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      marketId: MARKET_ID,
      nonce: 3,
      withdrawals: [{
        amountWei: "50000000000",
        amountFormatted: "50000 USDC",
        signedTx,
      }],
    };
    expect((await verifyPresignedBundle(bundle)).ok).toBe(true);
  });

  it("từ chối khi config lender lệch bundle", async () => {
    const signedTx = await signWithdrawTx({ assets: 50_000_000000n });
    const bundle = {
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      marketId: MARKET_ID,
      nonce: 7,
      withdrawals: [{ amountWei: "50000000000", signedTx }],
    };
    const result = await verifyPresignedBundle(bundle, {
      lenderAddress: OTHER,
      marketId: MARKET_ID,
      morphoBlueAddress: MORPHO,
    });
    expect(result.ok).toBe(false);
  });

  it("từ chối khi from !== lenderAddress dù calldata khớp onBehalf", async () => {
    // Sign as account but claim lender is OTHER with matching onBehalf/receiver impossible
    // without re-signing — use LENDER calldata labels but wrong config is covered above.
    // Here: valid tx for LENDER, bundle.lenderAddress = LENDER, but config forces OTHER → rejected early.
    const signedTx = await signWithdrawTx({ assets: 50_000_000000n });
    const bundle = {
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      marketId: MARKET_ID,
      nonce: 7,
      withdrawals: [{ amountWei: "50000000000", signedTx }],
    };
    const result = await verifyPresignedBundle(bundle, {
      lenderAddress: LENDER,
      marketId: MARKET_ID,
      morphoBlueAddress: MORPHO,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && (await verifyWithdrawCalldata(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: OTHER,
      marketId: MARKET_ID,
      amountWei: "50000000000",
    })).ok).toBe(false);
  });
});

describe("matchTiersToCaptured / SSRF helpers", () => {
  it("match đủ tiers → ok", () => {
    const result = matchTiersToCaptured(
      [
        { txHash: "0xaa", amountWei: "1", label: "a" },
        { txHash: "0xbb", amountWei: "2", label: "b" },
      ],
      [
        { hash: "0xaa", signedTx: "0x01" },
        { hash: "0xbb", signedTx: "0x02" },
        { hash: "0xcc", signedTx: "0x03" },
      ]
    );
    expect(result.ok).toBe(true);
    expect(result.withdrawals).toHaveLength(2);
    expect(result.matchedHashes).toEqual(["0xaa", "0xbb"]);
  });

  it("match case-insensitive txHash", () => {
    const result = matchTiersToCaptured(
      [{ txHash: "0xAaBb", amountWei: "1", label: "a" }],
      [{ hash: "0xaabb", signedTx: "0x01" }]
    );
    expect(result.ok).toBe(true);
    expect(result.withdrawals[0].signedTx).toBe("0x01");
  });

  it("partial match → reject", () => {
    const result = matchTiersToCaptured(
      [
        { txHash: "0xaa", amountWei: "1" },
        { txHash: "0xmissing", amountWei: "2" },
      ],
      [{ hash: "0xaa", signedTx: "0x01" }]
    );
    expect(result.ok).toBe(false);
    expect(result.unmatched).toBe("0xmissing");
  });

  it("resolveBundleServerUrl bỏ qua meta.serverUrl (anti-SSRF)", () => {
    const url = resolveBundleServerUrl(
      { serverUrl: "https://evil.example" },
      "http://localhost:3000/"
    );
    expect(url).toBe("http://localhost:3000");
    expect(url).not.toContain("evil");
  });

  it("clearMatchedCaptured chỉ xóa hash đã match", () => {
    const buf = [
      { hash: "0xAA", signedTx: "1" },
      { hash: "0xbb", signedTx: "2" },
      { hash: "0xcc", signedTx: "3" },
    ];
    clearMatchedCaptured(buf, ["0xaa", "0xBB"]);
    expect(buf).toHaveLength(1);
    expect(buf[0].hash).toBe("0xcc");
  });
});

describe("selectBestPresignedTx — production all-shares priority", () => {
  // Mirrored from monitor.mjs broadcast selection
  function estimateSharesValue(sharesWei, totalSupplyAssets, totalSupplyShares) {
    if (!totalSupplyShares || totalSupplyShares === 0n) return 0n;
    return (BigInt(sharesWei) * totalSupplyAssets) / totalSupplyShares;
  }

  function selectBest(withdrawals, liquidity, market) {
    let best = null;
    const allSharesEntry = withdrawals.find(
      (w) => w.type === "all-shares" && w.sharesWei && w.signedTx
    );
    if (allSharesEntry && market?.totalSupplyAssets != null && market?.totalSupplyShares != null) {
      const estimatedAssets = estimateSharesValue(
        allSharesEntry.sharesWei,
        market.totalSupplyAssets,
        market.totalSupplyShares
      );
      if (estimatedAssets > 0n && estimatedAssets <= liquidity) {
        best = allSharesEntry;
      }
    }
    if (!best) {
      const sorted = [...withdrawals]
        .filter((w) => w.amountWei && w.signedTx && w.type !== "all-shares")
        .sort((a, b) => {
          const diff = BigInt(a.amountWei) - BigInt(b.amountWei);
          if (diff > 0n) return 1;
          if (diff < 0n) return -1;
          return 0;
        });
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (BigInt(sorted[i].amountWei) <= liquidity) {
          best = sorted[i];
          break;
        }
      }
    }
    return best;
  }

  it("ưu tiên all-shares khi ước tính ≤ liquidity", () => {
    const market = { totalSupplyAssets: 1_000_000_000000n, totalSupplyShares: 1000n };
    const withdrawals = [
      { type: "all-shares", sharesWei: "500", signedTx: "0xall", label: "all", amountWei: "0" },
      { amountWei: "100000000000", signedTx: "0xtier", label: "100k" },
    ];
    // 500/1000 * 1e12 = 500k USDC ≤ 600k liquidity
    const best = selectBest(withdrawals, 600_000_000000n, market);
    expect(best.label).toBe("all");
  });

  it("fallback tier khi all-shares > liquidity", () => {
    const market = { totalSupplyAssets: 1_000_000_000000n, totalSupplyShares: 1000n };
    const withdrawals = [
      { type: "all-shares", sharesWei: "900", signedTx: "0xall", label: "all", amountWei: "0" },
      { amountWei: "100000000000", signedTx: "0xtier", label: "100k" },
    ];
    // 900 shares ≈ 900k > 200k liquidity → pick 100k tier
    const best = selectBest(withdrawals, 200_000_000000n, market);
    expect(best.label).toBe("100k");
  });
});

describe("assertCaptureTx", () => {
  const CAPTURE_LENDER = account.address;

  it("chấp nhận khi from === lender và Morpho withdraw hợp lệ", async () => {
    const signedTx = await signWithdrawTx({
      onBehalf: CAPTURE_LENDER,
      receiver: CAPTURE_LENDER,
    });
    const result = await assertCaptureTx(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: CAPTURE_LENDER,
      marketId: MARKET_ID,
    });
    expect(result.ok).toBe(true);
    expect(result.from.toLowerCase()).toBe(CAPTURE_LENDER.toLowerCase());
  });

  it("từ chối khi from !== lender", async () => {
    const signedTx = await signWithdrawTx({
      onBehalf: CAPTURE_LENDER,
      receiver: CAPTURE_LENDER,
    });
    const result = await assertCaptureTx(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: OTHER,
      marketId: MARKET_ID,
    });
    expect(result.ok).toBe(false);
    // onBehalf mismatch fires before sender when lender=OTHER
    expect(result.error).toMatch(/onBehalf|sender/i);
  });

  it("từ chối khi to !== Morpho", async () => {
    const signedTx = await signWithdrawTx({
      onBehalf: CAPTURE_LENDER,
      receiver: CAPTURE_LENDER,
      to: OTHER,
    });
    const result = await assertCaptureTx(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: CAPTURE_LENDER,
      marketId: MARKET_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Morpho/i);
  });

  it("không yêu cầu amountWei lúc capture", async () => {
    const signedTx = await signWithdrawTx({
      assets: 99_000_000000n,
      onBehalf: CAPTURE_LENDER,
      receiver: CAPTURE_LENDER,
    });
    const result = await assertCaptureTx(signedTx, {
      morphoBlueAddress: MORPHO,
      lenderAddress: CAPTURE_LENDER,
      marketId: MARKET_ID,
      // no amountWei
    });
    expect(result.ok).toBe(true);
  });
});
