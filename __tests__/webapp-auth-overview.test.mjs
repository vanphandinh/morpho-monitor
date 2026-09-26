/**
 * Triệu chứng (người dùng báo 2026-09-26): "Tổng Quan Presign (mọi market) không xuất hiện sau khi
 * xác thực ví — phải refresh lại webapp mới xuất hiện".
 *
 * Đỏ-trước (chạy trên cây trước fix, CÙNG harness này):
 *   - `signIn()` trên tab Ký Trước: `/api/overview` = 0 request, `#presign-overview` vẫn `display:none`,
 *     `#presign-overview-info` vẫn là "⏳ Đang tải..." ⇒ mục Tổng Quan chỉ hiện khi chuyển tab
 *     (`switchTab` gọi `refreshPresignOverview()`) hoặc F5 (`init()` gọi trong `finally`).
 *     Nguyên nhân: `signIn()` chỉ gọi `fetchExistingBundle()`, thiếu `refreshPresignOverview()`.
 *   - `signOut()`: `clearSession()` chỉ vẽ lại nút, không ai ẩn hai mục auth-gated ⇒ Tổng Quan và
 *     ladder vẫn nằm trên màn hình bằng dữ liệu của phiên vừa mất.
 *
 * Nút xác thực (`btn-sign-in`) nằm TRONG tab Ký Trước, nên đường thật của người dùng là: ở tab Ký
 * Trước → bấm xác thực. Test đi đúng đường đó (không gọi hàm render trực tiếp).
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeRpc, loadWebapp } from "./helpers/webapp-harness.mjs";

const rpc = createFakeRpc();
const api = createFakeApi();
const app = await loadWebapp({ rpc, api });

afterAll(() => app.restore());

/** Buffer của harness bị xoá sau mỗi `takeCalls()` ⇒ tự cộng dồn để đếm được cả phiên. */
let seen = [];
function drain() {
  seen = seen.concat(app.takeCalls().map((raw) => JSON.parse(raw)));
  return seen;
}
const apiCalls = (path) => drain().filter((c) => c.kind === "api" && c.url.startsWith(path)).length;
const displayOf = (id) => app.env.elements.get(id)?.style?.display;
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("xác thực ví xong là Tổng Quan Presign (mọi market) phải hiện ngay", () => {
  it("ở tab Ký Trước, `signIn()` phải đọc /api/overview và HIỆN bảng (đỏ-trước: 0 request, display none)", async () => {
    await app.window.connectWallet();
    await app.window.switchTab("presign");
    await settle();

    // Chưa xác thực: mục auth-gated phải ẩn (và không được tốn request nào).
    expect(apiCalls("/api/overview"), "chưa xác thực ⇒ không đọc tổng quan").toBe(0);
    expect(displayOf("presign-overview"), "chưa xác thực ⇒ mục tổng quan ẩn").toBe("none");

    await app.window.signIn();
    await settle();

    expect(apiCalls("/api/overview"), "xác thực xong phải đọc tổng quan NGAY, không đợi F5").toBeGreaterThan(0);
    expect(displayOf("presign-overview")).toBe("block");
    const info = app.html("presign-overview-info");
    expect(info, "phải là bảng thật, không phải trạng thái Đang tải").toContain("<table");
    expect(info).not.toContain("Đang tải");
  });

  it("ladder bundle cũng được đọc lại ngay sau xác thực (hành vi cũ — lưới hồi quy)", async () => {
    expect(apiCalls("/api/presign")).toBeGreaterThan(0);
    expect(app.html("presign-existing-info")).toMatch(/nonce-display/);
  });

  it("`signOut()` phải ẨN lại mọi mục auth-gated, không đọc thêm request (đỏ-trước: còn display:block)", async () => {
    const before = apiCalls("/api/overview");

    app.window.signOut();
    await settle();

    expect(apiCalls("/api/overview"), "đăng xuất không được đọc thêm tổng quan").toBe(before);
    expect(displayOf("presign-overview"), "mất phiên ⇒ tổng quan phải ẩn lại").toBe("none");
    expect(displayOf("presign-existing"), "mất phiên ⇒ ladder phải ẩn lại").toBe("none");
  });
});
