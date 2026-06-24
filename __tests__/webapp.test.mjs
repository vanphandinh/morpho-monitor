/**
 * Unit tests for pure computation logic from webapp.html.
 *
 * These functions mirror the browser code in webapp.html <script type="module">.
 * They're duplicated here for unit testing since browser ESM can't be
 * directly imported by vitest (Node.js).
 *
 * When editing webapp.html logic, update both the HTML and this test file.
 */
import { describe, it, expect } from "vitest";

// ============================================================
// Mirror of webapp.html pure functions
// ============================================================

/**
 * Format a WAD-scaled value (1e18) as a percentage string.
 * Mirrors webapp.html line 345-347.
 */
function wadToPercent(wad) {
  return (Number(wad) / 1e16).toFixed(2) + "%";
}

/**
 * Shorten an Ethereum address for display.
 * Mirrors webapp.html line 349-351.
 */
function shortenAddr(addr) {
  if (!addr) return "N/A";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Compute supply assets from shares.
 * Mirrors webapp.html line 454-456.
 *
 * assets = (shares * totalSupplyAssets) / totalSupplyShares
 */
function computeSupplyAssets(shares, totalSupplyAssets, totalSupplyShares) {
  if (totalSupplyShares === 0n) return 0n;
  return (shares * totalSupplyAssets) / totalSupplyShares;
}

/**
 * Compute borrow assets from shares.
 * Mirrors webapp.html line 507-509.
 */
function computeBorrowAssets(shares, totalBorrowAssets, totalBorrowShares) {
  if (totalBorrowShares === 0n) return 0n;
  return (shares * totalBorrowAssets) / totalBorrowShares;
}

/**
 * Compute market liquidity.
 * Mirrors webapp.html line 458-460.
 */
function computeLiquidity(totalSupplyAssets, totalBorrowAssets) {
  const liquidity = totalSupplyAssets - totalBorrowAssets;
  return liquidity < 0n ? 0n : liquidity;
}

/**
 * Compute utilization (WAD-scaled).
 * Mirrors webapp.html line 463-465.
 */
function computeUtilization(totalBorrowAssets, totalSupplyAssets) {
  if (totalSupplyAssets === 0n) return 0n;
  return (totalBorrowAssets * BigInt(1e18)) / totalSupplyAssets;
}

/**
 * Compute the max withdrawable amount.
 * MAX = min(supplyAssets, liquidity)
 * Mirrors the MAX button logic in webapp.html.
 */
function computeMaxWithdraw(supplyAssets, liquidity) {
  return supplyAssets < liquidity ? supplyAssets : liquidity;
}

/**
 * Validate withdraw input (client-side check before on-chain tx).
 * Mirrors the validation logic added to webapp.html withdrawAmount().
 *
 * Returns { valid: boolean, error: string | null }
 */
function validateWithdraw({ assets, supplyAssets, liquidity }) {
  if (assets === 0n) {
    return { valid: false, error: "Số lượng rút không thể bằng 0." };
  }
  if (assets > supplyAssets) {
    return { valid: false, error: "Số lượng vượt quá số dư có thể rút." };
  }
  if (assets > liquidity) {
    return { valid: false, error: "Thanh khoản market không đủ." };
  }
  return { valid: true, error: null };
}

// ============================================================
// Tests: wadToPercent
// ============================================================
describe("webapp: wadToPercent()", () => {
  it("100% WAD = 100.00%", () => {
    expect(wadToPercent(1_000_000_000_000_000_000n)).toBe("100.00%");
  });

  it("50% WAD = 50.00%", () => {
    expect(wadToPercent(500_000_000_000_000_000n)).toBe("50.00%");
  });

  it("0 WAD = 0.00%", () => {
    expect(wadToPercent(0n)).toBe("0.00%");
  });

  it("LLTV 86% = 86.00%", () => {
    expect(wadToPercent(860_000_000_000_000_000n)).toBe("86.00%");
  });
});

// ============================================================
// Tests: shortenAddr
// ============================================================
describe("webapp: shortenAddr()", () => {
  it("shortens Morhpo Blue address", () => {
    const mb = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
    expect(shortenAddr(mb)).toBe("0xBBBB...FFCb");
  });

  it("shortens user address", () => {
    const addr = "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3";
    expect(shortenAddr(addr)).toBe("0x0A5e...66c3");
  });

  it("returns N/A for null", () => {
    expect(shortenAddr(null)).toBe("N/A");
  });

  it("returns N/A for empty string", () => {
    expect(shortenAddr("")).toBe("N/A");
  });
});

// ============================================================
// Tests: computeSupplyAssets
// ============================================================
describe("webapp: computeSupplyAssets()", () => {
  it("computes supply assets from shares", () => {
    // User has 50 shares out of 1000 total, pool has 2000 USDC
    const result = computeSupplyAssets(50n, 2000_000000n, 1000n);
    // (50 * 2000000000) / 1000 = 100000000 = 100 USDC
    expect(result).toBe(100_000000n);
  });

  it("returns 0 when totalSupplyShares is 0", () => {
    const result = computeSupplyAssets(100n, 1000_000000n, 0n);
    expect(result).toBe(0n);
  });

  it("returns 0 when user has no shares", () => {
    const result = computeSupplyAssets(0n, 1000_000000n, 1000n);
    expect(result).toBe(0n);
  });

  it("handles exact integer division (no fractional shares)", () => {
    // 1 share = 1 USDC
    const result = computeSupplyAssets(500n, 1000_000000n, 1000n);
    expect(result).toBe(500_000000n);
  });

  it("truncates in integer division (Solidity behavior)", () => {
    // 1 share out of 3 total, pool has 10 USDC → 10/3 = 3 (truncated)
    const result = computeSupplyAssets(1n, 10_000000n, 3n);
    expect(result).toBe(3_333333n); // floor(10/3) * 1e6
  });
});

// ============================================================
// Tests: computeBorrowAssets
// ============================================================
describe("webapp: computeBorrowAssets()", () => {
  it("computes borrow assets from shares", () => {
    const result = computeBorrowAssets(10n, 5000_000000n, 100n);
    expect(result).toBe(500_000000n);
  });

  it("returns 0 when totalBorrowShares is 0", () => {
    const result = computeBorrowAssets(10n, 5000_000000n, 0n);
    expect(result).toBe(0n);
  });
});

// ============================================================
// Tests: computeLiquidity
// ============================================================
describe("webapp: computeLiquidity()", () => {
  it("supply > borrow → positive liquidity", () => {
    const liq = computeLiquidity(10000_000000n, 7000_000000n);
    expect(liq).toBe(3000_000000n);
  });

  it("supply == borrow → zero liquidity", () => {
    const liq = computeLiquidity(5000_000000n, 5000_000000n);
    expect(liq).toBe(0n);
  });

  it("supply < borrow → clamped to 0 (shouldn't happen, but safe)", () => {
    const liq = computeLiquidity(1000_000000n, 2000_000000n);
    expect(liq).toBe(0n);
  });
});

// ============================================================
// Tests: computeUtilization
// ============================================================
describe("webapp: computeUtilization()", () => {
  it("70% utilization (WAD)", () => {
    const util = computeUtilization(7000_000000n, 10000_000000n);
    expect(util).toBe(700_000_000_000_000_000n); // 0.7 WAD
  });

  it("100% utilization", () => {
    const util = computeUtilization(5000_000000n, 5000_000000n);
    expect(util).toBe(BigInt(1e18));
  });

  it("0% utilization when no supply", () => {
    const util = computeUtilization(0n, 0n);
    expect(util).toBe(0n);
  });
});

// ============================================================
// Tests: computeMaxWithdraw
// ============================================================
describe("webapp: computeMaxWithdraw() (MAX = min(supplyAssets, liquidity))", () => {
  it("liquidity > supply → max = supply (rút toàn bộ vị thế)", () => {
    const max = computeMaxWithdraw(1000_000000n, 5000_000000n);
    expect(max).toBe(1000_000000n);
  });

  it("liquidity < supply → max = liquidity (bị giới hạn bởi thanh khoản)", () => {
    const max = computeMaxWithdraw(1000_000000n, 300_000000n);
    expect(max).toBe(300_000000n);
  });

  it("liquidity == supply → max = supply", () => {
    const max = computeMaxWithdraw(500_000000n, 500_000000n);
    expect(max).toBe(500_000000n);
  });

  it("liquidity == 0 → max = 0 (không rút được gì)", () => {
    const max = computeMaxWithdraw(1000_000000n, 0n);
    expect(max).toBe(0n);
  });

  it("supply == 0 → max = 0 (không có vị thế)", () => {
    const max = computeMaxWithdraw(0n, 5000_000000n);
    expect(max).toBe(0n);
  });
});

// ============================================================
// Tests: validateWithdraw (input validation)
// ============================================================
describe("webapp: validateWithdraw()", () => {
  const supply = 1000_000000n;  // 1000 USDC
  const liquidity = 500_000000n; // 500 USDC available

  it("passes valid withdrawal (assets ≤ supply and ≤ liquidity)", () => {
    const result = validateWithdraw({
      assets: 300_000000n,
      supplyAssets: supply,
      liquidity,
    });
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  it("rejects zero amount", () => {
    const result = validateWithdraw({
      assets: 0n,
      supplyAssets: supply,
      liquidity,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("0");
  });

  it("rejects amount exceeding supply assets", () => {
    const result = validateWithdraw({
      assets: supply + 1n,
      supplyAssets: supply,
      liquidity,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("số dư");
  });

  it("rejects amount exceeding liquidity", () => {
    const result = validateWithdraw({
      assets: liquidity + 1n,
      supplyAssets: supply,
      liquidity,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Thanh khoản");
  });

  it("rejects when both supply and liquidity exceeded", () => {
    // asset > both: supply check fires first
    const result = validateWithdraw({
      assets: supply + 1n,
      supplyAssets: supply,
      liquidity: 1_000000n,
    });
    expect(result.valid).toBe(false);
  });

  it("allows exact max (assets == supplyAssets == liquidity)", () => {
    const result = validateWithdraw({
      assets: 500_000000n,
      supplyAssets: 500_000000n,
      liquidity: 500_000000n,
    });
    expect(result.valid).toBe(true);
  });
});
