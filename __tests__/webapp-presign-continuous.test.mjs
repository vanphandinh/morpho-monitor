/**
 * Ký presign LIÊN TỤC — không phải tải lại trang giữa các đợt (2026-11-10).
 *
 * Ghim đúng vòng đời người dùng thật, KHÔNG reload:
 *   1. Ký đợt đầu ở nonce N ⇒ mỗi mốc một giao dịch + toast tự tắt sau ~5 giây.
 *   2. Thêm mốc ở CÙNG nonce rồi Ký ⇒ chỉ mốc mới mở popup ví (mốc ✅ được dùng lại).
 *   3. Lưu ⇒ nút Lưu về nhãn “💾 Lưu Lên Server” (không kẹt “✅ Đã Lưu”), success banner
 *      giữ nguyên markup, toast lưu tự tắt/bấm là tắt.
 *   4. `+` sang nonce N+1 ⇒ ký lại đủ bộ ở nonce mới, GIỮ NGUYÊN gas đã nhập, rồi Lưu được.
 *   5. Ký khi không có gì mới ⇒ 0 popup ví, toast thông báo.
 *   6. Lỗi gas ⇒ banner LỖI như cũ (`#presign-result`), không đụng toast.
 *
 * Timer được điều khiển bằng `vi.useFakeTimers` (chỉ setTimeout/clearTimeout) — không
 * `sleep` thật 5 giây, và không ảnh hưởng promise/fetch của harness.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { createFakeApi, createFakeRpc, loadWebapp } from "./helpers/webapp-harness.mjs";

vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

const api = createFakeApi();
const app = await loadWebapp({ rpc: createFakeRpc(), api });
// Nạp SAU `loadWebapp`: module browser đọc `window.MORPHO_CONFIG` ngay khi evaluate.
const { PRESIGN_TOAST_MS } = await import("../webapp-presign.mjs");

afterAll(() => {
  vi.useRealTimers();
  app.restore();
});

const el = (id) => app.env.elements.get(id);
const toastEl = () => el("presign-toast");

/** Tham số của mọi `eth_sendTransaction` kể từ lần lấy trước (buffer bị xoá khi lấy). */
function sentTxs() {
  return app
    .takeCalls()
    .filter((call) => call.includes("eth_sendTransaction"))
    .map((call) => JSON.parse(call).params[0]);
}

/** Toast đang hiện và chứa đoạn văn bản mong đợi. */
function expectToastShowing(fragment) {
  expect(toastEl().style.display, "toast phải đang hiện").toBe("block");
  expect(app.html("presign-toast")).toContain(fragment);
}

/** Đẩy đồng hồ ảo qua đúng ngưỡng tự tắt. */
function expectToastAutoHides() {
  vi.advanceTimersByTime(PRESIGN_TOAST_MS - 1);
  expect(toastEl().style.display, "chưa đủ ~5 giây thì toast còn hiện").toBe("block");
  vi.advanceTimersByTime(1);
  expect(toastEl().style.display, "hết ~5 giây thì toast tự tắt").toBe("none");
}

async function primeFirstRound() {
  await app.window.connectWallet();
  await app.window.signIn();
  await app.window.fetchNonce();
  app.window.addTier();
  app.window.updateTierAmount(0, "100");
  app.window.addTier();
  app.window.updateTierAmount(1, "250");
  app.setValue("presign-gas-maxfee", "50");
  app.setValue("presign-gas-priority", "1");
  app.window.onGasInputChange();
}

describe("ký presign liên tục (không cần refresh)", () => {
  it("đợt đầu: 2 mốc ⇒ 2 giao dịch ở nonce 11, toast ký tự tắt sau ~5s", async () => {
    await primeFirstRound();
    app.takeCalls();

    await app.window.signAllTiers();

    const sent = sentTxs();
    expect(sent).toHaveLength(2);
    expect(sent.map((tx) => tx.nonce)).toEqual(["0xb", "0xb"]);
    expect(app.html("tier-list").match(/✅/g), "cả hai mốc phải ✅").toHaveLength(2);
    expectToastShowing("Đã ký 2 giao dịch mới");
    expectToastAutoHides();
  });

  it("thêm mốc ở CÙNG nonce: chỉ mốc mới mở popup ví, toast nói rõ số chữ ký dùng lại", async () => {
    app.window.addTier();
    app.window.updateTierAmount(2, "500");
    app.takeCalls();

    await app.window.signAllTiers();

    const sent = sentTxs();
    expect(sent, "chỉ mốc thứ ba được ký lại").toHaveLength(1);
    expect(sent[0].nonce).toBe("0xb");
    expect(app.html("tier-list").match(/✅/g), "cả ba mốc đều ✅").toHaveLength(3);
    expect(app.text("progress-text"), "phải nói rõ đã dùng lại chữ ký cũ")
      .toContain("dùng lại 2 chữ ký");
    expectToastShowing("dùng lại 2 chữ ký");
    expectToastAutoHides();
    // Gas đã nhập vẫn là gas của giao dịch mới (50 gwei trần / 1 gwei tip).
    expect(sent[0].maxFeePerGas).toBe("0xba43b7400");
    expect(sent[0].maxPriorityFeePerGas).toBe("0x3b9aca00");
  });

  it("lưu xong: nút Lưu về nhãn thường, success banner giữ markup, toast lưu tắt khi bấm", async () => {
    app.takeCalls();

    await app.window.saveToServer();

    const posted = app
      .takeCalls()
      .map((call) => JSON.parse(call))
      .find((call) => call.kind === "api" && call.url === "/api/bundle");
    expect(posted, "bundle phải được lưu").toBeTruthy();
    expect(posted.body.tiers).toHaveLength(3);
    expect(el("btn-save-server").textContent, "nhãn phải trở lại bình thường").toBe("💾 Lưu Lên Server");
    expect(el("btn-save-server").disabled, "giữ khoá để không POST trùng cùng bundle").toBe(true);
    expect(app.html("presign-result"), "markup success KHÔNG đổi")
      .toContain('<div class="banner success">');
    expect(app.html("presign-result")).toContain("Đã lưu");

    expectToastShowing("Đã lưu 3 giao dịch");
    // Bấm vào toast ⇒ tắt NGAY, không phải chờ hết 5 giây.
    toastEl().onclick();
    expect(toastEl().style.display).toBe("none");
  });

  it("sang nonce N+1: ký lại đủ bộ với gas cũ, rồi Lưu được ngay (không refresh)", async () => {
    app.window.onNonceStep(1);
    expect(app.text("presign-nonce")).toBe("12");
    app.takeCalls();

    await app.window.signAllTiers();

    const sent = sentTxs();
    expect(sent, "rung nonce mới cần chữ ký mới cho cả 3 mốc").toHaveLength(3);
    expect(sent.map((tx) => tx.nonce)).toEqual(["0xc", "0xc", "0xc"]);
    expect(sent[0].maxFeePerGas, "gas đã nhập phải được giữ nguyên").toBe("0xba43b7400");
    expect(sent[0].maxPriorityFeePerGas).toBe("0x3b9aca00");
    expect(el("btn-save-server").disabled, "có chữ ký mới ⇒ Lưu mở lại").toBe(false);
    expectToastShowing("Đã ký 3 giao dịch mới ở nonce 12");
    expectToastAutoHides();

    // Lưu đợt N+1 — cùng một trang, không reload.
    app.takeCalls();
    await app.window.saveToServer();
    const posted = app
      .takeCalls()
      .map((call) => JSON.parse(call))
      .find((call) => call.kind === "api" && call.url === "/api/bundle");
    expect(posted.body.nonce, "bundle thứ hai phải mang nonce 12").toBe(12);
    expect(el("btn-save-server").textContent).toBe("💾 Lưu Lên Server");
    expectToastShowing("Đã lưu 3 giao dịch");
    expectToastAutoHides();
  });

  it("bấm Ký khi mọi mốc đã ký ở nonce này: 0 popup ví, toast thông báo và tự tắt", async () => {
    app.takeCalls();

    await app.window.signAllTiers();

    expect(sentTxs()).toHaveLength(0);
    expect(app.text("progress-text")).toContain("Không có mốc mới");
    expectToastShowing("không có gì mới để ký");
    expectToastAutoHides();
    expect(el("btn-save-server").disabled, "chữ ký còn sống ⇒ vẫn lưu lại được").toBe(false);
  });

  it("lỗi gas vẫn là banner LỖI trong #presign-result, toast không bị dùng thay banner", async () => {
    app.setValue("presign-gas-maxfee", "1e-7");
    app.window.onGasInputChange();
    app.takeCalls();

    await app.window.signAllTiers();

    expect(sentTxs()).toHaveLength(0);
    expect(app.html("presign-result"), "banner lỗi giữ nguyên markup")
      .toContain('<div class="banner error">');
    expect(app.html("presign-result")).toContain("Gas không hợp lệ");
    expect(toastEl().style.display, "lỗi KHÔNG được thay bằng toast").toBe("none");
  });
});
