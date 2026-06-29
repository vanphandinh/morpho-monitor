import { describe, it, expect } from "vitest";

// ============================================================
// Pure function: selectBestPresignedTx
//
// Duplicated từ monitor.mjs để test độc lập (theo convention
// của dự án — xem __tests__/webapp.test.mjs).
// ============================================================

/**
 * Chọn tier lớn nhất có amountWei ≤ liquidity.
 * Trả về tier hoặc null nếu không có tier nào phù hợp.
 *
 * @param {Array<{amountWei: string, amountFormatted: string, label: string}>} withdrawals
 * @param {bigint} liquidity
 * @returns {object|null}
 */
function selectBestPresignedTx(withdrawals, liquidity) {
  const valid = withdrawals.filter((w) => w.amountWei && BigInt(w.amountWei) > 0n);

  if (valid.length === 0) return null;

  // Sort by amountWei ascending
  const sorted = [...valid].sort((a, b) => {
    const diff = BigInt(a.amountWei) - BigInt(b.amountWei);
    if (diff > 0n) return 1;
    if (diff < 0n) return -1;
    return 0;
  });

  // Find largest ≤ liquidity
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (BigInt(sorted[i].amountWei) <= liquidity) {
      return sorted[i];
    }
  }

  return null;
}

/**
 * Validate presigned bundle structure.
 * Returns { valid: boolean, errors: string[] }.
 */
function validatePresignedBundle(bundle) {
  const errors = [];

  if (!bundle || typeof bundle !== "object") {
    errors.push("Bundle must be an object");
    return { valid: false, errors };
  }

  if (!bundle.withdrawals || !Array.isArray(bundle.withdrawals)) {
    errors.push("withdrawals must be an array");
  } else if (bundle.withdrawals.length === 0) {
    errors.push("withdrawals must not be empty");
  } else {
    bundle.withdrawals.forEach((w, i) => {
      if (!w.signedTx) errors.push(`withdrawals[${i}]: missing signedTx`);
      if (w.type === "all-shares") {
        if (!w.sharesWei) errors.push(`withdrawals[${i}]: all-shares entry missing sharesWei`);
      } else {
        if (!w.amountWei) errors.push(`withdrawals[${i}]: missing amountWei`);
      }
      if (!w.amountFormatted) errors.push(`withdrawals[${i}]: missing amountFormatted`);
    });
  }

  if (bundle.status !== "pending" && bundle.status !== "broadcast" && bundle.status !== "expired") {
    errors.push(`Invalid status: ${bundle.status}`);
  }

  if (bundle.chainId !== 1) {
    errors.push(`chainId must be 1, got ${bundle.chainId}`);
  }

  if (!bundle.nonce && bundle.nonce !== 0) {
    errors.push("nonce is required");
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================
// TESTS: selectBestPresignedTx
// ============================================================

describe("selectBestPresignedTx", () => {
  const makeWithdrawal = (amountWei, label) => ({
    amountWei: String(amountWei),
    amountFormatted: `${Number(amountWei) / 1e6} USDC`,
    label: label || `${Number(amountWei) / 1e6} USDC`,
    signedTx: "0xdeadbeef",
  });

  it("chọn tier lớn nhất ≤ liquidity khi có nhiều tier phù hợp", () => {
    const withdrawals = [
      makeWithdrawal(50_000_000000n, "50k"),
      makeWithdrawal(100_000_000000n, "100k"),
      makeWithdrawal(150_000_000000n, "150k"),
      makeWithdrawal(200_000_000000n, "200k"),
    ];
    const result = selectBestPresignedTx(withdrawals, 175_000_000000n);
    expect(result).not.toBeNull();
    expect(result.label).toBe("150k");
  });

  it("chọn tier lớn nhất ≤ liquidity khi liquidity rất lớn", () => {
    const withdrawals = [
      makeWithdrawal(50_000_000000n, "50k"),
      makeWithdrawal(100_000_000000n, "100k"),
      makeWithdrawal(150_000_000000n, "150k"),
    ];
    const result = selectBestPresignedTx(withdrawals, 1_000_000_000000n);
    expect(result).not.toBeNull();
    expect(result.label).toBe("150k");
  });

  it("chọn tier nhỏ nhất khi tất cả đều > liquidity ngoại trừ tier nhỏ nhất", () => {
    const withdrawals = [
      makeWithdrawal(50_000_000000n, "50k"),
      makeWithdrawal(100_000_000000n, "100k"),
      makeWithdrawal(150_000_000000n, "150k"),
    ];
    const result = selectBestPresignedTx(withdrawals, 75_000_000000n);
    expect(result).not.toBeNull();
    expect(result.label).toBe("50k");
  });

  it("trả về null khi tất cả tier đều > liquidity", () => {
    const withdrawals = [
      makeWithdrawal(100_000_000000n, "100k"),
      makeWithdrawal(150_000_000000n, "150k"),
    ];
    const result = selectBestPresignedTx(withdrawals, 50_000_000000n);
    expect(result).toBeNull();
  });

  it("trả về null với mảng rỗng", () => {
    const result = selectBestPresignedTx([], 100_000_000000n);
    expect(result).toBeNull();
  });

  it("trả về null khi tất cả amountWei = 0", () => {
    const withdrawals = [
      { amountWei: "0", amountFormatted: "0 USDC", label: "zero", signedTx: "0x00" },
    ];
    const result = selectBestPresignedTx(withdrawals, 100_000_000000n);
    expect(result).toBeNull();
  });

  it("chọn đúng khi liquidity = chính xác amountWei của 1 tier", () => {
    const withdrawals = [
      makeWithdrawal(50_000_000000n, "50k"),
      makeWithdrawal(100_000_000000n, "100k"),
      makeWithdrawal(150_000_000000n, "150k"),
    ];
    const result = selectBestPresignedTx(withdrawals, 100_000_000000n);
    expect(result).not.toBeNull();
    expect(result.label).toBe("100k");
  });

  it("hoạt động với liquidity = 0n", () => {
    const withdrawals = [
      makeWithdrawal(50_000_000000n, "50k"),
    ];
    const result = selectBestPresignedTx(withdrawals, 0n);
    expect(result).toBeNull();
  });
});

// ============================================================
// TESTS: validatePresignedBundle
// ============================================================

describe("validatePresignedBundle", () => {
  const validBundle = {
    version: 1,
    chainId: 1,
    nonce: 42,
    status: "pending",
    withdrawals: [
      {
        label: "50k USDC",
        amountWei: "50000000000",
        amountFormatted: "50000 USDC",
        signedTx: "0x02f8abcd",
      },
    ],
  };

  it("chấp nhận bundle hợp lệ", () => {
    const result = validatePresignedBundle(validBundle);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("từ chối bundle không có withdrawals", () => {
    const result = validatePresignedBundle({ chainId: 1, nonce: 1, status: "pending" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("withdrawals"))).toBe(true);
  });

  it("từ chối bundle có withdrawals rỗng", () => {
    const result = validatePresignedBundle({
      chainId: 1, nonce: 1, status: "pending", withdrawals: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not be empty"))).toBe(true);
  });

  it("từ chối withdrawal thiếu signedTx", () => {
    const bundle = {
      chainId: 1, nonce: 1, status: "pending",
      withdrawals: [{ amountWei: "100", amountFormatted: "100 USDC" }],
    };
    const result = validatePresignedBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("signedTx"))).toBe(true);
  });

  it("từ chối status không hợp lệ", () => {
    const bundle = { ...validBundle, status: "unknown_status" };
    const result = validatePresignedBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid status"))).toBe(true);
  });

  it("chấp nhận status = 'broadcast'", () => {
    const bundle = { ...validBundle, status: "broadcast" };
    const result = validatePresignedBundle(bundle);
    expect(result.valid).toBe(true);
  });

  it("chấp nhận status = 'expired'", () => {
    const bundle = { ...validBundle, status: "expired" };
    const result = validatePresignedBundle(bundle);
    expect(result.valid).toBe(true);
  });

  it("từ chối chainId != 1", () => {
    const bundle = { ...validBundle, chainId: 137 };
    const result = validatePresignedBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("chainId"))).toBe(true);
  });

  it("từ chối nonce bị thiếu", () => {
    const { nonce, ...noNonce } = validBundle;
    const result = validatePresignedBundle(noNonce);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nonce"))).toBe(true);
  });

  it("chấp nhận nonce = 0", () => {
    const bundle = { ...validBundle, nonce: 0 };
    const result = validatePresignedBundle(bundle);
    expect(result.valid).toBe(true);
  });

  it("chấp nhận all-shares entry hợp lệ", () => {
    const bundle = {
      ...validBundle,
      withdrawals: [{
        type: "all-shares",
        sharesWei: "123456789",
        amountWei: "0",
        amountFormatted: "Toàn bộ shares",
        label: "Rút toàn bộ shares",
        signedTx: "0x02f8abcd",
      }],
    };
    const result = validatePresignedBundle(bundle);
    expect(result.valid).toBe(true);
  });

  it("từ chối all-shares entry thiếu sharesWei", () => {
    const bundle = {
      ...validBundle,
      withdrawals: [{
        type: "all-shares",
        amountWei: "0",
        amountFormatted: "Toàn bộ shares",
        signedTx: "0x02f8abcd",
      }],
    };
    const result = validatePresignedBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("sharesWei"))).toBe(true);
  });

  it("chấp nhận bundle hỗn hợp tier + all-shares", () => {
    const bundle = {
      ...validBundle,
      withdrawals: [
        {
          label: "50k USDC",
          amountWei: "50000000000",
          amountFormatted: "50000 USDC",
          signedTx: "0x02f8abcd",
        },
        {
          type: "all-shares",
          sharesWei: "987654321",
          amountWei: "0",
          amountFormatted: "Toàn bộ shares",
          label: "Rút toàn bộ shares",
          signedTx: "0x02f8ef01",
        },
      ],
    };
    const result = validatePresignedBundle(bundle);
    expect(result.valid).toBe(true);
  });
});

// ============================================================
// TESTS: estimateSharesValue
// ============================================================

describe("estimateSharesValue", () => {
  /**
   * Estimate the current asset value of a shares amount using pool exchange rate.
   * Duplicated từ monitor.mjs để test độc lập.
   */
  function estimateSharesValue(sharesWei, totalSupplyAssets, totalSupplyShares) {
    if (!totalSupplyShares || totalSupplyShares === 0n) return 0n;
    return (BigInt(sharesWei) * totalSupplyAssets) / totalSupplyShares;
  }

  it("tính đúng giá trị assets từ shares", () => {
    // 100 shares out of 1000 total, pool has 500,000 USDC totalSupplyAssets
    const result = estimateSharesValue("100", 500_000_000000n, 1000n);
    expect(result).toBe(50_000_000000n); // 50,000 USDC
  });

  it("tính đúng với số lượng shares lớn", () => {
    // All 1000 shares = 500,000 USDC
    const result = estimateSharesValue("1000", 500_000_000000n, 1000n);
    expect(result).toBe(500_000_000000n);
  });

  it("trả về 0 khi totalSupplyShares = 0", () => {
    const result = estimateSharesValue("100", 500_000_000000n, 0n);
    expect(result).toBe(0n);
  });

  it("trả về 0 khi totalSupplyShares = null/undefined", () => {
    const result = estimateSharesValue("100", 500_000_000000n, null);
    expect(result).toBe(0n);
  });

  it("trả về 0 khi shares = 0", () => {
    const result = estimateSharesValue("0", 500_000_000000n, 1000n);
    expect(result).toBe(0n);
  });

  it("làm tròn xuống (floor) với phép chia không chẵn", () => {
    // 1 share out of 3 total, pool has 10 wei → floor(1*10/3) = 3
    const result = estimateSharesValue("1", 10n, 3n);
    expect(result).toBe(3n);
  });
});
