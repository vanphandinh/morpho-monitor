/**
 * Chẩn đoán 2026-10-30 — "Lỗi tier 2: Address \"null\" is invalid" khi ví đổi trạng thái giữa lượt ký.
 *
 * Triệu chứng người dùng: ký nhiều mốc tiền custom trên MetaMask; mốc đầu ký xong, mốc thứ hai
 * báo `Address "null" is invalid. - Address must be a hex value of 20 bytes... (viem@2.53.1)`.
 *
 * Cơ chế: `signAllTiers()` đọc `state.currentAccount` Ở MỖI vòng lặp. Nếu ví phát
 * `accountsChanged([])` / `disconnect` ngay sau khi trả hash cho mốc đầu (MetaMask làm vậy khi
 * mất quyền tài khoản hoặc mất RPC của ví), `disconnectWallet()` đặt `state.currentAccount = null`.
 * Vòng sau `encodeFunctionData` nhận `receiver = null` ⇒ viem ném `InvalidAddressError` với chữ
 * "null" — không hề nói rằng ví đã ngắt kết nối, và người dùng không biết phải làm gì.
 *
 * Đỏ-trước (cây trước fix): tiến trình ký vẫn chạy tiếp sau khi ví ngắt, mốc 2 nhận đúng chuỗi
 * viem "Address \"null\" is invalid" và nút Ký được bật lại dù `walletClient` đã là null.
 * Ca B (đổi tài khoản) cùng hình dạng: mốc sau sẽ ký từ/người nhận là tài khoản MỚI — chữ ký
 * không thể capture (proxy chỉ nhận `from === lender`) và tiền sẽ đi sai người nhận.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeProvider, createFakeRpc, loadWebapp, webappConfig } from "./helpers/webapp-harness.mjs";

// Địa chỉ lender có CHỮ hex và checksum hợp lệ — địa chỉ toàn số của harness không phân biệt được
// phép so sánh hoa/thường (ca C ghim đúng chỗ đó).
const LENDER = "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3";

const rpc = createFakeRpc();
const api = createFakeApi();
const provider = createFakeProvider({ account: LENDER });

/**
 * Ví "đổi trạng thái" ngay sau khi trả hash cho giao dịch kế tiếp — đúng hình dạng sự cố:
 * mốc đầu ✅, rồi event ví bắn ra ⇒ `disconnectWallet()` / đổi `currentAccount` giữa vòng lặp ký.
 * `nextEvent = null` ⇒ ví bình thường.
 */
let nextEvent = { type: "disconnect" };
const baseRequest = provider.provider.request;
provider.provider.request = async (args) => {
  const result = await baseRequest(args);
  if (nextEvent && args.method === "eth_sendTransaction") {
    const event = nextEvent;
    nextEvent = null;
    if (event.type === "disconnect") provider.provider.emit("accountsChanged", []);
    else provider.provider.emit("accountsChanged", [event.account]);
  }
  return result;
};

const app = await loadWebapp({ config: webappConfig({ lenderAddress: LENDER }), rpc, api, provider });

afterAll(() => app.restore());

const sends = () => app.takeCalls().map((raw) => JSON.parse(raw))
  .filter((c) => c.kind === "provider" && c.method === "eth_sendTransaction");

async function primeSigning() {
  await app.window.connectWallet();
  await app.window.signIn();
  await app.window.fetchNonce(); // sàn on-chain = 11
  app.setValue("presign-gas-maxfee", "50");
  app.setValue("presign-gas-priority", "1");
  app.window.onGasInputChange();
}

await primeSigning();
app.window.addPresetTier("100");
app.window.addPresetTier("250");

describe("ví mất kết nối giữa lượt ký nhiều tier", () => {
  it("dừng ngay với thông báo đọc được, không để lộ lỗi địa chỉ null của viem", async () => {
    app.takeCalls();
    await app.window.signAllTiers();

    expect(sends().length, "mốc sau khi mất ví KHÔNG được ký tiếp").toBe(1);

    const progress = app.text("progress-text");
    expect(progress, "không được để lộ lỗi viem 'Address \"null\" is invalid'").not.toContain("is invalid");
    expect(progress, "phải nói rõ ví đã ngắt kết nối").toContain("ngắt kết nối");

    expect(app.html("presign-result")).toContain("ngắt kết nối");

    // Mốc chưa ký phải là ❌ kèm lý do thật, không phải ✅ giả.
    expect(app.html("tier-list")).toContain("❌");

    // Không có ví thì nút Ký phải khoá lại — không mời bấm một lượt chắc chắn lỗi.
    expect(app.env.elements.get("btn-sign-all").disabled, "nút Ký phải khoá khi đã mất ví").toBe(true);
  });
});

describe("ví đổi tài khoản giữa lượt ký nhiều tier", () => {
  it("dừng trước khi ký mốc tiếp theo bằng tài khoản khác", async () => {
    // Kết nối lại (ca A đã ngắt) rồi chuẩn bị một lượt ký mới với 3 mốc.
    await primeSigning();
    app.window.updateTierAmount(0, "100");
    app.window.updateTierAmount(1, "250");
    app.window.addPresetTier("500");

    const OTHER = "0x" + "9".repeat(40);
    nextEvent = { type: "switch", account: OTHER };
    app.takeCalls();

    await app.window.signAllTiers();

    expect(sends().length, "đổi tài khoản ở mốc đầu ⇒ KHÔNG ký mốc tiếp theo").toBe(1);
    const progress = app.text("progress-text");
    expect(progress).not.toContain("is invalid");
    expect(progress, "phải nêu tài khoản mới").toContain("đổi sang");
    expect(progress).toContain(OTHER);
    expect(app.html("presign-result")).toContain("đổi sang");
  });
});

describe("ví phát accountsChanged với CHÍNH tài khoản đó (khác hoa/thường)", () => {
  it("không dừng oan — ký đủ các mốc như bình thường", async () => {
    // Kết nối lại sau ca B rồi chuẩn bị lại 3 mốc.
    await primeSigning();
    app.window.updateTierAmount(0, "100");
    app.window.updateTierAmount(1, "250");
    app.window.updateTierAmount(2, "500");

    // MetaMask/ví có thể trả cùng địa chỉ ở dạng lowercase — KHÔNG được coi là "đổi tài khoản".
    nextEvent = { type: "switch", account: LENDER.toLowerCase() };
    app.takeCalls();

    await app.window.signAllTiers();

    expect(sends().length, "cùng tài khoản (khác case) ⇒ ký đủ 3 mốc").toBe(3);
    const progress = app.text("progress-text");
    expect(progress).not.toContain("đổi sang");
    expect(progress).toContain("Đã ký thành công 3/3");
  });
});
