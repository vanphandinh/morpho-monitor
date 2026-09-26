/**
 * Net TĨNH cho cả một LỚP lỗi, không chỉ một nút (chẩn đoán 2026-09-26).
 *
 * Lỗi đã xảy ra: rule nền `button { display:block; width:100%; padding:14px; margin:8px 0 }` áp cho MỌI
 * `<button>`, kể cả nút phụ nằm TRONG một hàng flex. Nút 🗑 của rung nằm trong `.row` TRẦN nên không
 * rule theo-container nào khớp ⇒ rộng 255px ở rung này, 324px ở rung kia, hàng cao 80px.
 *
 * Bất biến tổng quát được khoá ở đây — suy từ chính stylesheet, KHÔNG viết tay danh sách nút:
 *
 *     nút nằm trong một container `display:flex`  ⇒  KHÔNG được thắng cascade về nút toàn khối
 *                                                    (`width:100%` + padding của `button`)
 *
 * `webapp-btn-remove-sizing.test.mjs` là bản hẹp (ghim đúng nút xoá tier/rung và cả tính ĐỒNG ĐỀU);
 * file này là bản rộng: bất kỳ nút nào, ở bất kỳ module nào sinh ra markup, trong bất kỳ container
 * flex nào. Thêm một nút phụ vào một hàng mà quên rule ⇒ ĐỎ ở đây, không cần ai nhớ.
 *
 * Vì sao vẫn cần job browser (`scripts/ui-checks.mjs`): model này giải cascade trên markup THẬT nhưng
 * KHÔNG có layout thật — nó không biết `min-width`, `flex-basis:auto` với nội dung dài, hay font thật.
 * Nó là lưới NHANH (chạy cả 4 job matrix, ~ms); job browser là lưới SÂU (đo pixel thật).
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeApi, createFakeRpc, loadWebapp } from "./helpers/webapp-harness.mjs";
import {
  bodyMarkupOf,
  contextLabel,
  flexContextOf,
  flexContainerClasses,
  modelLimitError,
  parseCss,
  resolveCascade,
  scanElements,
  styleSheetOf,
} from "./helpers/css-cascade.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "..", "webapp.html"), "utf8");

const rules = parseCss(styleSheetOf(html));
const flexClasses = flexContainerClasses(rules);
const TRACKED = ["width", "padding", "margin", "flex", "align-self"];

/** Padding tối đa còn coi là "nút phụ" — đo được: 2–10px (nút xoá), 12–16px (`.input-group`, preset). */
const MAX_SIDE_PADDING_PX = 16;

const isButton = (node) => node.tag === "button";

// ============================================================
// Nguồn markup: HTML tĩnh + các mảnh do app render (harness)
// ============================================================
const app = await loadWebapp({ rpc: createFakeRpc(), api: createFakeApi() });
afterAll(() => app.restore());

await app.window.connectWallet();
await app.window.signIn();
await app.window.switchTab("presign");
await app.window.fetchExistingBundle(); // switchTab() gọi hàm này KHÔNG await
app.window.addPresetTier("100");
await app.window.switchTab("withdraw");

/**
 * Mọi mảnh markup của app trong một phiên chạy điển hình. Gom theo id để thông báo lỗi chỉ đúng chỗ.
 * Chốt cuối bên dưới đòi hỏi phải thấy nút ở CẢ markup tĩnh lẫn markup render ⇒ không thể xanh vì rỗng.
 */
const renderedFragments = [
  ["presign-existing-info", app.html("presign-existing-info")],
  ["presign-overview-info", app.html("presign-overview-info")],
  ["presign-market-info", app.html("presign-market-info")],
  ["tier-list", app.html("tier-list")],
  ["withdraw-result", app.html("withdraw-result")],
  ["tx-result", app.html("tx-result")],
];
const staticBody = bodyMarkupOf(html);

const fromStatic = scanElements(staticBody, isButton).map((b) => ({ source: "webapp.html (tĩnh)", ...b, h: b }));
const fromRendered = renderedFragments.flatMap(([id, markup]) =>
  scanElements(markup || "", isButton).map((b) => ({ source: `#${id} (render)`, node: b.node, ancestors: b.ancestors, attrs: b.attrs }))
);
const allButtons = [...fromStatic, ...fromRendered];

/** Nút trong hàng flex — đúng lớp cần kiểm; nút toàn khối ngoài hàng (`btn-primary`…) là hợp lệ. */
const inlineButtons = allButtons
  .map((b) => ({ ...b, flexCtx: flexContextOf(b, flexClasses) }))
  .filter((b) => b.flexCtx);

const padSides = (value) => String(value).split(/\s+/).map((v) => {
  const m = v.match(/^(-?[\d.]+)px$/);
  if (!m) throw new Error(`không parse được padding "${value}" — model CSS cần cập nhật`);
  return Number(m[1]);
});

describe("giới hạn của model + chốt chống 'xanh vì không thấy gì'", () => {
  it("stylesheet còn phẳng và không có `!important` (nếu không, model phải được mở rộng)", () => {
    expect(rules.length).toBeGreaterThanOrEqual(40);
    expect(modelLimitError(rules, [...flexClasses])).toBeNull();
  });

  it("quét không bỏ sót nút nào (số nút = số thẻ `<button` trong từng nguồn markup)", () => {
    const countOpen = (markup) => (String(markup).match(/<button\b/g) || []).length;
    expect(fromStatic.length, "markup tĩnh webapp.html").toBe(countOpen(staticBody));
    for (const [id, markup] of renderedFragments) {
      const expected = countOpen(markup || "");
      const got = fromRendered.filter((b) => b.source === `#${id} (render)`).length;
      expect(got, `#${id}: quét ${got} nút nhưng markup có ${expected}`).toBe(expected);
    }
  });

  it("phải quan sát được nút ở CẢ markup tĩnh lẫn markup render, và nút trong hàng flex không rỗng", () => {
    // Fail closed (bài học D10): không quan sát được UI thì KHÔNG được phép xanh.
    expect(fromStatic.length, "không thấy nút nào trong webapp.html").toBeGreaterThanOrEqual(8);
    expect(fromRendered.length, "không thấy nút nào trong markup do app render — UI chưa dựng?").toBeGreaterThanOrEqual(3);
    expect(inlineButtons.length, "không thấy nút nào trong hàng flex — model hoặc markup đã hỏng").toBeGreaterThanOrEqual(4);
    // Ngữ cảnh đã gây lỗi phải nằm trong phạm vi kiểm, và cũng phải có ngữ cảnh KHÁC để lưới là tổng quát.
    const contexts = new Set(inlineButtons.map((b) => b.flexCtx));
    expect([...contexts]).toContain("row");
    expect(contexts.size, `chỉ thấy một ngữ cảnh flex (${[...contexts].join(", ")}) — lưới chưa tổng quát`).toBeGreaterThanOrEqual(2);
  });
});

describe("nút trong hàng flex KHÔNG được rơi về mặc định nút toàn khối", () => {
  it.each(inlineButtons.map((b) => [`${b.source} · [${contextLabel(b)}]`, b]))(
    "%s",
    (_label, btn) => {
      const resolved = resolveCascade(btn, rules, TRACKED);
      const where = `${contextLabel(btn)} trong ${btn.source}`;
      // Đây chính là bất biến đã vỡ: `width:100%` của `button` cộng `justify-content:space-between`
      // của hàng ⇒ nút giãn theo bề rộng hàng, và mỗi hàng một khác.
      expect(resolved.width, `nút trong hàng flex bị giãn toàn khối — ${where}`).not.toBe("100%");
      expect(resolved.width, `nút trong hàng flex phải là cỡ nội dung (width:auto) — ${where}`).toBe("auto");
      const sides = padSides(resolved.padding);
      expect(
        Math.max(...sides),
        `padding ${resolved.padding} là của nút toàn khối, không phải nút phụ — ${where}`
      ).toBeLessThanOrEqual(MAX_SIDE_PADDING_PX);
      // CHỦ Ý không kiểm `margin` ở đây: `margin:8px 0` mặc định là VÔ HẠI trong hàng có
      // `align-items:center` (`.input-group`, `.tier-row`) hoặc hàng wrap (`.preset-buttons`), và chỉ
      // phá khi hàng giãn theo nút (`.row` trần, `align-items` mặc định = stretch). Ca hẹp đó nằm ở
      // `webapp-btn-remove-sizing.test.mjs` (khẳng định `margin === "0"` + cao hàng ≤ 48px thật ở job
      // browser), nên ở đây không nới thành một luật chung dễ đỏ giả.
    }
  );
});
