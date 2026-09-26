/**
 * Bug (2026-09-26): ô gas Gwei với số nhỏ hàng thập phân — `maxPriorityFeePerGas = 0,00000026` — bị lỗi.
 *
 * Đỏ-trước (đã chạy trên cây trước fix, qua chính harness này):
 *   A) readGasInputs()    → InvalidDecimalNumberError: Number `2.6e-7` is not a valid decimal number.
 *   B) onGasInputChange() → InvalidDecimalNumberError: Number `2.6e-7` is not a valid decimal number.
 *   C) "0,00000026" (phẩy VN) → parseFloat = 0 ⇒ ô coi như rỗng, nút Ký disabled, KHÔNG banner.
 *
 * Test lái module production qua harness thật (không stub hàm nội bộ) và khẳng định artifact cuối
 * cùng — tham số `eth_sendTransaction` mà ví nhận được.
 */
import { describe, it, expect, afterAll } from "vitest";
import { loadWebapp } from "./helpers/webapp-harness.mjs";

// Một lượt `loadWebapp` mỗi tiến trình: module browser là ESM cache theo URL, nạp lần hai trong cùng
// tiến trình sẽ không evaluate lại (xem webapp-scenario.mjs).
const app = await loadWebapp();
const { parseGasInput } = await import("../webapp-presign.mjs");

afterAll(() => app.restore());

/** Nạp đủ điều kiện để bấm "Ký Tất Cả": ví, phiên, nonce, 1 mốc, gas. */
async function primeSigning(gasMaxFee, gasPriority) {
  await app.window.connectWallet();
  await app.window.signIn();
  await app.window.fetchNonce();
  app.window.addPresetTier("100");
  app.setValue("presign-gas-maxfee", gasMaxFee);
  app.setValue("presign-gas-priority", gasPriority);
  app.window.onGasInputChange();
}

/** Tham số tx đã gửi cho ví kể từ lần lấy trước (buffer được xoá khi lấy). */
function lastSendParams() {
  const call = app.takeCalls().find((c) => c.includes("eth_sendTransaction"));
  expect(call, "ví không nhận được eth_sendTransaction nào").toBeTruthy();
  return JSON.parse(call).params[0];
}

describe("gas số nhỏ hàng thập phân (bug 4)", () => {
  it("parseGasInput: 0.00000026 và 0,00000026 → 260 wei; số mũ/quá 9 chữ số ⇒ lỗi rõ ràng", () => {
    expect(parseGasInput("0.00000026").wei).toBe(260n);
    expect(parseGasInput("0,00000026").wei).toBe(260n);
    expect(parseGasInput(" 0.00000026 ").wei).toBe(260n);
    expect(parseGasInput("50").wei).toBe(50_000_000_000n);
    // Dạng thiếu số 0 đầu/cuối (`.5`, `,5`, `50.`) — `parseFloat` bản cũ chấp nhận cả ba, nên bản
    // mới cũng phải đi cùng một đường với `0.5`/`50.0` (audit D15–D20, 2026-09-26).
    expect(parseGasInput(".5").wei).toBe(500_000_000n);
    expect(parseGasInput(",5").wei).toBe(500_000_000n);
    expect(parseGasInput("50.").wei).toBe(50_000_000_000n);
    expect(parseGasInput("1e-7").error).toMatch(/không phải số Gwei hợp lệ/);
    expect(parseGasInput("0.0000000001").error).toMatch(/quá 9 chữ số thập phân/);
    expect(parseGasInput("")).toEqual({ wei: null, error: null });
    expect(parseGasInput("0")).toEqual({ wei: null, error: null });
  });

  it("ký với maxPriorityFeePerGas = 0.00000026 (260 wei) — không ném, tx mang đúng phí", async () => {
    await primeSigning("50", "0.00000026");
    await app.window.signAllTiers();
    const params = lastSendParams();
    expect(params.maxPriorityFeePerGas).toBe("0x104"); // 260 wei
    expect(params.maxFeePerGas).toBe("0xba43b7400"); // 50 Gwei
  });

  it("dấu phẩy thập phân kiểu VN (0,00000026) được chấp nhận như dấu chấm", async () => {
    await primeSigning("50", "0,00000026");
    await app.window.signAllTiers();
    expect(lastSendParams().maxPriorityFeePerGas).toBe("0x104");
  });

  it("ô gas không hợp lệ: KHÔNG ký, báo rõ, không ném ra ngoài handler", async () => {
    await primeSigning("50", "1e-7");
    expect(() => app.window.onGasInputChange()).not.toThrow();
    await app.window.signAllTiers();
    expect(app.takeCalls().some((c) => c.includes("eth_sendTransaction"))).toBe(false);
    expect(app.html("presign-result")).toContain("Gas không hợp lệ");
  });
});
