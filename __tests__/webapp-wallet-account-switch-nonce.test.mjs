/**
 * Chẩn đoán 2026-11-15 (tiếp) — "đổi tài khoản ví, nonce và sàn của tài khoản cũ vẫn còn nên nút +
 * mở với nonce sai", rồi "các tier vẫn hiện ✅ dù nonce đã bị xoá".
 *
 * Nonce là của MỘT tài khoản. `state.presignedNonce`/`onChainPendingNonce` chỉ thuộc tài khoản đã
 * bấm "Lấy Nonce"; sau khi đổi ví, giữ chúng làm nút `+` mở ở nonce của tài khoản trước ⇒ chữ ký
 * mới rơi vào nonce sai/đã chết. Đổi tài khoản phải xoá nonce + sàn và khoá stepper, buộc lấy lại.
 *
 * Dấu ✅ cũng phải đổi theo: chữ ký đang ✅ được ký ở nonce của tài khoản CŨ. Không xoá dấu thì
 * người dùng tưởng "ký xong rồi, chỉ việc Lưu" trong khi bundle không có nonce để gửi — nên tier về
 * ⬜, nút Lưu đóng, kèm banner nêu lý do (cùng cơ chế với ca nonce/gas đổi). Banner phải hiện CẢ khi
 * chưa ký gì (không có ✅ để hạ), nếu không nonce biến mất mà không ai giải thích.
 *
 * Hai điều KHÔNG được làm:
 *   - sự kiện ví với CHÍNH tài khoản đó (khác hoa/thường) không được xoá nonce/✅ người dùng vừa lấy;
 *   - ngắt kết nối rồi kết nối lại bằng tài khoản khác vẫn phải xoá (lúc đó `state.currentAccount`
 *     đã về null, nên "chủ sở hữu nonce" phải được nhớ riêng — `nonceOwnerAccount`).
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeProvider, createFakeRpc, loadWebapp, webappConfig } from "./helpers/webapp-harness.mjs";

// Địa chỉ có chữ hex + checksum hợp lệ (địa chỉ toàn số không phân biệt được hoa/thường).
const LENDER = "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3";
const OTHER = "0x" + "9".repeat(40);

const provider = createFakeProvider({ account: LENDER });
/** Tài khoản ví "đang chọn" — đổi được giữa các bước để mô phỏng người dùng chuyển ví. */
let activeAccount = LENDER;
const baseRequest = provider.provider.request;
provider.provider.request = async (args) => {
  if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") return [activeAccount];
  return baseRequest(args);
};

const app = await loadWebapp({
  config: webappConfig({ lenderAddress: LENDER }),
  rpc: createFakeRpc(),
  api: createFakeApi(),
  provider,
});
afterAll(() => app.restore());

const el = (id) => app.env.elements.get(id);
const checkmarks = () => app.html("tier-list").match(/✅/g) ?? [];

describe("đổi tài khoản ví ⇒ nonce/sàn và dấu ✅ của tài khoản cũ bị xoá", () => {
  it("accountsChanged sang ví khác: nonce về “—”, stepper khoá, tier hết ✅, Lưu đóng", async () => {
    await app.window.connectWallet();
    await app.window.fetchNonce();
    expect(app.text("presign-nonce")).toBe("11");
    expect(el("btn-nonce-inc").disabled).toBe(false);

    // Ký sẵn 1 mốc: ✅ + nút Lưu mở — đây là trạng thái bị "nói dối" sau khi đổi ví.
    app.window.addPresetTier("100");
    app.setValue("presign-gas-maxfee", "50");
    app.setValue("presign-gas-priority", "1");
    app.window.onGasInputChange();
    await app.window.signAllTiers();
    expect(checkmarks(), "ký xong ⇒ 1 dấu ✅").toHaveLength(1);
    expect(el("btn-save-server").disabled, "ký xong ⇒ Lưu mở").toBe(false);

    activeAccount = OTHER;
    provider.provider.emit("accountsChanged", [OTHER]);

    expect(app.text("presign-nonce"), "nonce tài khoản cũ phải bị xoá").toBe("—");
    expect(el("btn-nonce-inc").disabled, "stepper phải khoá cho tới khi lấy nonce mới").toBe(true);
    expect(checkmarks(), "chữ ký ở nonce tài khoản cũ không được giữ ✅").toHaveLength(0);
    expect(app.html("tier-list"), "phải về ⬜ chưa ký").toContain("⬜");
    expect(el("btn-save-server").disabled, "không nonce ⇒ không mời Lưu").toBe(true);
    const banner = app.html("presign-result");
    expect(banner, "phải nói rõ vì sao mất ✅/nonce").toContain("đổi tài khoản ví");
    expect(banner, "phải chỉ đường sửa").toContain("Lấy Nonce");

    // Quay lại đúng ví lender: nonce cũ KHÔNG được hồi sinh, ✅ cũng không.
    activeAccount = LENDER;
    provider.provider.emit("accountsChanged", [LENDER]);
    expect(app.text("presign-nonce")).toBe("—");
    expect(el("btn-nonce-inc").disabled).toBe(true);
    expect(checkmarks()).toHaveLength(0);

    // Lấy lại nonce: vẫn chưa có ✅ (chữ ký đã bị xoá) ⇒ phải ký lại mới lưu được.
    await app.window.fetchNonce();
    expect(app.text("presign-nonce")).toBe("11");
    expect(el("btn-nonce-inc").disabled).toBe(false);
    expect(checkmarks()).toHaveLength(0);
    expect(el("btn-save-server").disabled, "chưa ký lại ⇒ Lưu vẫn đóng").toBe(true);

    await app.window.signAllTiers();
    expect(checkmarks(), "ký lại ⇒ ✅ trở lại").toHaveLength(1);
    expect(el("btn-save-server").disabled, "có chữ ký sống ⇒ Lưu mở lại").toBe(false);
  });

  it("accountsChanged với CHÍNH tài khoản đó (khác hoa/thường) không xoá nonce lẫn ✅", async () => {
    provider.provider.emit("accountsChanged", [LENDER.toLowerCase()]);
    expect(app.text("presign-nonce"), "sự kiện không đổi tài khoản không được xoá nonce").toBe("11");
    expect(el("btn-nonce-inc").disabled).toBe(false);
    expect(checkmarks(), "cùng tài khoản ⇒ giữ nguyên ✅").toHaveLength(1);
    expect(el("btn-save-server").disabled, "chữ ký còn sống ⇒ Lưu vẫn mở").toBe(false);
  });

  it("ngắt chủ động rồi kết nối bằng tài khoản khác: cũng phải xoá nonce và ✅", async () => {
    app.window.disconnectWallet();
    activeAccount = OTHER;
    await app.window.connectWallet();

    expect(app.text("presign-nonce"), "nonce của tài khoản trước không được sống sót").toBe("—");
    expect(el("btn-nonce-inc").disabled).toBe(true);
    expect(checkmarks(), "chữ ký của tài khoản trước không được sống sót").toHaveLength(0);
    expect(el("btn-save-server").disabled).toBe(true);
  });

  it("đổi ví khi CHƯA ký gì: nonce vẫn bị xoá và phải nói vì sao", async () => {
    await app.window.fetchNonce();
    expect(app.text("presign-nonce")).toBe("11");
    expect(checkmarks(), "ca này chưa ký gì (không có chữ ký để invalidate)").toHaveLength(0);
    // Xoá banner cũ để khẳng định dưới đây là thông điệp MỚI, không phải di vật của ca trước.
    app.env.elements.get("presign-result").innerHTML = "";

    activeAccount = LENDER;
    provider.provider.emit("accountsChanged", [LENDER]);

    expect(app.text("presign-nonce")).toBe("—");
    expect(el("btn-nonce-inc").disabled).toBe(true);
    expect(app.html("presign-result"), "nonce biến mất mà im lặng là chỗ dễ hiểu nhầm")
      .toContain("đổi tài khoản ví");
  });
});
