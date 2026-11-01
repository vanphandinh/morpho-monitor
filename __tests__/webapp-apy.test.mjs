/**
 * APY của market đang theo dõi: đối chứng công thức + render thật trên card.
 *
 * Vì sao đối chứng với `@morpho-org/blue-sdk`: `market-reader.mjs` (và VoIP đọc lên loa) lấy
 * APY từ chính `Market#getSupplyApy` của thư viện đó. Nếu webapp tự tính bằng một công thức
 * khác, hai nơi sẽ nói hai con số cho cùng một market và người dùng không biết tin cái nào.
 * Test này ghim "cùng một market ⇒ cùng một APY", không chỉ "có hiện một số".
 */
import { describe, it, expect, afterAll } from "vitest";
import { Market, MarketParams } from "@morpho-org/blue-sdk";
import { computeSupplyApy, computeUtilization, formatApyPercent } from "../webapp-logic.mjs";
import { createFakeApi, createFakeRpc, loadWebapp } from "./helpers/webapp-harness.mjs";

const PARAMS = new MarketParams({
  loanToken: "0x" + "2".repeat(40),
  collateralToken: "0x" + "3".repeat(40),
  oracle: "0x" + "4".repeat(40),
  irm: "0x" + "5".repeat(40),
  lltv: 860000000000000000n,
});

const LAST_UPDATE = 1_700_000_000n;
const NOW = LAST_UPDATE + 86400n * 7n;

/**
 * Các market đại diện cho những hình dạng số thật gặp trên mainnet. `rateAtTarget` cố định để
 * phép so sánh là tất định; `fee` chỉ khác 0 ở một ca để chắc phần trừ phí không bị bỏ quên.
 */
const CASES = [
  { name: "utilization 40%, phí 0", totalSupplyAssets: 1_000_000_000n, totalBorrowAssets: 400_000_000n, fee: 0n, rateAtTarget: 3_170_979_198n },
  { name: "utilization 95% + fee 10%", totalSupplyAssets: 5_000_000_000n, totalBorrowAssets: 4_750_000_000n, fee: 100_000_000_000_000_000n, rateAtTarget: 1_268_391_679n },
  { name: "chưa có ai vay", totalSupplyAssets: 2_000_000_000n, totalBorrowAssets: 0n, fee: 0n, rateAtTarget: 900_000_000n },
  { name: "market bỏ accrual 45 ngày", totalSupplyAssets: 1_000_000_000n, totalBorrowAssets: 950_000_000n, fee: 0n, rateAtTarget: 3_170_979_198n, lastUpdate: LAST_UPDATE - 86400n * 45n },
  { name: "rateAtTarget = 0 (chưa accrual lần nào)", totalSupplyAssets: 1_000_000_000n, totalBorrowAssets: 100_000_000n, fee: 0n, rateAtTarget: 0n },
];

const supplyApyOf = (c, nowSeconds = NOW) => computeSupplyApy({
  utilization: computeUtilization(c.totalBorrowAssets, c.totalSupplyAssets),
  fee: c.fee ?? 0n,
  rateAtTarget: c.rateAtTarget,
  lastUpdate: c.lastUpdate ?? LAST_UPDATE,
  nowSeconds,
});

describe("webapp: computeSupplyApy() khớp blue-sdk (nguồn số của VoIP)", () => {
  for (const c of CASES) {
    it(c.name, () => {
      // `Market#getSupplyApy` là đúng hàm mà market-reader dùng; cùng đầu vào phải ra cùng số.
      const market = new Market({
        params: PARAMS,
        totalSupplyAssets: c.totalSupplyAssets, totalSupplyShares: c.totalSupplyAssets,
        totalBorrowAssets: c.totalBorrowAssets, totalBorrowShares: c.totalBorrowAssets,
        lastUpdate: c.lastUpdate ?? LAST_UPDATE, fee: c.fee ?? 0n, rateAtTarget: c.rateAtTarget,
      });
      expect(supplyApyOf(c)).toBeCloseTo(market.getSupplyApy(NOW), 12);
    });
  }

  it("thiếu rateAtTarget ⇒ null (không bịa 0%)", () => {
    expect(supplyApyOf({ ...CASES[0], rateAtTarget: null })).toBeNull();
  });

  it("đồng hồ máy chậm hơn chain (elapsed âm) ⇒ không ném, dùng elapsed = 0", () => {
    // blue-sdk ném InvalidInterestAccrual khi elapsed < 0; browser thì không được ném giữa render.
    const c = CASES[0];
    const atUpdate = supplyApyOf(c, LAST_UPDATE);
    const beforeUpdate = supplyApyOf(c, LAST_UPDATE - 3600n);
    expect(beforeUpdate).toBeCloseTo(atUpdate, 15);
  });

  it("fee > 0 làm APY thấp hơn fee = 0 trên cùng market", () => {
    const c = CASES[0];
    expect(supplyApyOf({ ...c, fee: 100_000_000_000_000_000n })).toBeLessThan(supplyApyOf(c));
  });

  it("không có supply ⇒ 0, không NaN", () => {
    const apy = supplyApyOf({ totalSupplyAssets: 0n, totalBorrowAssets: 0n, fee: 0n, rateAtTarget: 3_170_979_198n });
    expect(apy).toBe(0);
  });
});

describe("webapp: formatApyPercent()", () => {
  it("hai số lẻ như các phần trăm khác trên card", () => {
    expect(formatApyPercent(0.1483918159415089)).toBe("14.84%");
    expect(formatApyPercent(0)).toBe("0.00%");
  });

  it("APY dương nhưng làm tròn ra 0.00% thì nói '<0.01%'", () => {
    expect(formatApyPercent(0.00001)).toBe("<0.01%");
  });

  it("null/NaN/Infinity ⇒ 'N/A' (rate tối đa của IRM có thể làm expm1 tràn)", () => {
    expect(formatApyPercent(null)).toBe("N/A");
    expect(formatApyPercent(Number.NaN)).toBe("N/A");
    expect(formatApyPercent(Number.POSITIVE_INFINITY)).toBe("N/A");
  });
});

// Render thật: harness trả `rateAtTarget` cố định nên dòng APY phải ra một con số, không "N/A".
const app = await loadWebapp({ rpc: createFakeRpc(), api: createFakeApi() });
afterAll(() => app.restore());

describe("webapp: dòng 'Supply APY' trên card market", () => {
  it("tab Tổng quan hiện một phần trăm thật", () => {
    const html = app.html("market-info");
    expect(html).toContain("Supply APY");
    const value = /Supply APY<\/span><span class="value">([^<]*)</.exec(html)?.[1];
    expect(value).toBeTruthy();
    expect(value).not.toBe("N/A");
    expect(value).toMatch(/^\d+\.\d{2}%$|<0\.01%/);
  });

  it("card ở tab ký sẵn nói cùng con số", () => {
    // So sánh TRỰC TIẾP hai card: chỉ "không phải N/A" thì một card hiện 0.00% còn card kia
    // 14.84% vẫn xanh — đúng loại lệch mà test này sinh ra để bắt.
    const valueOf = (id) => /Supply APY<\/span><span class="value">([^<]*)/.exec(app.html(id))?.[1];
    const overview = valueOf("market-info");
    const presign = valueOf("presign-market-info");
    expect(overview).toBeTruthy();
    expect(presign).toBe(overview);
  });
});
