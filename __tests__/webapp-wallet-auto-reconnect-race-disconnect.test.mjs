/**
 * Race: người dùng bấm “Ngắt Kết Nối” trong lúc `tryAutoConnectWallet()` đang chờ
 * `eth_accounts` trả lời. Key localStorage đã bị xoá ⇒ lượt khôi phục chậm không
 * được tự kết nối lại sau khi người dùng vừa ngắt.
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

describe("race: bấm Ngắt Kết Nối khi auto-connect đang chờ ví", () => {
  it("auto-connect còn treo ở eth_accounts, chưa khôi phục gì", () => {
    expect(state.currentAccount).toBeNull();
    expect(releaseAccounts).toBeTypeOf("function");
    expect(el("wallet-connected").style.display).not.toBe("block");
  });

  it("ngắt kết nối thắng — key đã xoá, lượt khôi phục cũ không nối lại ví", async () => {
    app.window.disconnectWallet();
    expect(state.currentAccount).toBeNull();
    expect(app.window.localStorage.getItem("morpho-wallet-account")).toBeNull();

    releaseAccounts(); // auto-connect chạy tiếp: eth_chainId → kiểm key/race
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.currentAccount, "không được tự kết nối lại").toBeNull();
    expect(state.walletClient).toBeNull();
    expect(el("wallet-connected").style.display).not.toBe("block");
    expect(el("btn-withdraw").disabled).toBe(true);
    expect(app.window.localStorage.getItem("morpho-wallet-account")).toBeNull();
    expect(el("error-banner").style.display).not.toBe("block");
  });
});
