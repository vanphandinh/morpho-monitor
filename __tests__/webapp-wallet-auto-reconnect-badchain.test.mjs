/**
 * Refresh khi ví đang ở CHAIN KHÁC: tự khôi phục vẫn hiện ví đã kết nối (không im lặng
 * khoá người dùng ở màn hình “chưa kết nối”), chỉ cảnh báo — và nút “Kết Nối Ví” thủ công
 * vẫn hoạt động (đường này tự switch chain như trước).
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  createFakeApi,
  createFakeProvider,
  createFakeRpc,
  DEFAULT_LENDER,
  loadWebapp,
} from "./helpers/webapp-harness.mjs";

const provider = createFakeProvider({ chainId: "0x89" }); // Polygon — khác chain cấu hình (0x1)
const app = await loadWebapp({
  rpc: createFakeRpc(),
  api: createFakeApi(),
  provider,
  storageSeed: { "morpho-wallet-account": DEFAULT_LENDER.toLowerCase() },
});
const { state } = await import("../webapp-state.mjs");

afterAll(() => app.restore());

const el = (id) => app.env.elements.get(id);
const providerCalls = () =>
  app.takeCalls()
    .map((call) => JSON.parse(call))
    .filter((call) => call.kind === "provider");

describe("refresh với ví ở chain khác", () => {
  it("vẫn khôi phục ví và chỉ CẢNH BÁO chain — không chặn", () => {
    expect(state.currentAccount).toBe(DEFAULT_LENDER);
    expect(el("wallet-connected").style.display).toBe("block");
    expect(app.text("wallet-address")).toBe(DEFAULT_LENDER);
    expect(app.html("tx-result"), "phải nói rõ đang ở chain khác").toContain("chain khác");
    expect(el("error-banner").style.display).not.toBe("block");
    // Cùng luật với listener chainChanged: sai chain thì nút rút phải ĐÓNG (bấm chỉ hỏng).
    expect(el("btn-withdraw").disabled).toBe(true);
    expect(el("btn-withdraw-all").disabled).toBe(true);
  });

  it("bấm “Kết Nối Ví” thủ công vẫn chạy và tự switch về chain cấu hình", async () => {
    app.takeCalls();

    await app.window.connectWallet();

    const methods = providerCalls().map((call) => call.method);
    expect(methods).toContain("eth_requestAccounts");
    expect(methods, "đường thủ công tự switch chain như trước").toContain("wallet_switchEthereumChain");
    expect(el("error-banner").style.display).not.toBe("block");
    expect(app.text("wallet-address")).toBe(DEFAULT_LENDER);
    expect(el("btn-withdraw").disabled, "switch chain xong mới mở nút rút").toBe(false);
  });

  it("quay lại chain cấu hình qua chainChanged ⇒ mở lại nút rút (không kẹt khoá)", async () => {
    provider.provider.emit("chainChanged", "0x89"); // rời chain cấu hình
    expect(el("btn-withdraw").disabled).toBe(true);
    expect(el("btn-withdraw-all").disabled).toBe(true);

    provider.provider.emit("chainChanged", "0x1"); // chain cấu hình
    expect(el("btn-withdraw").disabled, "ví còn kết nối ⇒ mở lại ngay").toBe(false);
    expect(el("btn-withdraw-all").disabled).toBe(false);
    expect(el("btn-max").disabled).toBe(false);
    // Handler chainChanged còn gọi `fetchAllData()` nền — chờ nó xong TRƯỚC afterAll
    // (`app.restore()` dọn DOM; promise chạy sau đó sẽ ném "document is not defined").
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
