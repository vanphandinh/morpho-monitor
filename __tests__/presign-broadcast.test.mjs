/**
 * Tier selection of the PRODUCTION selector (presigned-broadcast.mjs).
 * Bản cũ copy selectBestPresignedTx từ monitor v1 — đã thay bằng import
 * selectBestWithdrawal: all-shares chỉ được chọn khi giá trị assets ước tính
 * nằm trong liquidity; tier fixed lớn nhất ≤ liquidity được ưu tiên.
 */
import { describe, it, expect } from "vitest";
import { selectBestWithdrawal } from "../presigned-broadcast.mjs";

const snapshotFor = (liquidity, totalSupplyAssets = 100n, totalSupplyShares = 100n) => ({
  market: { liquidity, totalSupplyAssets, totalSupplyShares },
});

describe("selectBestWithdrawal (production)", () => {
  const fixed = (amountWei, label) => ({ amountWei: String(amountWei), amountFormatted: `${Number(amountWei) / 1e6} USDC`, label, signedTx: "0xdeadbeef" });
  const allShares = (sharesWei, label = "all") => ({ type: "all-shares", sharesWei: String(sharesWei), amountFormatted: "", label, signedTx: "0xdeadbeef" });

  it("chọn tier lớn nhất ≤ liquidity khi có nhiều tier phù hợp", () => {
    const withdrawals = [fixed(50n, "50k"), fixed(100n, "100k"), fixed(150n, "150k"), fixed(200n, "200k")];
    expect(selectBestWithdrawal(withdrawals, snapshotFor(175n)).label).toBe("150k");
  });

  it("chọn tier lớn nhất ≤ liquidity khi liquidity rất lớn", () => {
    const withdrawals = [fixed(50n, "50k"), fixed(100n, "100k"), fixed(150n, "150k")];
    expect(selectBestWithdrawal(withdrawals, snapshotFor(1000n)).label).toBe("150k");
  });

  it("chọn tier nhỏ nhất khi tất cả đều > liquidity ngoại trừ tier nhỏ nhất", () => {
    const withdrawals = [fixed(50n, "50k"), fixed(100n, "100k")];
    expect(selectBestWithdrawal(withdrawals, snapshotFor(60n)).label).toBe("50k");
  });

  it("trả về null khi không có tier nào ≤ liquidity", () => {
    const withdrawals = [fixed(100n, "100k"), fixed(200n, "200k")];
    expect(selectBestWithdrawal(withdrawals, snapshotFor(50n))).toBeNull();
  });

  it("bỏ qua tier có amountWei = 0 hoặc âm", () => {
    const withdrawals = [fixed(0n, "zero"), { amountWei: "-5", label: "neg", signedTx: "0x1" }, fixed(30n, "ok")];
    expect(selectBestWithdrawal(withdrawals, snapshotFor(100n)).label).toBe("ok");
  });

  it("chọn all-shares khi giá trị assets ước tính nằm trong liquidity", () => {
    // shares=50/100 totalSupplyShares × 200 totalSupplyAssets = 100 ≤ 100 liquidity
    const withdrawals = [allShares(50n), fixed(90n, "90")];
    expect(selectBestWithdrawal(withdrawals, snapshotFor(100n, 200n, 100n)).label).toBe("all");
  });

  it("loại all-shares khi giá trị assets ước tính vượt liquidity — fallback fixed", () => {
    // shares=200/100 × 200 = 400 > 100 liquidity → chọn fixed 90
    const withdrawals = [allShares(200n), fixed(90n, "90")];
    expect(selectBestWithdrawal(withdrawals, snapshotFor(100n, 200n, 100n)).label).toBe("90");
  });

  it("loại all-shares khi totalSupplyShares = 0 (market rỗng)", () => {
    const withdrawals = [allShares(50n), fixed(40n, "40")];
    expect(selectBestWithdrawal(withdrawals, snapshotFor(100n, 0n, 0n)).label).toBe("40");
  });
});
