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
import { createFakeApi, createFakeRpc, loadWebapp } from "./helpers/webapp-harness.mjs";

// Một lượt `loadWebapp` mỗi tiến trình: module browser là ESM cache theo URL, nạp lần hai trong cùng
// tiến trình sẽ không evaluate lại (xem webapp-scenario.mjs).
const rpc = createFakeRpc(); // tay cầm RPC giả: ca "RPC báo tip 0" cần đổi phí giữa hai lần gọi
const api = createFakeApi();
const app = await loadWebapp({ rpc, api });
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
    expect(parseGasInput("")).toEqual({ wei: null, error: null }); // ô TRỐNG = chưa thiết lập
    // 0 là GIÁ TRỊ HỢP LỆ (chủ động không tip) — audit 2026-09-26: trước fix nó bị coi là "chưa
    // thiết lập" nên guard chặn ký với thông báo "Vui lòng nhập gas".
    expect(parseGasInput("0")).toEqual({ wei: 0n, error: null });
    expect(parseGasInput("0.0")).toEqual({ wei: 0n, error: null });
    expect(parseGasInput("0,0")).toEqual({ wei: 0n, error: null });
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

  it("ký với maxPriorityFeePerGas = 0 (không tip) — KHÔNG bị chặn, tx mang đúng 0", async () => {
    await primeSigning("50", "0");
    await app.window.signAllTiers();
    const params = lastSendParams();
    expect(params.maxPriorityFeePerGas, "0 phải đi thẳng vào tx").toBe("0x0");
    expect(params.maxFeePerGas).toBe("0xba43b7400"); // 50 Gwei
    expect(app.html("presign-result"), "không được có banner chặn").not.toContain("Vui lòng nhập gas");
  });

  it("autoFillGas gặp RPC báo tip 0: ô hiện \"0\" và VẪN ký được (điểm nhọn cũ đã hết)", async () => {
    rpc.setGas({ priorityFee: "0x0" });
    await app.window.autoFillGas();
    expect(app.value("presign-gas-priority"), "ô phải hiện đúng giá trị RPC trả").toBe("0");
    await app.window.signAllTiers();
    expect(lastSendParams().maxPriorityFeePerGas).toBe("0x0");
    rpc.setGas({ priorityFee: "0x3b9aca00" }); // trả RPC giả về mặc định cho phần còn lại
  });

  it("tip > trần (5 > 1): chặn NGAY với thông báo rõ — không để viem ném TipAboveFeeCapError giữa vòng ký", async () => {
    // Đỏ-trước (audit 2026-09-26, chạy thật trên cây trước fix): cổng cũ chỉ bắt `maxFeePerGas = 0`, còn
    // CẶP phí vô lý thì lọt xuống vòng ký — viem ném `TipAboveFeeCapError`
    // ("maxPriorityFeePerGas cannot be greater than maxFeePerGas") NGAY client-side (không có
    // `eth_sendTransaction` nào): tier chuyển ❌ với thông báo tiếng Anh trong `#progress-text`, KHÔNG
    // banner ở `#presign-result` (banner cũ nằm nguyên), nút Ký vẫn bật ⇒ bấm lại lặp đúng lỗi đó.
    await primeSigning("1", "5");
    expect(app.window.readGasInputs()).toMatch(/lớn hơn maxFeePerGas/);
    expect(app.html("presign-result"), "banner phải nói rõ vì sao không ký").toContain("lớn hơn maxFeePerGas");
    expect(app.env.elements.get("btn-sign-all").disabled, "nút Ký phải khoá khi cặp phí vô lý").toBe(true);
    await app.window.signAllTiers();
    expect(app.takeCalls().some((c) => c.includes("eth_sendTransaction")), "không được chạm ví").toBe(false);
    expect(app.html("presign-result"), "không còn lỗi tiếng Anh của ví").not.toContain("cannot be greater than");
    expect(app.text("progress-text"), "tier không được rơi vào ❌ Lỗi").not.toContain("❌ Lỗi tier");
  });

  it("tip = trần là biên HỢP LỆ (viem chỉ chặn khi tip > trần)", async () => {
    await primeSigning("5", "5");
    expect(app.window.readGasInputs()).toBe(null);
    await app.window.signAllTiers();
    const params = lastSendParams();
    expect(params.maxFeePerGas).toBe("0x12a05f200"); // 5 Gwei
    expect(params.maxPriorityFeePerGas).toBe("0x12a05f200");
  });

  it("ô tip TRỐNG vẫn MỞ nút Ký (bấm sẽ được NHẮC nhập gas) — chỉ cặp VÔ LÝ mới khoá nút", async () => {
    // Audit vòng 2 (2026-09-26): bản đầu của cổng cặp phí đòi CẢ hai ô non-null, nên ô tip trống làm
    // nút Ký chết không lời giải thích — trong khi hành vi cũ (bấm ⇒ "Vui lòng nhập gas (hoặc nhấn
    // Tự Động Gas)") là lời nhắc HỮU ÍCH và không có rủi ro nào. Ô TRỐNG = "chưa thiết lập", khác
    // hẳn cặp vô lý (trần 0 / tip > trần) — chỉ cặp vô lý mới khoá nút.
    await primeSigning("50", "");
    expect(app.env.elements.get("btn-sign-all").disabled, "ô trống không phải cặp vô lý").toBe(false);
    await app.window.signAllTiers();
    expect(app.takeCalls().some((c) => c.includes("eth_sendTransaction")), "không được ký khi thiếu gas").toBe(false);
    expect(app.html("presign-result")).toContain("Vui lòng nhập gas");
  });

  it("maxFeePerGas = 0 bị CHẶN với thông báo riêng — trần phí 0 thì tx không bao giờ vào bảng", async () => {
    await primeSigning("0", "1");
    expect(app.window.readGasInputs()).toMatch(/không bao giờ vào bảng/);
    await app.window.signAllTiers();
    expect(app.takeCalls().some((c) => c.includes("eth_sendTransaction"))).toBe(false);
    expect(app.html("presign-result")).toContain("maxFeePerGas = 0");
  });
});
