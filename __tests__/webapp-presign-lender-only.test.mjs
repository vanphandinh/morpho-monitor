/**
 * Presign chỉ ký được từ CHÍNH ví lender (2026-10-30).
 *
 * Vì sao: calldata `withdraw()` ghi `onBehalf = lender` và `receiver = currentAccount`. Ký từ ví
 * khác thì proxy không capture (`from !== lender`) — chữ ký không bao giờ vào bundle; tệ hơn, nếu
 * lender đã authorize account đó trên Morpho thì lệnh rút sẽ gửi tiền về SAI địa chỉ. Trước fix,
 * app vẫn mở popup ký và chỉ thất bại ở bước capture, không nói gì về nguyên nhân.
 *
 * Ca dương (chuyển ví về đúng lender) nằm cuối file: cổng chặn không được chặn nhầm.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeProvider, createFakeRpc, loadWebapp, webappConfig } from "./helpers/webapp-harness.mjs";

const LENDER = "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const provider = createFakeProvider({ account: OTHER });
const app = await loadWebapp({
  config: webappConfig({ lenderAddress: LENDER }),
  rpc: createFakeRpc(),
  api: createFakeApi(),
  provider,
});

afterAll(() => app.restore());

const sends = () => app.takeCalls().map((raw) => JSON.parse(raw))
  .filter((c) => c.kind === "provider" && c.method === "eth_sendTransaction");

await app.window.connectWallet(); // ví đang kết nối = OTHER, KHÔNG phải lender
await app.window.fetchNonce();    // sàn on-chain = 11
app.window.addPresetTier("100");
app.window.addPresetTier("250");
app.setValue("presign-gas-maxfee", "50");
app.setValue("presign-gas-priority", "1");
app.window.onGasInputChange();

describe("ví đang kết nối không phải lender", () => {
  it("không ký tier nào; banner nêu cả hai địa chỉ và cách sửa", async () => {
    app.takeCalls();
    await app.window.signAllTiers();

    expect(sends().length, "không được mở popup ký từ ví không phải lender").toBe(0);

    const banner = app.html("presign-result");
    expect(banner).toContain("không phải địa chỉ lender");
    expect(banner, "phải nêu ví đang kết nối").toContain(OTHER);
    expect(banner, "phải nêu địa chỉ lender").toContain(LENDER);
    expect(banner, "phải chỉ cách sửa").toContain("Chuyển ví");

    expect(app.html("tier-list"), "không được có ✅ giả").not.toContain("✅");
  });

  it("không ký rút toàn bộ shares", async () => {
    app.takeCalls();
    await app.window.signWithdrawAll();

    expect(sends().length, "không được mở popup ký từ ví không phải lender").toBe(0);
    expect(app.html("presign-result")).toContain("không phải địa chỉ lender");
  });

  it("chuyển ví về đúng lender ⇒ ký bình thường (cổng không chặn nhầm)", async () => {
    provider.provider.emit("accountsChanged", [LENDER]);
    app.takeCalls();

    await app.window.signAllTiers();

    expect(sends().length, "đúng ví lender ⇒ ký đủ 2 mốc").toBe(2);
    expect(app.text("progress-text")).toContain("Đã ký thành công 2/2");
  });
});
