/**
 * Chẩn đoán 2026-09-26 — ký presign ở nonce CAO HƠN sàn, và cái giá phải trả khi VÍ không tôn trọng
 * nonce dApp gửi.
 *
 * Người dùng chủ đích ký ở nonce tương lai (stepper ＋) để xếp hàng nhiều rung. Webapp ghim nonce
 * vào params (`eth_sendTransaction.nonce`), nhưng ví có quyền bỏ qua — và nonce KHÔNG nằm trong
 * hash mà ví trả về, nên trước fix webapp chỉ biết mình sai ở bước Lưu: proxy trả 400
 * `Calldata verify failed: withdrawals[0]: tx nonce M !== bundle nonce N` **không có `code`**,
 * webapp rơi nhánh "Lỗi proxy: …" chung, tier vẫn ✅ và bấm Lưu lặp đúng 400 đó.
 *
 * Hướng đi KHÔNG được chọn (người dùng đính chính 2026-09-26): hạ `state.presignedNonce` xuống
 * nonce ví tự chọn để "khớp hành vi ví". Hướng ở đây là NGƯỢC LẠI: giữ nonce đã chọn, biết chắc
 * chữ ký thật nằm ở nonce nào (proxy lưu `nonce` lúc capture, webapp đọc qua `/api/captured`),
 * lệch thì DỪNG NGAY + chỉ cách buộc ví tôn trọng nonce (bật custom nonce) — không tự hạ.
 *
 * Đỏ-trước (chạy trên cây trước fix, CÙNG harness này):
 *   - ca A: không có `GET /api/captured` nào được gọi (chưa có đường đọc bằng chứng);
 *   - ca B: ví "ký ở nonce 11" trong khi yêu cầu 12 ⇒ app vẫn ký tiếp tier sau, tier nhận ✅,
 *     nút Lưu được BẬT, và lỗi chỉ nổ ra ở bước Lưu (400 trần);
 *   - ca C: preflight không tồn tại ⇒ `POST /api/bundle` vẫn được gửi dù biết chắc 400;
 *   - ca D: `code: "NONCE_MISMATCH"` rơi vào nhánh chung "Lỗi proxy: …";
 *   - ca E: không có `#presign-nonce-hint` (không ai nhắc ví phải cho đặt nonce).
 *
 * File riêng vì mỗi tiến trình chỉ nạp được webapp MỘT lần (`import` ESM cache theo URL), nên
 * các ca trong file này là MỘT kịch bản nối tiếp, reset tier bằng đường UI thật (`updateTierAmount`
 * đưa tier đã ký về pending — cùng đường người dùng sửa số tiền).
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeRpc, fakeHash, loadWebapp } from "./helpers/webapp-harness.mjs";

const rpc = createFakeRpc(); // nonce on-chain mặc định = 11
const api = createFakeApi();
const app = await loadWebapp({ rpc, api });

afterAll(() => app.restore());

/** Các `eth_sendTransaction` của ví kể từ lần `takeCalls()` gần nhất. */
const sends = () => app.takeCalls().map((raw) => JSON.parse(raw))
  .filter((c) => c.kind === "provider" && c.method === "eth_sendTransaction");

/** Các lời gọi `/api/captured` kể từ lần `takeCalls()` gần nhất. */
const capturedReads = () => app.takeCalls().map((raw) => JSON.parse(raw))
  .filter((c) => c.kind === "api" && c.url === "/api/captured");

const saveDisabled = () => app.env.elements.get("btn-save-server").disabled;

/** Bằng chứng proxy capture: `hash` + nonce THẬT của chữ ký ví. */
const captured = (...txs) => ({ ok: true, count: txs.length, txs });

async function primeSigning() {
  await app.window.connectWallet();
  await app.window.signIn();
  await app.window.fetchNonce(); // sàn on-chain = 11
  app.window.addPresetTier("100");
  app.setValue("presign-gas-maxfee", "50");
  app.setValue("presign-gas-priority", "1");
  app.window.onGasInputChange();
}

await primeSigning();

describe("chỉ dẫn nonce > sàn (ví phải cho phép đặt nonce)", () => {
  it("ẩn khi đứng ở sàn, hiện khi đứng trên sàn (kèm cách buộc ví), ẩn lại khi về sàn", async () => {
    expect(app.text("presign-nonce"), "sàn on-chain").toBe("11");
    expect(app.html("presign-nonce-hint"), "đứng ở sàn ⇒ không nhắc").toBe("");

    app.window.onNonceStep(1); // 11 → 12: ký ở nonce tương lai
    expect(app.text("presign-nonce")).toBe("12");
    const hint = app.html("presign-nonce-hint");
    expect(hint, "phải nói nonce đang chọn và sàn").toContain("nonce");
    expect(hint).toContain("12");
    expect(hint).toContain("Customize transaction nonce");

    app.window.onNonceStep(-1); // về sàn
    expect(app.text("presign-nonce")).toBe("11");
    expect(app.html("presign-nonce-hint"), "về sàn ⇒ tắt nhắc").toBe("");
  });
});

describe("A — ký ở nonce CAO + ví tôn trọng nonce ⇒ xác minh và lưu được", () => {
  it("proxy xác nhận đúng nonce 12; bundle lưu lên mang nonce 12", async () => {
    app.window.onNonceStep(1); // 11 → 12
    expect(app.text("presign-nonce")).toBe("12");
    app.takeCalls();

    // Ví tôn trọng nonce: tx đã capture mang đúng nonce 12 mình gửi.
    api.setCaptured(captured({ hash: fakeHash(1), nonce: 12, nonceOnChain: 11 }));

    await app.window.signAllTiers();

    const reads = capturedReads();
    expect(reads.length, "phải hỏi proxy chữ ký thật nằm ở nonce nào").toBe(1);
    expect(reads[0].authorization, "đọc bằng chứng phải kèm Bearer của phiên").toBe("Bearer test-token");
    expect(app.html("tier-list")).toContain("✅");
    expect(app.text("progress-text"), "lời kết phải nói đã xác minh nonce").toContain("xác nhận đúng nonce 12");

    app.takeCalls();
    await app.window.saveToServer();
    const posted = app.takeCalls().map((raw) => JSON.parse(raw))
      .find((c) => c.kind === "api" && c.url === "/api/bundle");
    expect(posted, "bundle phải được lưu").toBeTruthy();
    expect(posted.body.nonce, "nonce gửi lên là nonce ĐÃ CHỌN, không phải nonce ví tự đổi").toBe(12);
    expect(app.html("presign-result")).toContain("Đã lưu");
  });
});

describe("B — ví bỏ qua nonce ⇒ DỪNG NGAY, không đốt thêm popup", () => {
  it("tier ❌ với hai số thật, chỉ 1 giao dịch được gửi, nút Lưu bị khoá", async () => {
    // Tier 0 đang ✅ (ca A) — sửa số tiền đưa về pending như người dùng thật, rồi thêm tier 2.
    app.window.updateTierAmount(0, "100");
    app.window.addPresetTier("250");
    // Ví "tự chọn nonce": tx thứ hai (fakeHash(2)) nằm ở nonce 11 dù webapp gửi 12.
    api.setCaptured(captured({ hash: fakeHash(2), nonce: 11, nonceOnChain: 11 }));
    app.takeCalls();

    await app.window.signAllTiers();

    const sent = sends();
    expect(sent.length, "lệch nonce ở tier đầu ⇒ KHÔNG ký tier tiếp theo").toBe(1);
    expect(sent[0].params[0].nonce, "nonce webapp gửi vẫn là nonce đã chọn (12)").toBe("0xc");
    expect(app.html("tier-list"), "không được có ✅ cho chữ ký sai nonce").not.toContain("✅");
    expect(app.html("tier-list")).toContain("❌");
    const banner = app.html("presign-result");
    expect(banner, "phải nói đúng hai số").toContain("nonce 11");
    expect(banner).toContain("nonce 12");
    expect(banner, "phải chỉ cách buộc ví tôn trọng nonce").toContain("Customize transaction nonce");
    expect(banner, "chưa có gì được gửi lên server").toContain("CHƯA có gì được gửi lên server");
    expect(app.text("progress-text")).toContain("đã dừng ký");
    expect(saveDisabled(), "nút Lưu không được mời bấm khi không còn chữ ký lưu được").toBe(true);
  });
});

describe("C — bằng chứng đến sau khi ký ⇒ preflight chặn POST (không để 400 trần)", () => {
  it("không gửi /api/bundle, chỉ rõ tier lệch, tier kia vẫn ✅", async () => {
    app.window.updateTierAmount(0, "100"); // reset tier 1 (đang ❌) về pending
    api.setCaptured(captured());           // lúc ký: proxy chưa có bằng chứng ⇒ không chặn ký
    app.takeCalls();

    await app.window.signAllTiers();
    expect(sends().length, "hai tier sạch ⇒ hai giao dịch").toBe(2);
    expect(app.text("progress-text"), "thiếu bằng chứng thì nói thật là chưa xác minh")
      .toContain("chưa xác minh được nonce");

    // Bằng chứng xuất hiện SAU: tier 2 (fakeHash(4)) nằm ở nonce 11 thay vì 12.
    api.setCaptured(captured(
      { hash: fakeHash(3), nonce: 12, nonceOnChain: 11 },
      { hash: fakeHash(4), nonce: 11, nonceOnChain: 11 },
    ));
    app.takeCalls();
    await app.window.saveToServer();

    const posted = app.takeCalls().map((raw) => JSON.parse(raw))
      .find((c) => c.kind === "api" && c.url === "/api/bundle");
    expect(posted, "preflight phải chặn trước khi POST").toBeUndefined();
    expect(app.html("presign-result")).toContain("không thể lưu");
    expect(app.html("presign-result")).toContain("nonce 11");
    expect(app.html("presign-result")).toContain("nonce 12");
    const tiers = app.html("tier-list");
    expect(tiers, "tier lệch bị đánh ❌").toContain("❌");
    expect(tiers, "tier đúng nonce vẫn ✅ (không sửa quá tay)").toContain("✅");
    expect(saveDisabled()).toBe(true);
  });
});

describe("D — proxy trả mã NONCE_MISMATCH ⇒ banner phục hồi riêng (không phải 'Lỗi proxy:')", () => {
  it("dùng số thật của proxy, khoá Lưu tới khi ký lại", async () => {
    app.window.updateTierAmount(0, "100");
    app.window.updateTierAmount(1, "250");
    // Bằng chứng khớp ở bước ký (qua được per-sign + preflight) — ca này đo nhánh phản hồi của
    // proxy, tức cổng thứ hai vẫn phải nói được cùng nội dung nếu preflight vì lý do nào đó bỏ lọt.
    api.setCaptured(captured(
      { hash: fakeHash(5), nonce: 12, nonceOnChain: 11 },
      { hash: fakeHash(6), nonce: 12, nonceOnChain: 11 },
    ));
    app.takeCalls();
    await app.window.signAllTiers();
    expect(app.html("tier-list")).not.toContain("❌");

    api.setBundle({
      ok: false,
      code: "NONCE_MISMATCH",
      error: "Calldata verify failed: withdrawals[1]: tx nonce 11 !== bundle nonce 12",
      txNonce: 11,
      bundleNonce: 12,
      index: 1,
    });
    app.takeCalls();
    await app.window.saveToServer();

    const posted = app.takeCalls().map((raw) => JSON.parse(raw))
      .find((c) => c.kind === "api" && c.url === "/api/bundle");
    expect(posted, "preflight cho qua ⇒ POST được gửi, proxy mới là chốt cuối").toBeTruthy();

    const banner = app.html("presign-result");
    expect(banner, "không được rơi về nhánh chung").not.toContain("Lỗi proxy:");
    expect(banner).toContain("nonce 11");
    expect(banner).toContain("nonce 12");
    expect(banner).toContain("Customize transaction nonce");
    expect(app.html("tier-list"), "tier bị proxy chỉ mặt phải thành ❌").toContain("❌");
    expect(saveDisabled(), "chữ ký sai nonce không được mời Lưu lại").toBe(true);
  });
});
