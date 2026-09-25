/**
 * market-reader.mjs — module lõi của multi-market monitor (audit P0.3).
 *
 * Hợp đồng ghim:
 * 1. Nhiều market ⇒ MỘT `eth_blockNumber` + MỘT `multicall`, và mọi market đọc ở
 *    CÙNG `blockNumber` (quyết định thiết kế trung tâm của plan: "same-block
 *    state"). Snapshot mang `blockNumber` để caller không lệch góc nhìn.
 * 2. `allowFailure` cô lập market lỗi: market hỏng vào `failures`, các market còn
 *    lại vẫn có snapshot — một market revert không được giết cả chu kỳ.
 * 3. Market id không tồn tại on-chain (params toàn zero) ⇒ reject
 *    `MARKET_PARAMS_ZERO` kèm id, KHÔNG đọc RPC đầu tiên (fail fast lúc khởi động).
 * 4. Metadata token được cache theo địa chỉ (không fetch lặp giữa các market).
 */
import { describe, it, expect, vi } from "vitest";
import { createMarketReader, MARKET_PARAMS_ZERO } from "../market-reader.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const MARKET_A = "0x" + "a".repeat(64);
const MARKET_B = "0x" + "b".repeat(64);
const LENDER = "0x" + "1".repeat(40);
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const params = (loan = "0x" + "c".repeat(40), collateral = "0x" + "d".repeat(40)) => ({
  loanToken: loan,
  collateralToken: collateral,
  oracle: "0x" + "e".repeat(40),
  irm: "0x" + "f".repeat(40),
  lltv: 860_000_000_000_000_000n,
});

const token = (symbol, decimals) => ({ symbol, decimals });

const marketResult = (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares = 0n) => ({
  status: "success",
  result: [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, 1_000_000n, 0n],
});
const positionResult = (supplyShares, borrowShares = 0n, collateral = 0n) => ({
  status: "success",
  result: [supplyShares, borrowShares, collateral],
});

function fakeClient({ results = [], blockNumber = 77n, onMulticall } = {}) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(blockNumber),
    multicall: vi.fn(async (args) => {
      onMulticall?.(args);
      return results;
    }),
  };
}

const markets = () => [
  { id: MARKET_A, minLiquidity: "1", suddenDrainMultiplier: 2 },
  { id: MARKET_B, minLiquidity: "2", suddenDrainMultiplier: 3 },
];

const reader = (client, overrides = {}) =>
  createMarketReader({
    client,
    lenderAddress: LENDER,
    morphoBlueAddress: MORPHO,
    markets: markets(),
    fetchParams: async () => params(),
    fetchTokenById: async () => token("USDC", 6),
    ...overrides,
  });

describe("market-reader — same-block multicall", () => {
  it("2 market ⇒ 1 getBlockNumber + 1 multicall, cùng blockNumber, đủ 4 contract", async () => {
    const calls = [];
    const client = fakeClient({
      blockNumber: 77n,
      results: [
        marketResult(1_000_000_000n, 1_000_000_000n, 200_000_000n),
        positionResult(500n),
        marketResult(2_000_000_000n, 2_000_000_000n, 100_000_000n),
        positionResult(100n),
      ],
      onMulticall: (args) => calls.push(args),
    });
    const r = await reader(client);
    const { blockNumber, snapshots, failures } = await r.readSnapshots();

    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(client.multicall).toHaveBeenCalledTimes(1);
    expect(calls[0].blockNumber).toBe(77n);
    expect(calls[0].contracts).toHaveLength(4);
    expect(calls[0].allowFailure).toBe(true);
    expect(snapshots.size).toBe(2);
    expect(failures.size).toBe(0);
    expect(blockNumber).toBe(77n);
    for (const snapshot of snapshots.values()) {
      expect(snapshot.blockNumber).toBe(77n);
      expect(snapshot.market.liquidity).toBe(snapshot.market.totalSupplyAssets - snapshot.market.totalBorrowAssets);
      expect(snapshot.minLiquidityWei).toBe(snapshot.id === MARKET_A ? 1_000_000n : 2_000_000n);
    }
  });

  it("allowFailure: market lỗi vào failures, market còn lại vẫn có snapshot", async () => {
    const client = fakeClient({
      results: [
        { status: "failure", error: new Error("execution reverted") },
        positionResult(1n),
        marketResult(5_000_000n, 5_000_000n, 1_000_000n),
        positionResult(2n),
      ],
    });
    const r = await reader(client);
    const { snapshots, failures } = await r.readSnapshots();

    expect(failures.size).toBe(1);
    expect(failures.get(MARKET_A).message).toBe("execution reverted");
    expect(snapshots.size).toBe(1);
    expect(snapshots.has(MARKET_B)).toBe(true);
  });

  it("readSnapshots([]) ⇒ blockNumber null và KHÔNG gọi RPC nào", async () => {
    const client = fakeClient();
    const r = await reader(client);
    const result = await r.readSnapshots([]);
    expect(result.blockNumber).toBeNull();
    expect(result.snapshots.size).toBe(0);
    expect(result.failures.size).toBe(0);
    expect(client.getBlockNumber).not.toHaveBeenCalled();
    expect(client.multicall).not.toHaveBeenCalled();
  });
});

describe("market-reader — fail fast khi market id sai (P0.3)", () => {
  it("params toàn zero ⇒ reject MARKET_PARAMS_ZERO kèm id, không đọc RPC", async () => {
    const client = fakeClient();
    const err = await reader(client, { fetchParams: async () => params(ZERO, ZERO) }).catch((e) => e);

    expect(err.code).toBe(MARKET_PARAMS_ZERO);
    expect(err.marketId).toBe(MARKET_A);
    expect(err.message).toContain(MARKET_A);
    expect(err.message).toMatch(/markets\.json/);
    expect(client.getBlockNumber).not.toHaveBeenCalled();
  });

  it("params rỗng/undefined cũng fail fast (không tạo runtime rỗng)", async () => {
    const client = fakeClient();
    const err = await reader(client, { fetchParams: async () => undefined }).catch((e) => e);
    expect(err.code).toBe(MARKET_PARAMS_ZERO);
  });

  // Audit vòng 5: throw-ngay bắt người vận hành sửa MỘT id rồi restart mới thấy id
  // sai tiếp theo. Một lần khởi động phải báo đủ danh sách.
  it("nhiều id sai ⇒ MỘT lỗi liệt kê ĐỦ mọi id, không đọc token của id sai", async () => {
    const client = fakeClient();
    const fetchTokenById = vi.fn(async () => token("USDC", 6));
    const err = await reader(client, {
      fetchParams: async () => params(ZERO, ZERO),
      fetchTokenById,
    }).catch((e) => e);

    expect(err.code).toBe(MARKET_PARAMS_ZERO);
    expect(err.marketIds).toEqual([MARKET_A, MARKET_B]);
    expect(err.marketId).toBe(MARKET_A); // back-compat: id đầu tiên
    expect(err.message).toContain(MARKET_A);
    expect(err.message).toContain(MARKET_B);
    expect(err.message).toMatch(/2 market id/);
    expect(fetchTokenById).not.toHaveBeenCalled();
    expect(client.multicall).not.toHaveBeenCalled();
  });

  it("chỉ id SAI bị liệt kê — id đúng không lọt vào thông báo lỗi", async () => {
    const client = fakeClient();
    const err = await reader(client, {
      fetchParams: async (id) => (id === MARKET_B ? params(ZERO, ZERO) : params()),
    }).catch((e) => e);

    expect(err.marketIds).toEqual([MARKET_B]);
    expect(err.marketId).toBe(MARKET_B);
    expect(err.message).not.toContain(MARKET_A);
  });
});

describe("market-reader — cache metadata token", () => {
  it("hai market dùng chung địa chỉ token ⇒ fetchTokenById chỉ gọi 1 lần mỗi địa chỉ", async () => {
    const fetchTokenById = vi.fn(async () => token("USDC", 6));
    const client = fakeClient({
      results: [
        marketResult(1n, 1n, 0n), positionResult(1n),
        marketResult(1n, 1n, 0n), positionResult(1n),
      ],
    });
    await reader(client, { fetchTokenById });
    // loan (0xc…) + collateral (0xd…) — mỗi địa chỉ một lần cho CẢ HAI market.
    expect(fetchTokenById).toHaveBeenCalledTimes(2);
  });
});
