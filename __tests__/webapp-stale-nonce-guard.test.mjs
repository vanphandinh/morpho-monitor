/**
 * Chẩn đoán 2026-09-26 — “tier mới với nonce cao hơn tự động bị thêm vào bundle có nonce cũ”
 * (người dùng báo).
 *
 * Cơ chế: trang giữ `state.presignedNonce` từ lần bấm “Lấy Nonce” trước và KHÔNG bao giờ đọc lại
 * on-chain trước khi ký. Khi nonce đó đã bị tiêu thụ trong lúc trang mở, chữ ký mới mang nonce ĐÃ
 * CHẾT: server từ chối (409 `NONCE_NOT_CLAIMABLE`, D16) hoặc — trước D16 — nhét nó vào rung cũ.
 * Người dùng thấy “tier mới nằm trong bundle nonce cũ”.
 *
 * Đỏ-trước (chạy trên cây trước fix, CÙNG harness này):
 *   ký khi on-chain nonce (12) > nonce đang ký (11)  → vẫn gửi `eth_sendTransaction` ở nonce 11
 *   (chữ ký không thể mine, và là nguyên liệu của đúng triệu chứng trên).
 *
 * File riêng vì mỗi tiến trình chỉ nạp được webapp MỘT lần, và ca này cần RPC lành (khác với
 * `webapp-bundle-visibility.test.mjs`, nơi `eth_call` bị chặn để mô phỏng RPC hỏng).
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeRpc, DEFAULT_MARKET_ID, loadWebapp } from "./helpers/webapp-harness.mjs";

const rpc = createFakeRpc(); // RPC lành: init đọc được market/position
const workingRpcFetch = rpc.fetch; // giữ bản lành để khôi phục sau ca "RPC nonce hỏng"
const api = createFakeApi();
const app = await loadWebapp({ rpc, api });

afterAll(() => app.restore());

const sends = () => app.takeCalls().map((raw) => JSON.parse(raw))
  .filter((c) => c.kind === "provider" && c.method === "eth_sendTransaction");

async function primeSigning() {
  await app.window.connectWallet();
  await app.window.signIn();
  await app.window.fetchNonce();
  app.window.addPresetTier("100");
  app.setValue("presign-gas-maxfee", "50");
  app.setValue("presign-gas-priority", "1");
  app.window.onGasInputChange();
}

describe("B3 — nonce on-chain đã vượt qua thì KHÔNG được ký", () => {
  it("chặn ký, tự nâng nonce lên sàn mới, báo rõ (đỏ-trước: vẫn gửi eth_sendTransaction)", async () => {
    await primeSigning();
    expect(app.text("presign-nonce")).toBe("11");
    sends(); // xả buffer trước khi đo
    rpc.setNonce(12); // nonce 11 bị một giao dịch khác tiêu thụ trong lúc trang mở

    await app.window.signAllTiers();
    expect(sends(), "không được ký ở nonce đã chết").toEqual([]);
    expect(app.html("presign-result")).toContain("đã bị vượt qua");
    expect(app.text("presign-nonce"), "tự nâng lên đúng sàn on-chain").toBe("12");
  });

  it("sau khi tự nâng, nonce bằng on-chain ⇒ ký bình thường (lưới hồi quy)", async () => {
    await app.window.signAllTiers();
    const sent = sends();
    expect(sent.length, "ví phải nhận đúng 1 giao dịch").toBe(1);
    expect(sent[0].params[0].nonce, "ký đúng nonce mới").toBe("0xc");
  });

  it("không đọc lại được nonce on-chain ⇒ fail closed (không ký ở nonce mù)", async () => {
    // (đỏ-trước: vẫn gửi eth_sendTransaction — không có bằng chứng nào được hỏi)
    rpc.setNonce("0xd");
    // `eth_getTransactionCount` bị chặn ⇒ guard không có bằng chứng nonce còn sống.
    const blocked = createFakeRpc({ failingMethods: ["eth_getTransactionCount"] });
    rpc.fetch = blocked.fetch; // chỉ chặn ở tầng RPC; app vẫn dùng client cũ (đã tạo lúc init)
    await app.window.signAllTiers();
    expect(sends(), "thiếu bằng chứng nonce ⇒ không ký").toEqual([]);
    expect(app.html("presign-result")).toContain("Không đọc lại được nonce on-chain");
    rpc.fetch = workingRpcFetch; // trả RPC về bình thường cho các ca sau
  });

  it("proxy từ chối vì nonce đã tiêu thụ ⇒ app báo rõ và tự lấy lại nonce mới (D20)", async () => {
    // Cổng nonce ở proxy trả 409 `NONCE_CONSUMED` (xem __tests__/proxy-nonce-freshness.test.mjs).
    api.setBundle({ ok: false, code: "NONCE_CONSUMED", error: "nonce 12 đã bị tiêu thụ (on-chain pending 13)" });
    rpc.setNonce(13);

    await app.window.saveToServer();

    expect(app.html("presign-result"), "báo đúng lý do proxy từ chối").toContain("đã bị tiêu thụ");
    expect(app.html("presign-result")).toContain("proxy từ chối lưu");
    expect(app.text("presign-nonce"), "tự đọc lại sàn on-chain").toBe("13");
  });

  it("dấu 'nonce kế tiếp' thuộc rung đang sống, không phải rung đã chết (đỏ-trước: 2550)", async () => {
    api.setPresign({
      ok: true,
      exists: true,
      ladder: [
        { marketId: DEFAULT_MARKET_ID, nonce: 2550, status: "expired", tiers: [] },
        { marketId: DEFAULT_MARKET_ID, nonce: 2553, status: "pending", tiers: [{ amount: "100", amountFormatted: "100 USDC", label: "100 USDC" }] },
      ],
    });
    // Đi qua đường thật của UI (chuyển tab), không gọi hàm render trực tiếp.
    await app.window.switchTab("presign");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const html = app.html("presign-existing-info");
    const marker = html.indexOf("nonce kế tiếp sẽ broadcast");
    expect(marker, "phải có đúng một dấu head").toBeGreaterThan(-1);
    const nonceBefore = [...html.slice(0, marker).matchAll(/nonce-display">(\d+)/g)].at(-1)?.[1];
    expect(nonceBefore, "head phải là rung pending 2553").toBe("2553");
    expect(html, "rung expired vẫn phải hiển thị (lịch sử)").toMatch(/nonce-display">2550/);
  });

  it("server từ chối rung đã chết (NONCE_NOT_CLAIMABLE, D16) ⇒ app cũng tự lấy lại nonce, không để chữ ký chết nằm lại", async () => {
    // Mã này sinh ở SERVER (D16) và chỉ tới được browser vì relay proxy chuyển tiếp `code`
    // (ghim ở ca cuối `__tests__/proxy-nonce-freshness.test.mjs`). Không có `code`, app chỉ còn
    // chuỗi lỗi để đọc ⇒ người dùng kẹt với chữ ký đã chết + nút lưu vẫn mời bấm lại.
    await app.window.signAllTiers(); // ký thật ở nonce hiện tại (13) để có chữ ký sống
    expect(sends().length, "phải có chữ ký sống trước khi thử ca từ chối").toBe(1);
    api.setBundle({
      ok: false,
      code: "NONCE_NOT_CLAIMABLE",
      error: "nonce 13 đã hết hạn (bundle m1@13 ở trạng thái expired) — lấy nonce mới rồi ký lại",
    });
    rpc.setNonce(14);

    await app.window.saveToServer();

    expect(app.html("presign-result"), "báo đúng lý do server từ chối").toContain("server từ chối lưu");
    expect(app.html("presign-result")).toContain("hết hạn");
    expect(app.text("presign-nonce"), "tự đọc lại sàn on-chain").toBe("14");
    // Chữ ký ở nonce đã chết bị vô hiệu (không còn tier ✅) — hết đường lưu lại rác.
    expect(app.html("tier-list"), "chữ ký chết phải bị vô hiệu").not.toContain("✅");
  });
});
