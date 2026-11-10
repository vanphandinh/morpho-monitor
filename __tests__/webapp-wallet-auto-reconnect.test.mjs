/**
 * Refresh trang KHÔNG phải bấm “Kết Nối Ví” lại — đường THẬT qua `init()`:
 * `tryAutoConnectWallet()` thấy key trong `localStorage` thì hỏi ví bằng `eth_accounts`
 * (im lặng, KHÔNG popup như `eth_requestAccounts`) + `eth_chainId`, rồi khôi phục
 * `state.currentAccount` / `state.walletClient` và toàn bộ UI ví/auth/compat.
 *
 * `storageSeed` của harness ghi key TRƯỚC khi module evaluate, nên đây đúng là
 * “lần mở trang sau” chứ không phải gọi thẳng hàm nội bộ.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  createFakeApi,
  createFakeProvider,
  createFakeRpc,
  DEFAULT_LENDER,
  loadWebapp,
} from "./helpers/webapp-harness.mjs";

const provider = createFakeProvider(); // chainId "0x1" — đúng chain cấu hình
const app = await loadWebapp({
  rpc: createFakeRpc(),
  api: createFakeApi(),
  provider,
  storageSeed: { "morpho-wallet-account": DEFAULT_LENDER.toLowerCase() },
});
const { state } = await import("../webapp-state.mjs");

afterAll(() => app.restore());

const el = (id) => app.env.elements.get(id);

/** Mọi lời gọi provider kể từ lần lấy trước, đã parse. */
const providerCalls = () =>
  app.takeCalls()
    .map((call) => JSON.parse(call))
    .filter((call) => call.kind === "provider");

describe("refresh với ví đã ghi nhớ — tự khôi phục im lặng", () => {
  it("boot chỉ gọi eth_accounts + eth_chainId, KHÔNG gọi eth_requestAccounts", () => {
    const methods = providerCalls().map((call) => call.method);

    expect(methods.sort()).toEqual(["eth_accounts", "eth_chainId"]);
    expect(methods, "không được mở popup xin quyền lại").not.toContain("eth_requestAccounts");
  });

  it("khôi phục currentAccount + walletClient và cập nhật UI ví/auth/compat", () => {
    expect(state.currentAccount, "state.currentAccount phải sống lại").toBe(DEFAULT_LENDER);
    expect(state.walletClient, "walletClient phải sẵn sàng để ký").toBeTruthy();

    // Tab rút tiền
    expect(app.text("wallet-address")).toBe(DEFAULT_LENDER);
    expect(el("wallet-status").style.display).toBe("none");
    expect(el("wallet-connected").style.display).toBe("block");
    expect(el("btn-withdraw").disabled).toBe(false);

    // Tab ký sẵn: địa chỉ + nút lấy nonce/gas mở lại
    expect(app.text("presign-wallet-address")).toBe(DEFAULT_LENDER);
    expect(el("presign-wallet-status").style.display).toBe("none");
    expect(el("presign-wallet-connected").style.display).toBe("block");
    expect(el("btn-fetch-nonce").disabled).toBe(false);
    expect(el("btn-auto-gas").disabled).toBe(false);

    // Auth: đúng ví lender ⇒ nút xác thực bật, nhãn đúng
    expect(app.text("btn-sign-in")).toContain("Xác Thực Bằng Ví");
    expect(el("btn-sign-in").disabled).toBe(false);

    // Compat banner + không có lỗi nào từ đường tự khôi phục
    expect(el("presign-wallet-banner").style.display).toBe("block");
    expect(el("error-banner").style.display).not.toBe("block");
  });

  it("bấm “Kết Nối Ví” thủ công sau đó vẫn chạy bình thường", async () => {
    app.takeCalls();

    await app.window.connectWallet();

    const methods = providerCalls().map((call) => call.method);
    expect(methods).toContain("eth_requestAccounts");
    expect(el("error-banner").style.display).not.toBe("block");
    expect(app.text("wallet-address")).toBe(DEFAULT_LENDER);
    expect(app.window.localStorage.getItem("morpho-wallet-account")).toBe(DEFAULT_LENDER.toLowerCase());
  });
});
