/**
 * `node --check` cho mọi file .mjs trong repo + `<script type="module">` nội
 * tuyến của webapp.html.
 *
 * `node --check` chỉ nhận một file mỗi lần, và npm scripts chạy bằng shell
 * mặc định của HĐH (cmd.exe trên Windows) nên không thể dùng vòng lặp POSIX.
 * Script này chạy cross-platform và là một phần của `npm run check`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const listMjs = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => path.join(dir, entry.name));
};

const targets = [...listMjs(root), ...listMjs(path.join(root, "__tests__")), ...listMjs(path.join(root, "__tests__", "helpers"))];

let failed = 0;
let checked = 0;
for (const file of targets) {
  checked++;
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    failed++;
    console.error(`❌ Syntax error: ${path.relative(root, file)}`);
    console.error(err.stderr?.toString().trim() || err.message);
  }
}

/**
 * webapp.html từng giữ code production trong thẻ `<script type="module">` NỘI
 * TUYẾN (~1900 dòng) mà không cổng nào chạm tới: `node --check` theo file không
 * đọc HTML, oxlint chỉ quét `.mjs` — nên một lỗi `no-undef` trong đó vẫn parse
 * hợp lệ và chỉ chết lúc người dùng bấm nút. Audit A.1 đã chuyển khối đó ra
 * `webapp-app.mjs` (được lint, `node --check`, và import được trong test).
 *
 * Ở đây chỉ còn GHIM bất biến đó: HTML không được chứa module nội tuyến trở lại,
 * phải trỏ tới module đã tách, và file đó phải tồn tại. Kèm kiểm tra importmap là
 * JSON hợp lệ (viem resolve qua đây; JSON hỏng thì browser bỏ qua im lặng).
 */
const webappPath = path.join(root, "webapp.html");
if (fs.existsSync(webappPath)) {
  checked++;
  const html = fs.readFileSync(webappPath, "utf8");
  const moduleTags = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*>/g)].map((m) => m[0]);
  const fail = (message) => { failed++; console.error(`❌ webapp.html: ${message}`); };

  if (moduleTags.length === 0) {
    fail('không còn thẻ <script type="module"> nào (format đổi?)');
  }
  for (const tag of moduleTags) {
    if (!/\bsrc\s*=/.test(tag)) {
      fail(`A.1: module NỘI TUYẾN (${tag.slice(0, 60)}…) ⇒ code production đó không được lint. Chuyển vào webapp-app.mjs.`);
    }
  }
  if (moduleTags.length > 0 && !/src="\/webapp-app\.mjs"/.test(html)) {
    fail("thẻ module phải trỏ tới /webapp-app.mjs (route do webapp-handler.mjs phục vụ)");
  }
  const appModulePath = path.join(root, "webapp-app.mjs");
  if (!fs.existsSync(appModulePath)) {
    fail("thiếu webapp-app.mjs — server sẽ fail-fast khi khởi động");
  }
  checked++;

  // Audit A.1b: logic thuần nằm ở webapp-logic.mjs — module dùng chung cho
  // browser (import từ webapp-app.mjs, route do webapp-handler.mjs phục vụ) và
  // test (import trực tiếp trong vitest). Thiếu file, hoặc app không import nó,
  // nghĩa là hoặc UI chết lặng, hoặc logic rơi về bản sao cục bộ mà test không
  // chạm tới — đúng lớp lỗi mà A.1 muốn diệt.
  const logicModulePath = path.join(root, "webapp-logic.mjs");
  if (!fs.existsSync(logicModulePath)) {
    fail("thiếu webapp-logic.mjs — webapp-app.mjs import file này (route /webapp-logic.mjs)");
  }
  checked++;
  if (fs.existsSync(appModulePath) && !/from "\.\/webapp-logic\.mjs"/.test(fs.readFileSync(appModulePath, "utf8"))) {
    fail('webapp-app.mjs phải import logic dùng chung: from "./webapp-logic.mjs"');
  }

  // importmap: JSON hợp lệ — viem resolve qua đây; JSON hỏng thì browser bỏ qua im lặng.
  const importMap = html.match(/<script\b[^>]*\btype="importmap"[^>]*>([\s\S]*?)<\/script>/);
  if (importMap) {
    checked++;
    try {
      JSON.parse(importMap[1]);
    } catch (err) {
      failed++;
      console.error('❌ JSON error: webapp.html <script type="importmap">');
      console.error(err.message);
    }
  }
}

if (failed > 0) {
  console.error(`❌ node --check: ${failed}/${checked} target lỗi cú pháp`);
  process.exit(1);
}
console.log(`✅ node --check: ${checked}/${checked} target OK (${targets.length} file .mjs + webapp.html no-inline-module)`);
