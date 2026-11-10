/**
 * Ký Rút Toàn Bộ Shares phải chốt nonce TRƯỚC popup ví, giống `signAllTiers`.
 *
 * Ca chính: người dùng bấm `+` trong lúc popup ví đang chờ. Chữ ký đã được tạo ở nonce cũ
 * (`eth_sendTransaction.nonce` chốt trước popup) nên KHÔNG được đánh dấu ✅ ở nonce mới —
 * kể cả khi proxy chưa kịp có bằng chứng nonce. Sau đó ký lại ở nonce mới phải thành công
 * và ghim `signedNonce` đúng nonce đó.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeProvider, createFakeRpc, loadWebapp } from "./helpers/webapp-harness.mjs";

const base = createFakeProvider();
let sendStartedResolve;
const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
let releaseSend;
let sendCount = 0;
const provider = {
  provider: {
    ...base.provider,
    async request(args) {
      // Chỉ giữ giao dịch ĐẦU TIÊN để test chen `onNonceStep` đúng lúc popup đang chờ.
      if (args.method === "eth_sendTransaction" && sendCount === 0) {
        sendCount = 1;
        sendStartedResolve();
        await new Promise((resolve) => { releaseSend = resolve; });
      }
      return base.provider.request(args);
    },
  },
  calls: base.calls,
};

const api = createFakeApi();
const app = await loadWebapp({ rpc: createFakeRpc(), api, provider });
const { state } = await import("../webapp-state.mjs");

afterAll(() => app.restore());

const el = (id) => app.env.elements.get(id);

const sentTxs = () => app
  .takeCalls()
  .map((call) => JSON.parse(call))
  .filter((call) => call.kind === "provider" && call.method === "eth_sendTransaction")
  .map((call) => call.params[0]);

async function primeSigning() {
  await app.window.connectWallet();
  await app.window.signIn();
  await app.window.fetchNonce(); // sàn on-chain = 11
  app.setValue("presign-gas-maxfee", "50");
  app.setValue("presign-gas-priority", "1");
  app.window.onGasInputChange();
}

await primeSigning();

describe("rút toàn bộ shares — nonce chốt trước popup ví", () => {
  it("đổi nonce trong lúc chờ ký ⇒ ❌, không có chữ ký ✅ ở nonce mới, Lưu bị khoá", async () => {
    app.takeCalls();

    const pending = app.window.signWithdrawAll();
    await sendStarted; // popup ví đã mở, giao dịch đang chờ
    app.window.onNonceStep(1); // 11 → 12 giữa lúc chờ
    expect(app.text("presign-nonce")).toBe("12");
    releaseSend();

    await pending;

    const sent = sentTxs();
    expect(sent, "giao dịch phải được gửi ở nonce đã chốt trước popup").toHaveLength(1);
    expect(sent[0].nonce).toBe("0xb");

    expect(state.presignedWithdrawAll.status, "không được coi là đã ký ở nonce 12").toBe("error");
    expect(state.presignedWithdrawAll.nonceMismatch).toEqual({ requested: 12, actual: 11 });
    expect(state.presignedWithdrawAll.signedNonce).toBeUndefined();
    expect(el("btn-sign-withdraw-all").textContent).toBe("🔄 Ký Rút Toàn Bộ Shares");
    expect(el("btn-save-server").disabled, "không có chữ ký lưu được ⇒ Lưu phải khoá").toBe(true);

    const banner = app.html("presign-result");
    expect(banner).toContain("nonce 11");
    expect(banner).toContain("nonce 12");
  });

  it("ký lại ở nonce mới ⇒ ✅, ghim signedNonce = 12 và lưu được", async () => {
    app.takeCalls();

    await app.window.signWithdrawAll();

    expect(state.presignedWithdrawAll.status).toBe("signed");
    expect(state.presignedWithdrawAll.signedNonce).toBe(12);
    expect(el("btn-sign-withdraw-all").textContent).toBe("✅ Đã Ký");
    expect(el("btn-save-server").disabled).toBe(false);

    await app.window.saveToServer();

    const posted = app
      .takeCalls()
      .map((call) => JSON.parse(call))
      .find((call) => call.kind === "api" && call.url === "/api/bundle");
    expect(posted, "bundle phải được lưu").toBeTruthy();
    expect(posted.body.nonce).toBe(12);
    expect(posted.body.tiers).toHaveLength(1);
    expect(posted.body.tiers[0].type).toBe("all-shares");
  });
});
