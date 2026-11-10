/**
 * Chưa từng kết nối (không có key `morpho-wallet-account`) ⇒ boot phải KHÔNG gọi provider
 * lần nào. Đây là bất biến giữ cho mọi môi trường mới (và test harness cũ) không bị đổi
 * hành vi bởi tính năng tự khôi phục ví.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeRpc, loadWebapp } from "./helpers/webapp-harness.mjs";

const app = await loadWebapp({ rpc: createFakeRpc(), api: createFakeApi() });
const { state } = await import("../webapp-state.mjs");

afterAll(() => app.restore());

const el = (id) => app.env.elements.get(id);

describe("refresh khi chưa từng kết nối", () => {
  it("boot không phát sinh lời gọi provider nào", () => {
    const providerCalls = app
      .takeCalls()
      .map((call) => JSON.parse(call))
      .filter((call) => call.kind === "provider");

    expect(providerCalls).toEqual([]);
  });

  it("ví vẫn ở trạng thái chưa kết nối, không có lỗi tự khôi phục", () => {
    expect(state.currentAccount).toBeNull();
    expect(state.walletClient).toBeNull();
    expect(el("wallet-connected").style.display).not.toBe("block");
    expect(el("error-banner").style.display).not.toBe("block");
  });
});
