/**
 * Chẩn đoán 2026-09-26 — “nút xóa các tier quá to và không đồng đều” (người dùng báo, kèm ảnh).
 *
 * Triệu chứng: nút 🗑 (xoá CẢ RUNG) cao bằng nửa hàng và rộng 255px ở rung 2553 nhưng 324px ở rung
 * 2554 (viewport 644px, đo bằng browser thật), trong khi nút ✕ (xoá MỘT tier) chỉ 29×22px.
 *
 * Nguyên nhân đã xác nhận: rule nền `button { display:block; width:100%; padding:14px; margin:8px 0 }`
 * trong `webapp.html` áp cho MỌI `<button>` — kể cả nút nhỏ nằm TRONG một hàng. Hai rule bù lại chỉ
 * có theo ngữ cảnh container (`.tier-row .btn-remove`, `.bundle-tier-row .btn-remove`, đặc tả 0-2-0);
 * nút 🗑 của rung nằm trong `.row` TRẦN nên KHÔNG rule nào khớp ⇒ rơi về mặc định ⇒ bề rộng co giãn
 * theo bề rộng hàng (`.row { display:flex; justify-content:space-between }`) và vì mỗi rung có độ dài
 * nhãn khác nhau nên hai nút lệch nhau.
 *
 * Seam: DOM giả của harness KHÔNG có layout (không tính được `getBoundingClientRect()`), nên cách duy
 * nhất chạm ĐÚNG cơ chế gây lỗi mà không thêm phụ thuộc browser là tự giải CASCADE của chính
 * `webapp.html` (đặc tả + thứ tự khai báo) trên ĐÚNG ngữ cảnh container mà markup THẬT
 * (`renderPresignBundle` qua harness) sinh ra — xem `helpers/css-cascade.mjs`. Khẳng định khi đó là
 * “nút thắng cascade phải cỡ inline nhỏ, không phải mặc định `width:100%`/`padding:14px`”.
 *
 * Đỏ-trước (chạy trên cây trước fix, CÙNG file này): ngữ cảnh `.row` trần giải ra `width:100%`,
 * `padding:14px`, `margin:8px 0`, và `flex`/`align-self` KHÔNG có ⇒ 4 khẳng định đỏ, rồi khẳng định
 * “đồng đều” đỏ theo (hai rung ra hai đặc tính khác nhau).
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeApi, createFakeRpc, loadWebapp } from "./helpers/webapp-harness.mjs";
import {
  contextLabel,
  flexContextOf,
  flexContainerClasses,
  modelLimitError,
  parseCss,
  resolveCascade,
  scanElements,
  specificity,
  styleSheetOf,
} from "./helpers/css-cascade.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "..", "webapp.html"), "utf8");

const rules = parseCss(styleSheetOf(html));
const flexClasses = flexContainerClasses(rules);
const TRACKED = ["width", "padding", "margin", "flex", "align-self", "font-size", "line-height"];

// ============================================================
// Dựng markup thật qua harness (MỘT lần nạp webapp mỗi tiến trình)
// ============================================================
const app = await loadWebapp({ rpc: createFakeRpc(), api: createFakeApi() });
afterAll(() => app.restore());

await app.window.connectWallet();
await app.window.signIn();
await app.window.switchTab("presign");
// `switchTab` gọi `fetchExistingBundle()` KHÔNG await — phải chờ chính nó, nếu không markup còn rỗng.
await app.window.fetchExistingBundle();
// Thêm một tier đang soạn để phủ ngữ cảnh thứ ba (`.tier-row`, nút ✕ của danh sách tier).
app.window.addPresetTier("100");

const isRemoveButton = (node) => node.tag === "button" && node.classes.includes("btn-remove");
/** Nút xoá trong bậc thang bundle (`.row` trần + `.row.bundle-tier-row`). */
const ladderButtons = scanElements(app.html("presign-existing-info"), isRemoveButton);
/** Nút xoá trong danh sách tier đang soạn (`.tier-row`). */
const tierButtons = scanElements(app.html("tier-list"), isRemoveButton);

/** Các mặt số phải giống nhau giữa hai nút thì mới gọi là “đồng đều”. */
function sizingSignature(resolved) {
  return JSON.stringify({
    width: resolved.width,
    padding: resolved.padding,
    margin: resolved.margin,
    flex: resolved.flex,
    alignSelf: resolved["align-self"],
    fontSize: resolved["font-size"],
  });
}

const padSides = (value) => String(value).split(/\s+/).map((v) => {
  const mm = v.match(/^(-?[\d.]+)px$/);
  if (!mm) throw new Error(`không parse được padding "${value}" — model CSS cần cập nhật`);
  return Number(mm[1]);
});

const hasFlexAncestor = (btn, cls) => btn.ancestors.some((a) => a.classes.includes(cls));

describe("giới hạn của model CSS trong test (khoá giả định 'stylesheet phẳng')", () => {
  it("không có at-rule nào chạm `.btn-remove`/`.row` (nếu có, phải mở rộng parser thay vì để test xanh giả)", () => {
    expect(rules.length).toBeGreaterThanOrEqual(40); // chốt chống regex hỏng (đo được: 61)
    expect(modelLimitError(rules, ["btn-remove", "row", "tier-row", "bundle-tier-row"])).toBeNull();
  });

  it("quét markup không bỏ sót nút nào (số nút quét được = số lần xuất hiện `btn-remove`)", () => {
    for (const [label, markup, found] of [
      ["presign-existing-info", app.html("presign-existing-info"), ladderButtons],
      ["tier-list", app.html("tier-list"), tierButtons],
    ]) {
      const occurrences = (markup.match(/class="[^"]*btn-remove/g) || []).length;
      expect(found.length, `${label}: quét ${found.length} nút nhưng markup có ${occurrences}`).toBe(occurrences);
    }
    expect(ladderButtons.length, "bậc thang phải có nút xoá để đo").toBeGreaterThanOrEqual(3);
  });

  it("phủ CẢ BA ngữ cảnh: `.row` trần (🗑), `.row.bundle-tier-row` (✕ trong bậc thang), `.tier-row` (✕ khi soạn)", () => {
    expect(flexClasses.size, "suy `display:flex` từ CSS không ra class nào — model hỏng").toBeGreaterThanOrEqual(3);
    // `.bundle-tier-row` KHÔNG tự khai `display:flex` — nó là modifier của `.row` (markup phát
    // `class="row bundle-tier-row"`); nên chỉ đòi những container thật sự khai flex.
    for (const cls of ["row", "tier-row", "preset-buttons"]) {
      expect([...flexClasses], `stylesheet phải khai .${cls} là flex container`).toContain(cls);
    }
    expect(ladderButtons.filter((b) => hasFlexAncestor(b, "row") && !hasFlexAncestor(b, "bundle-tier-row")).length, "thiếu ngữ cảnh 🗑 trong `.row` trần").toBeGreaterThanOrEqual(1);
    expect(ladderButtons.filter((b) => hasFlexAncestor(b, "bundle-tier-row")).length, "thiếu ngữ cảnh ✕ trong `.bundle-tier-row`").toBeGreaterThanOrEqual(2);
    expect(tierButtons.filter((b) => hasFlexAncestor(b, "tier-row")).length, "thiếu ngữ cảnh ✕ trong `.tier-row`").toBeGreaterThanOrEqual(1);
  });
});

describe("nút xoá tier/rung phải là nút inline nhỏ, KHÔNG rơi về mặc định `button`", () => {
  const cases = [
    ...ladderButtons.map((b) => ["bậc thang bundle", b]),
    ...tierButtons.map((b) => ["tier đang soạn", b]),
  ];

  it.each(cases)("%s — không bị giãn theo bề rộng hàng", (_label, btn) => {
    const ctx = contextLabel(btn);
    const resolved = resolveCascade(btn, rules, TRACKED);

    // Đúng triệu chứng người dùng thấy: mặc định `button` cho `width:100%` + `padding:14px`.
    expect(resolved.width, `width thắng cascade trong [${ctx}]`).toBe("auto");
    expect(resolved.width).not.toBe("100%");
    const sides = padSides(resolved.padding);
    expect(Math.max(...sides), `padding ${resolved.padding} quá dày trong [${ctx}]`).toBeLessThanOrEqual(12);
    // `margin:8px 0` của `button` là thứ làm hàng cao 80px: nút phải bám lại, không đẩy hàng.
    expect(resolved.margin, `margin thắng cascade trong [${ctx}]`).toBe("0");
    expect(resolved.flex, `flex:0 0 auto để không co/giãn theo hàng — [${ctx}]`).toBe("0 0 auto");
    // Hàng có thể cao hơn nút (nhãn nonce/trạng thái xuống dòng) ⇒ nút phải tự căn giữa.
    expect(resolved["align-self"], `align-self:center trong [${ctx}]`).toBe("center");
  });

  it("🗑 và ✕ trong cùng bậc thang phải ĐỒNG ĐỀU (cùng mặt số), không lệch nhau theo rung", () => {
    const signatures = ladderButtons.map((btn) => sizingSignature(resolveCascade(btn, rules, TRACKED)));
    // Đỏ-trước: rung 2553 rộng 255px còn rung 2554 rộng 324px vì bề rộng `.value` khác nhau.
    expect(new Set(signatures).size, `các mặt số phải giống nhau, đo được: ${JSON.stringify([...new Set(signatures)])}`).toBe(1);
  });

  it("ngữ cảnh flex của mỗi nút được suy ra từ CSS, không viết tay (không nút nào ngoài hàng flex)", () => {
    for (const btn of [...ladderButtons, ...tierButtons]) {
      expect(flexContextOf(btn, flexClasses), `nút trong [${contextLabel(btn)}] phải nằm trong hàng flex`).toBeTruthy();
    }
    // `specificity()` phải thật sự phân biệt được `.btn-remove` với `.bundle-tier-row .btn-remove`,
    // nếu không thì toàn bộ phép giải cascade ở trên là vô nghĩa.
    expect(specificity(".btn-remove")).toEqual([0, 1, 0]);
    expect(specificity(".bundle-tier-row .btn-remove")).toEqual([0, 2, 0]);
    expect(specificity("button")).toEqual([0, 0, 1]);
  });
});
