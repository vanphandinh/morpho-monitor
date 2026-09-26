/**
 * Bộ giải CASCADE CSS + quét markup, dùng chung cho các test layout của webapp.
 *
 * Vì sao cần (chẩn đoán 2026-09-26, "nút xoá tier quá to và không đồng đều"): DOM giả của
 * `dom-stub.mjs` KHÔNG có layout — không `getBoundingClientRect()`, không computed style — nên trong
 * vitest không thể đo pixel. Cách duy nhất chạm ĐÚNG cơ chế mà không thêm phụ thuộc browser là tự giải
 * cascade của chính `webapp.html` (đặc tả + thứ tự khai báo) trên ĐÚNG ngữ cảnh container mà markup
 * THẬT do các module browser sinh ra.
 *
 * GIỚI HẠN của model (phải khoá lại bằng test, xem `assertModelLimits`):
 *   - chỉ hiểu stylesheet PHẲNG: at-rule lồng (`@media`, `@supports`, `@layer`) không được mô hình
 *     hoá; nếu một at-rule chạm tới lớp đang kiểm thì model trở nên SAI và phải báo đỏ, không được
 *     im lặng;
 *   - combinator `>`, `+`, `~` không mô hình hoá (coi như KHÔNG khớp);
 *   - pseudo-class/pseudo-element không mô hình hoá (coi như KHÔNG khớp);
 *   - `!important` không mô hình hoá (nó thắng cả style inline) ⇒ phải báo đỏ nếu xuất hiện.
 * Style inline `style="..."` ĐƯỢC mô hình hoá (thắng mọi rule không-important), vì markup thật của
 * webapp dùng nó để thu nhỏ nút (`style="width:auto"`).
 * Model "khớp thì khớp, không chắc thì KHÔNG khớp" là hướng AN TOÀN CHO TEST ĐỎ: nó không bao giờ
 * làm test xanh giả vì tưởng một rule có hiệu lực trong khi thực tế không.
 */

/** Bóc khối `<style>` của `webapp.html`. */
export function styleSheetOf(html) {
  const open = html.indexOf("<style>");
  const close = html.indexOf("</style>", open === -1 ? 0 : open);
  if (open === -1 || close === -1) throw new Error("không tìm thấy khối <style> trong webapp.html");
  return html.slice(open, close);
}

/** Bóc phần thân tài liệu (bỏ `<style>`/`<script>`) để quét markup tĩnh. */
export function bodyMarkupOf(html) {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "");
}

/**
 * Cắt stylesheet thành rule phẳng. Đếm ngoặc để nuốt trọn at-rule dạng lồng (`@keyframes`) thay vì
 * cắt sai ở dấu `}` đầu tiên.
 */
export function parseCss(css) {
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

/** `{ prop: value }` của một thân rule. */
export function declarations(body) {
  const out = {};
  for (const chunk of body.split(";")) {
    const at = chunk.indexOf(":");
    if (at === -1) continue;
    out[chunk.slice(0, at).trim().toLowerCase()] = chunk.slice(at + 1).trim();
  }
  return out;
}

/** Đặc tả [id, class/attr/pseudo, element] — đủ cho các selector của file này. */
export function specificity(selector) {
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
export function matchesCompound(compound, node) {
  if (compound.includes(":")) return false;
  const tag = compound.match(/^([a-zA-Z][\w-]*)/);
  if (tag && tag[1].toLowerCase() !== node.tag) return false;
  for (const [, cls] of compound.matchAll(/\.([\w-]+)/g)) {
    if (!node.classes.includes(cls)) return false;
  }
  return true;
}

/** Selector (kiểu con cháu) có khớp `node` với chuỗi `ancestors` không. */
export function matches(selector, node, ancestors) {
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

/** `{ prop: value }` từ thuộc tính `style="..."` của markup. */
export function inlineDeclarations(attrs) {
  const m = String(attrs || "").match(/\bstyle="([^"]*)"/);
  return m ? declarations(m[1]) : {};
}

/**
 * Giá trị thắng cascade cho các thuộc tính trong `props`.
 *
 * `entry` là một phần tử từ `scanElements()` (`{node, ancestors, attrs}`) — `attrs` cần thiết để tính
 * style inline; truyền `attrs` rỗng (hoặc bỏ) khi chỉ có `{node, ancestors}`.
 */
export function resolveCascade(entry, rules, props) {
  const { node, ancestors = [], attrs = "" } = entry;
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
  // Style inline thắng mọi rule KHÔNG-important (`!important` bị `modelLimitError` chặn riêng).
  const inline = inlineDeclarations(attrs);
  const inlineRank = [1, 0, 0, Number.MAX_SAFE_INTEGER];
  for (const prop of props) {
    if (prop in inline) winners[prop] = { value: inline[prop], rank: inlineRank };
  }
  return Object.fromEntries(Object.entries(winners).map(([prop, w]) => [prop, w.value]));
}

/** Class của những container được stylesheet cho `display:flex` (suy từ CSS, không viết tay). */
export function flexContainerClasses(rules) {
  const out = new Set();
  for (const rule of rules) {
    if (!/^(inline-)?flex$/i.test(declarations(rule.body).display || "")) continue;
    for (const raw of rule.selector.split(",")) {
      for (const compound of raw.trim().split(/\s+/)) {
        for (const [, cls] of compound.matchAll(/\.([\w-]+)/g)) out.add(cls);
      }
    }
  }
  return out;
}

const VOID_TAGS = new Set(["br", "hr", "input", "img", "meta", "link", "source", "col", "area", "base", "embed", "track", "wbr"]);

/**
 * Quét markup và trả về mọi element khớp `predicate(node)` kèm chuỗi tổ tiên THẬT của nó.
 * `node` = `{ tag, classes }`; `predicate` nhận cả `node` và `attrs` thô để tự quyết định.
 */
export function scanElements(markup, predicate) {
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
    if (predicate(node, attrs)) out.push({ node, ancestors: stack.slice(), attrs });
    if (!attrs.trimEnd().endsWith("/") && !VOID_TAGS.has(name)) stack.push(node);
  }
  return out;
}

/** Tổ tiên gần nhất có một class thuộc `classSet`; `null` nếu không có. */
export function flexContextOf(entry, flexClasses) {
  for (let i = entry.ancestors.length - 1; i >= 0; i -= 1) {
    const hit = entry.ancestors[i].classes.find((cls) => flexClasses.has(cls));
    if (hit) return hit;
  }
  return null;
}

/**
 * Mô tả ngữ cảnh của một element (dùng cho thông báo lỗi): `div.row > div.row.bundle-tier-row`.
 */
export function contextLabel(entry) {
  return entry.ancestors.map((a) => [a.tag, ...a.classes].join(".")).join(" > ") || "(gốc)";
}

/**
 * Khoá GIỚI HẠN của model lại: nếu ai thêm at-rule chạm tới `classNames`, model phẳng trở nên sai và
 * test phải ĐỎ (không được xanh giả). Trả về thông báo lỗi, hoặc `null` nếu model còn đúng.
 */
export function modelLimitError(rules, classNames) {
  const important = rules.filter((r) => /!important/.test(r.body));
  if (important.length > 0) {
    return `có \`!important\` trong ${important.map((r) => `"${r.selector.trim()}"`).join(", ")} — nó thắng cả style inline, model phải mô hình hoá trước`;
  }
  const atRules = rules.filter((r) => r.selector.trim().startsWith("@"));
  const nested = atRules.filter((r) => /^@(media|supports|layer|container|scope)\b/i.test(r.selector.trim()));
  if (nested.length > 0) {
    return `có at-rule lồng (${nested.map((r) => r.selector.trim()).join(", ")}) — model phẳng phải được mở rộng trước`;
  }
  for (const rule of atRules) {
    for (const cls of classNames) {
      if (rule.body.includes(`.${cls}`)) {
        return `at-rule "${rule.selector.trim()}" chạm .${cls} — không mô hình hoá được, phải mở rộng parser`;
      }
    }
  }
  return null;
}
