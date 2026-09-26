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
 * (`renderPresignBundle` qua harness) sinh ra. Khẳng định khi đó là “nút thắng cascade phải cỡ inline
 * nhỏ, không phải mặc định `width:100%`/`padding:14px`” — một ngữ cảnh MỚI không có rule tương ứng sẽ
 * làm đỏ test này, đúng lớp lỗi đã xảy ra.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "..", "webapp.html"), "utf8");

// ============================================================
// Giải CSS: `<style>` → rule phẳng (selector + khai báo + thứ tự)
// ============================================================
/**
 * Cắt stylesheet thành rule phẳng, đếm ngoặc để nuốt trọn at-rule dạng lồng (`@keyframes`).
 * Model này CHỈ đúng cho CSS không lồng của `webapp.html`; hai test “giới hạn model” bên dưới khoá
 * giả định đó lại để ngày ai thêm `@media`/at-rule chạm `.btn-remove` thì phải đỏ, không im lặng.
 */
function parseCss(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open === -1) break;
    const selector = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") depth -= 1;
      j += 1;
    }
    rules.push({ selector, body: src.slice(open + 1, j - 1), order: rules.length });
    i = j;
  }
  return rules;
}

function declarations(body) {
  const out = {};
  for (const chunk of body.split(";")) {
    const at = chunk.indexOf(":");
    if (at === -1) continue;
    out[chunk.slice(0, at).trim().toLowerCase()] = chunk.slice(at + 1).trim();
  }
  return out;
}

/** Đặc tả [id, class/attr/pseudo, element] — đủ cho các selector của file này. */
function specificity(selector) {
  let ids = 0;
  let classes = 0;
  let tags = 0;
  for (const compound of selector.trim().split(/\s+/)) {
    ids += (compound.match(/#[\w-]+/g) || []).length;
    classes += (compound.match(/\.[\w-]+/g) || []).length;
    classes += (compound.match(/\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g) || []).length;
    if (/^[a-zA-Z]/.test(compound)) tags += 1;
  }
  return [ids, classes, tags];
}

function cmpRank(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return a[3] - b[3];
}

/** Một compound khớp element giả `{tag, classes}`; pseudo-chưa mô hình hoá ⇒ coi như KHÔNG khớp. */
function matchesCompound(compound, node) {
  if (compound.includes(":")) return false;
  const tag = compound.match(/^([a-zA-Z][\w-]*)/);
  if (tag && tag[1].toLowerCase() !== node.tag) return false;
  for (const [, cls] of compound.matchAll(/\.([\w-]+)/g)) {
    if (!node.classes.includes(cls)) return false;
  }
  return true;
}

function matches(selector, node, ancestors) {
  if (/[>+~]/.test(selector)) return false;
  const parts = selector.trim().split(/\s+/);
  if (!matchesCompound(parts[parts.length - 1], node)) return false;
  let cursor = ancestors.length - 1;
  for (let p = parts.length - 2; p >= 0; p -= 1) {
    let found = false;
    while (cursor >= 0) {
      if (matchesCompound(parts[p], ancestors[cursor])) {
        found = true;
        cursor -= 1;
        break;
      }
      cursor -= 1;
    }
    if (!found) return false;
  }
  return true;
}

/** Giá trị thắng cascade cho `props`, trên `node` với chuỗi tổ tiên `ancestors`. */
function resolveCascade(node, ancestors, rules, props) {
  const winners = {};
  for (const rule of rules) {
    const decls = declarations(rule.body);
    for (const raw of rule.selector.split(",")) {
      const selector = raw.trim();
      if (!selector || !matches(selector, node, ancestors)) continue;
      const rank = [...specificity(selector), rule.order];
      for (const prop of props) {
        if (!(prop in decls)) continue;
        const prev = winners[prop];
        if (!prev || cmpRank(rank, prev.rank) >= 0) winners[prop] = { value: decls[prop], rank };
      }
    }
  }
  return Object.fromEntries(Object.entries(winners).map(([prop, w]) => [prop, w.value]));
}

// ============================================================
// Đọc markup THẬT: quét thẻ, giữ chồng tổ tiên cho mỗi `.btn-remove`
// ============================================================
const VOID_TAGS = new Set(["br", "hr", "input", "img", "meta", "link", "source", "col", "area", "base", "embed", "track", "wbr"]);

/** Mọi `.btn-remove` trong markup kèm chuỗi tổ tiên thật (tag + class của từng tổ tiên). */
function buttonsWithContext(markup) {
  const out = [];
  const stack = [];
  for (const m of String(markup).matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, closing, tag, attrs] = m;
    const name = tag.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const classAttr = attrs.match(/\bclass="([^"]*)"/);
    const classes = classAttr ? classAttr[1].split(/\s+/).filter(Boolean) : [];
    const node = { tag: name, classes };
    if (classes.includes("btn-remove")) out.push({ node, ancestors: stack.slice(), attrs });
    if (!attrs.trimEnd().endsWith("/") && !VOID_TAGS.has(name)) stack.push(node);
  }
  return out;
}

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

/** Nút xoá trong bậc thang bundle (`.row` trần + `.row.bundle-tier-row`). */
const ladderButtons = buttonsWithContext(app.html("presign-existing-info"));
/** Nút xoá trong danh sách tier đang soạn (`.tier-row`). */
const tierButtons = buttonsWithContext(app.html("tier-list"));

const styleBody = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
const rules = parseCss(styleBody);

const TRACKED = ["width", "padding", "margin", "flex", "align-self", "font-size", "line-height"];

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

const hasAncestorClass = (btn, cls, forbidden = null) => btn.ancestors.some(
  (a) => a.classes.includes(cls) && (!forbidden || !a.classes.includes(forbidden))
);

describe("giới hạn của model CSS trong test (khoá giả định 'stylesheet phẳng')", () => {
  it("không có at-rule nào chạm `.btn-remove` (nếu có, phải mở rộng parser thay vì để test xanh giả)", () => {
    expect(rules.length).toBeGreaterThanOrEqual(40); // chốt chống regex hỏng (đo được: 61)
    const atRules = rules.filter((r) => r.selector.trim().startsWith("@"));
    expect(atRules.map((r) => r.body).join("\n")).not.toContain("btn-remove");
    expect(rules.filter((r) => /^@(media|supports|layer|container)/.test(r.selector.trim()))).toEqual([]);
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
    expect(ladderButtons.filter((b) => hasAncestorClass(b, "row", "bundle-tier-row")).length, "thiếu ngữ cảnh 🗑 trong `.row` trần").toBeGreaterThanOrEqual(1);
    expect(ladderButtons.filter((b) => hasAncestorClass(b, "bundle-tier-row")).length, "thiếu ngữ cảnh ✕ trong `.bundle-tier-row`").toBeGreaterThanOrEqual(2);
    expect(tierButtons.filter((b) => hasAncestorClass(b, "tier-row")).length, "thiếu ngữ cảnh ✕ trong `.tier-row`").toBeGreaterThanOrEqual(1);
  });
});

describe("nút xoá tier/rung phải là nút inline nhỏ, KHÔNG rơi về mặc định `button`", () => {
  const cases = [
    ...ladderButtons.map((b) => ["bậc thang bundle", b]),
    ...tierButtons.map((b) => ["tier đang soạn", b]),
  ];

  it.each(cases)("%s — không bị giãn theo bề rộng hàng", (_label, btn) => {
    const ctx = btn.ancestors.map((a) => [a.tag, ...a.classes].join(".")).join(" > ");
    const resolved = resolveCascade(btn.node, btn.ancestors, rules, TRACKED);

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
    const signatures = ladderButtons.map((btn) => sizingSignature(resolveCascade(btn.node, btn.ancestors, rules, TRACKED)));
    // Đỏ-trước: rung 2553 rộng 255px còn rung 2554 rộng 324px vì bề rộng `.value` khác nhau.
    expect(new Set(signatures).size, `các mặt số phải giống nhau, đo được: ${JSON.stringify([...new Set(signatures)])}`).toBe(1);
  });
});
