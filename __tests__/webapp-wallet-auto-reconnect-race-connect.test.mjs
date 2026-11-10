/**
 * Race: người dùng bấm “Kết Nối Ví” trong lúc `tryAutoConnectWallet()` đang chờ
 * `eth_accounts` trả lời (IPC bất đồng bộ). Lượt khôi phục chậm không được ghi đè
 * lựa chọn mới — cả `state.currentAccount`, UI lẫn key localStorage.
 *
 * `init()` cố ý KHÔNG await auto-connect, nên `loadWebapp()` trả về khi lời gọi
 * `eth_accounts` còn treo; test giữ nó bằng một deferred rồi mới thả.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  createFakeApi,
  createFakeProvider,
  createFakeRpc,
  DEFAULT_LENDER,
  loadWebapp,
} from "./helpers/webapp-harness.mjs";

// Tài khoản người dùng chọn thủ công — KHÁC địa chỉ lender đã nhớ trong storage.
const MANUAL = "0x00000000000000000000000000000000000000aa";

const base = createFakeProvider();
let releaseAccounts;
const provider = {
  provider: {
    ...base.provider,
    async request(args) {
      if (args.method === "eth_accounts") {
        // Giữ auto-connect treo cho tới khi test thả — mô phỏng ví trả lời chậm.
        await new Promise((resolve) => {
          releaseAccounts = resolve;
        });
        return [DEFAULT_LENDER];
      }
      if (args.method === "eth_requestAccounts") return [MANUAL];
      return base.provider.request(args);
    },
  },
  calls: base.calls,
};

const app = await loadWebapp({
  rpc: createFakeRpc(),
  api: createFakeApi(),
  provider,
  storageSeed: { "morpho-wallet-account": DEFAULT_LENDER.toLowerCase() },
});
const { state } = await import("../webapp-state.mjs");

afterAll(() => app.restore());

const el = (id) => app.env.elements.get(id);

describe("race: bấm Kết Nối Ví khi auto-connect đang chờ ví", () => {
  it("auto-connect còn treo ở eth_accounts, chưa khôi phục gì", () => {
    expect(state.currentAccount).toBeNull();
    expect(state.walletClient).toBeNull();
    expect(releaseAccounts).toBeTypeOf("function");
    // Stub không có inline style ban đầu (undefined) — điều cần ghim là ví CHƯA hiện đã kết nối.
    expect(el("wallet-connected").style.display).not.toBe("block");
  });

  it("kết nối thủ công thắng — lượt khôi phục cũ không ghi đè tài khoản/UI/key", async () => {
    await app.window.connectWallet();
    expect(state.currentAccount).toBe(MANUAL);

    releaseAccounts(); // auto-connect chạy tiếp: eth_chainId → kiểm race
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.currentAccount, "không bị kéo về địa chỉ đã nhớ").toBe(MANUAL);
    expect(app.text("wallet-address")).toBe(MANUAL);
    expect(app.text("presign-wallet-address")).toBe(MANUAL);
    expect(app.window.localStorage.getItem("morpho-wallet-account")).toBe(MANUAL.toLowerCase());
    expect(el("error-banner").style.display).not.toBe("block");
  });
});
