/**
 * Chẩn đoán 2026-11-15 — "ký presign xong, quay lại webapp là bị đòi kết nối lại ví + kí xác thực",
 * và "lưu lên server xong thì nút + nonce không bấm được".
 *
 * Cơ chế: MetaMask bắn `accountsChanged([])` / `disconnect` ngay sau khi trả hash (repo đã ghi nhận
 * trong `webapp-presign.mjs`). Handler cũ coi đó là người dùng ngắt kết nối ⇒ `disconnectWallet()`
 * xoá tài khoản, QUÊN ví đã nhớ (localStorage) và XOÁ PHIÊN HMAC 24h — phiên này độc lập với việc
 * ví còn kết nối. `setNonceStepperEnabled(false)` khoá luôn nút ± mà không đường nào bật lại khi
 * kết nối lại ⇒ "giao diện không cho tăng nonce".
 *
 * Đỏ-trước: mọi khẳng định dưới đây sai trên cây trước fix.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeProvider, createFakeRpc, loadWebapp, webappConfig } from "./helpers/webapp-harness.mjs";

// Địa chỉ lender có chữ hex + checksum hợp lệ (địa chỉ toàn số không phân biệt được hoa/thường).
const LENDER = "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3";

const rpc = createFakeRpc();
const api = createFakeApi();
const provider = createFakeProvider({ account: LENDER });

/** Hành vi ví SAU khi trả hash: null = bình thường; "accounts" = accountsChanged([]); "disconnect". */
let eventAfterSend = null;
/** true ⇒ `eth_accounts` trả [] (ví mất quyền THẬT, không phải nhiễu). */
let accountsRevoked = false;

const baseRequest = provider.provider.request;
provider.provider.request = async (args) => {
  if (args.method === "eth_accounts" && accountsRevoked) return [];
  const result = await baseRequest(args);
  if (eventAfterSend && args.method === "eth_sendTransaction") {
    const event = eventAfterSend;
    eventAfterSend = null;
    if (event === "disconnect") provider.provider.emit("disconnect", { code: 4900 });
    else provider.provider.emit("accountsChanged", []);
  }
  return result;
};

const app = await loadWebapp({ config: webappConfig({ lenderAddress: LENDER }), rpc, api, provider });
afterAll(() => app.restore());

const el = (id) => app.env.elements.get(id);

/** Chờ handler sự kiện ví (async — có đọc lại `eth_accounts`) chạy xong. */
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const callsSince = () => app.takeCalls().map((raw) => JSON.parse(raw));
const sends = () => callsSince().filter((c) => c.kind === "provider" && c.method === "eth_sendTransaction");
const bundlePost = () => callsSince().find((c) => c.kind === "api" && c.url === "/api/bundle");

async function primeSigning() {
  await app.window.connectWallet();
  await app.window.signIn();
  await app.window.fetchNonce();
  app.setValue("presign-gas-maxfee", "50");
  app.setValue("presign-gas-priority", "1");
  app.window.onGasInputChange();
}

/** Hai mốc cố định cho mọi ca (module chỉ evaluate một lần nên tier được tái sử dụng). */
function primeTiers() {
  if (!el("tier-list").innerHTML.includes("tier-row")) {
    app.window.addPresetTier("100");
    app.window.addPresetTier("250");
  }
  app.window.updateTierAmount(0, "100");
  app.window.updateTierAmount(1, "250");
}

/**
 * Ca nhiễu: ký xong ví bắn event (không mất quyền) ⇒ ví/phiên/stepper phải nguyên vẹn và
 * ký-lưu tiếp ở nonce N+1 phải chạy được NGAY trên trang cũ.
 */
async function runSpurious(event) {
  accountsRevoked = false;
  eventAfterSend = null;
  await primeSigning();
  primeTiers();

  eventAfterSend = event;
  app.takeCalls();
  await app.window.signAllTiers();
  await flush();

  expect(el("wallet-connected").style.display, "sự kiện nhiễu không được ẩn ví").toBe("block");
  expect(app.text("wallet-address")).toBe(LENDER);
  expect(app.env.sessionStorage.getItem("morpho-session-token"), "phiên HMAC không được bị xoá").toBe("test-token");
  expect(app.env.localStorage.getItem("morpho-wallet-account"), "key nhớ ví phải còn để F5 tự khôi phục").toBe(LENDER.toLowerCase());
  expect(app.html("tier-list").match(/✅/g), "sự kiện nhiễu không được cắt vòng ký").toHaveLength(2);
  expect(el("btn-nonce-inc").disabled, "nút + phải bấm được sau sự kiện ví").toBe(false);

  app.window.onNonceStep(1);
  expect(app.text("presign-nonce"), "+ phải thực sự tăng nonce").toBe("12");

  app.takeCalls();
  await app.window.signAllTiers();
  expect(sends().map((c) => c.params?.[0]?.nonce), "rung N+1 ký được ngay").toEqual(["0xc", "0xc"]);

  app.takeCalls();
  await app.window.saveToServer();
  const posted = bundlePost();
  expect(posted, "lưu được ngay trên trang cũ").toBeTruthy();
  expect(posted.body.nonce).toBe(12);
  expect(posted.authorization, "request lưu vẫn mang phiên").toMatch(/^Bearer /);
}

describe("sự kiện ví bắn ngay sau khi ký (nhiễu) — không được phá ví/phiên", () => {
  it("accountsChanged([]) sau khi trả hash", async () => {
    await runSpurious("accounts");
  });

  it("disconnect sau khi trả hash", async () => {
    await runSpurious("disconnect");
  });
});

describe("ví mất quyền THẬT (eth_accounts rỗng)", () => {
  it("khoá ví/nút ký nhưng GIỮ phiên; kết nối lại thì nút + dùng được ngay", async () => {
    accountsRevoked = false;
    eventAfterSend = null;
    await primeSigning();
    const nonce = app.text("presign-nonce");

    accountsRevoked = true;
    provider.provider.emit("accountsChanged", []);
    await flush();

    expect(el("wallet-connected").style.display, "mất quyền thật ⇒ ẩn ví").toBe("none");
    expect(el("btn-sign-all").disabled, "mất quyền thật ⇒ khoá ký").toBe(true);
    expect(app.env.sessionStorage.getItem("morpho-session-token"), "mất ví thật KHÔNG xoá phiên").toBe("test-token");
    expect(app.env.localStorage.getItem("morpho-wallet-account"), "vẫn nhớ ví để F5 tự khôi phục").toBe(LENDER.toLowerCase());

    accountsRevoked = false;
    await app.window.connectWallet();

    expect(app.text("presign-nonce"), "kết nối lại không được đổi nonce đang giữ").toBe(nonce);
    expect(el("btn-nonce-inc").disabled, "kết nối lại phải bấm + được ngay (không cần Lấy Nonce)").toBe(false);
    app.window.onNonceStep(1);
    expect(app.text("presign-nonce")).toBe(String(Number(nonce) + 1));
  });
});

describe("người dùng chủ động bấm Ngắt Kết Nối", () => {
  it("sự kiện ví sau đó không được tự kết nối lại / ghi nhớ lại ví", async () => {
    accountsRevoked = false;
    eventAfterSend = null;
    await primeSigning();
    expect(el("wallet-connected").style.display).toBe("block");

    app.window.disconnectWallet();
    expect(el("wallet-connected").style.display).toBe("none");
    expect(app.env.sessionStorage.getItem("morpho-session-token"), "ngắt chủ động ⇒ xoá phiên").toBeNull();

    // Ví bắn event sau khi đã ngắt: listener phải đã được gỡ, nếu không `eth_accounts` còn tài
    // khoản sẽ "kết nối lại" và đảo ngược lựa chọn của người dùng.
    provider.provider.emit("accountsChanged", []);
    provider.provider.emit("accountsChanged", [LENDER]);
    await flush();

    expect(el("wallet-connected").style.display, "không được tự kết nối lại").toBe("none");
    expect(app.env.localStorage.getItem("morpho-wallet-account"), "ví đã quên thì không ghi nhớ lại").toBeNull();
  });
});
