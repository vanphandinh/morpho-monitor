/**
 * APY khi KHÔNG đọc được `rateAtTarget` — IRM không phải AdaptiveCurve, RPC chặn `eth_call`, hoặc
 * contract đổi ABI. Hành vi bắt buộc: card nói "N/A", KHÔNG được bịa "0.00%" (một market lành vẫn
 * có lãi suất khác 0, nên số 0 là thông tin sai), và phần còn lại của trang phải tải bình thường.
 *
 * Đây là nhánh `.catch(() => null)` trong `fetchAllData` — nhánh dễ bị "dọn" mất nhất khi refactor,
 * vì nó chỉ chạy lúc mọi thứ khác đều ổn. File riêng (không gộp vào `webapp-apy.test.mjs`) vì
 * `loadWebapp` import `webapp-app.mjs` một lần cho mỗi module graph: hai lần load trong cùng file
 * sẽ dùng lại module đã cache và không chạy lại `init()`.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createFakeApi, createFakeRpc, loadWebapp } from "./helpers/webapp-harness.mjs";

// `rateAtTarget: null` ⇒ harness trả "0x" cho riêng `rateAtTarget`, các lời gọi khác vẫn bình thường.
const app = await loadWebapp({ rpc: createFakeRpc({ rateAtTarget: null }), api: createFakeApi() });
afterAll(() => app.restore());

/** Giá trị của dòng "Supply APY" trong `innerHTML` của một card. */
const apyOf = (id) => /Supply APY<\/span><span class="value">([^<]*)/.exec(app.html(id))?.[1];

describe("webapp: thiếu rateAtTarget ⇒ N/A, không phải 0%", () => {
  it("card Tổng quan nói N/A", () => {
    expect(apyOf("market-info")).toBe("N/A");
  });

  it("card ký sẵn nói cùng điều, không lệch card kia", () => {
    expect(apyOf("presign-market-info")).toBe(apyOf("market-info"));
  });

  it("mỗi card có đúng một dòng Supply APY, phần còn lại vẫn tải", () => {
    for (const id of ["market-info", "presign-market-info"]) {
      const html = app.html(id);
      expect((html.match(/Supply APY/g) ?? []).length).toBe(1);
      expect(html).toContain("Utilization");
      expect(html).toContain("Liquidity");
    }
    // Dữ liệu market vẫn về đủ: utilization của fixture là 400/1000 = 40%.
    expect(app.html("market-info")).toContain("40.00%");
  });
});
