/**
 * Chẩn đoán 2026-09-26 — “thông tin về các bundle và tier lúc hiện lúc không” (người dùng báo),
 * khi RPC công cộng hỏng lúc mở trang và/hoặc server trả lỗi tạm thời.
 *
 * Đỏ-trước (chạy trên cây trước fix, CÙNG harness này — xem commit body):
 *   B1 init/switchTab khi RPC hỏng  → 0 request /api/presign: bundle không bao giờ hiện, bấm tab
 *      bao nhiêu lần cũng vậy (vì `if (tab === "presign" && state.marketData)`).
 *   B2 một lần 503 (`LOCK_STALE`) rồi lành → mục bundle bị ẨN IM LẶNG, không thử lại, không báo.
 *
 * Cách chạy: MỘT `loadWebapp` mỗi tiến trình (module browser là ESM cache theo URL — nạp lần hai
 * trong cùng tiến trình không evaluate lại), nên cả file dùng chung một app: RPC chặn `eth_call`
 * (mô phỏng “RPC công cộng hỏng lúc mở trang”) + một lần 503 cho `/api/presign`.
 * Assertions nằm trên ARTIFACT: request thật đi ra, DOM thật.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeRpc, loadWebapp } from "./helpers/webapp-harness.mjs";
import { PRESIGN_FETCH_ATTEMPTS, PRESIGN_FETCH_DELAY_MS, retryTransient } from "../webapp-logic.mjs";

const rpc = createFakeRpc({ failingMethods: ["eth_call"] });
const api = createFakeApi({ failures: { "/api/presign": { status: 503, times: 1 } } });
const app = await loadWebapp({ rpc, api });

afterAll(() => app.restore());

/** Chờ đủ lâu cho một chu kỳ thử lại thật (attempt + delay) hoàn tất. */
const settleRetry = () => new Promise((resolve) => setTimeout(resolve, PRESIGN_FETCH_DELAY_MS * 2 + 100));

/**
 * Mọi lời gọi đã đi ra từ đầu phiên (gộp dần qua `takeCalls()`, buffer của harness bị xoá sau mỗi
 * lần lấy nên phải tự cộng dồn). Đếm luỹ kế là thứ cần ở đây: khẳng định "không có gì được gửi"
 * chỉ có nghĩa khi nhìn cả phiên.
 */
let seen = [];
function drain() {
  seen = seen.concat(app.takeCalls().map((raw) => JSON.parse(raw)));
  return seen;
}
const apiCalls = (path) => drain().filter((c) => c.kind === "api" && c.url.startsWith(path)).length;

const displayOf = (id) => app.env.elements.get(id)?.style?.display;

describe("B1 — bundle/tier không được biến mất khi RPC công cộng hỏng", () => {
  it("switchTab('presign') vẫn đọc /api/presign khi marketData chưa có (đỏ-trước: 0 request)", async () => {
    await app.window.connectWallet();
    await app.window.signIn(); // currentTab = "withdraw" ⇒ signIn không tự đọc bundle
    expect(apiCalls("/api/presign"), "signIn ở tab khác không được đọc bundle").toBe(0);

    await app.window.switchTab("presign");
    expect(apiCalls("/api/presign"), "tab presign phải đọc bundle ngay cả khi RPC hỏng").toBeGreaterThan(0);

    await settleRetry(); // lần đầu 503 → thử lại → lành
    const info = app.html("presign-existing-info");
    expect(info, "ladder phải được render").toMatch(/nonce-display">11/);
    expect(info).toContain("pending");
    expect(displayOf("presign-existing")).toBe("block");
  });
});

describe("B2 — lỗi tạm thời 503 phải tự lành hoặc báo rõ, không ẩn im lặng", () => {
  it("503 liên tục: thử lại đủ ngân sách rồi hiện lỗi + nút thử lại (đỏ-trước: display = none)", async () => {
    api.failNext("/api/presign", { status: 503, times: 99 });
    const before = apiCalls("/api/presign");
    await app.window.fetchExistingBundle();
    expect(apiCalls("/api/presign") - before, "1 lần gốc + 2 lần thử lại").toBe(PRESIGN_FETCH_ATTEMPTS);

    const info = app.html("presign-existing-info");
    expect(info).toContain("Không tải được bundle đã ký");
    expect(info).toContain("HTTP 503");
    expect(info).toContain("fetchExistingBundle()"); // nút thử lại gọi lại chính hàm này
    expect(displayOf("presign-existing"), "lỗi phải HIỆN, không được ẩn mục bundle").toBe("block");

    api.clearFailures("/api/presign"); // phần còn lại của file không dính lỗi này
  });
});

describe("hợp đồng retryTransient (hàm thuần dùng chung)", () => {
  it("thử lại lỗi tạm thời, dừng ở lỗi thật, hết ngân sách thì trả kết quả cuối", async () => {
    const sleeps = [];
    let attempts = 0;
    const healed = await retryTransient(
      async () => (++attempts < 3 ? { retry: true } : { value: "ok" }),
      { attempts: 5, delayMs: 7, sleep: async (ms) => sleeps.push(ms) }
    );
    expect(healed).toEqual({ value: "ok" });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([7, 7]); // không ngủ sau lần thành công

    let hardAttempts = 0;
    const hard = await retryTransient(
      async () => { hardAttempts += 1; return { failure: "HTTP 400" }; },
      { sleep: async () => { throw new Error("lỗi thật thì không được ngủ"); } }
    );
    expect(hard.failure).toBe("HTTP 400");
    expect(hardAttempts).toBe(1);

    let total = 0;
    const last = await retryTransient(
      async () => { total += 1; return { retry: true, failure: "HTTP 503" }; },
      { attempts: PRESIGN_FETCH_ATTEMPTS, sleep: async () => {} }
    );
    expect(last.failure).toBe("HTTP 503");
    expect(total).toBe(PRESIGN_FETCH_ATTEMPTS);
  });
});

describe("B3 — lỗi khi DỰNG tổng quan cũng phải hiện banner (đỏ-trước: ném ra ngoài, không banner)", () => {
  it("payload tổng quan sai shape ⇒ banner + nút thử lại, không mất mục tổng quan", async () => {
    // Lưới cũ bao cả phần render; D18 tách ra thì render rơi khỏi lưới ⇒ lỗi bị ném ra ngoài
    // (unhandled rejection của handler inline) và người dùng chỉ thấy mục tổng quan trống.
    api.setOverview({ ok: true, markets: { khong: "phai la mang" }, rounds: [] });
    await app.window.refreshPresignOverview();

    const info = app.html("presign-overview-info");
    expect(info).toContain("Không dựng được tổng quan presign");
    expect(info).toContain("refreshPresignOverview()"); // nút thử lại gọi lại chính hàm này

    api.setOverview({ ok: true, markets: [], rounds: [] }); // trả shape lành cho phần còn lại
    await app.window.refreshPresignOverview();
    expect(app.html("presign-overview-info")).not.toContain("Không dựng được");
  });
});
