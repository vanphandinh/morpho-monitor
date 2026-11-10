/**
 * Ví từ chối/không trả lời `eth_accounts` lúc tự khôi phục ⇒ đường đó NUỐT lỗi (không
 * banner, không unhandled rejection) và người dùng vẫn bấm “Kết Nối Ví” thủ công được.
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
let rejectNextSilentCall = true;
const provider = {
  provider: {
    ...base.provider,
    request: async (args) => {
      if (args.method === "eth_accounts" && rejectNextSilentCall) {
        rejectNextSilentCall = false;
        throw new Error("User rejected the request");
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

describe("tự khôi phục gặp ví từ chối", () => {
  it("lỗi bị nuốt, không banner, ví vẫn ở trạng thái chưa kết nối", () => {
    expect(state.currentAccount).toBeNull();
    expect(state.walletClient).toBeNull();
    expect(el("wallet-connected").style.display).not.toBe("block");
    expect(el("error-banner").style.display).not.toBe("block");
  });

  it("bấm “Kết Nối Ví” thủ công sau đó vẫn thành công", async () => {
    await app.window.connectWallet();

    expect(state.currentAccount).toBe(DEFAULT_LENDER);
    expect(el("wallet-connected").style.display).toBe("block");
    expect(app.text("wallet-address")).toBe(DEFAULT_LENDER);
    expect(el("error-banner").style.display).not.toBe("block");
  });
});
