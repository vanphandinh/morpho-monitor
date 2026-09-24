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
 * webapp.html giữ code production trong thẻ `<script type="module">` nội tuyến
 * (SPA ~2200 dòng) mà không cổng nào chạm tới: `node --check` theo file không đọc
 * HTML, oxlint chỉ quét `.mjs`. Lỗi cú pháp ở đó chỉ lộ ra khi user mở trang.
 * `node --input-type=module --check` nhận source từ stdin nên không cần file tạm.
 */
const webappPath = path.join(root, "webapp.html");
if (fs.existsSync(webappPath)) {
  const html = fs.readFileSync(webappPath, "utf8");
  const modules = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  if (modules.length === 0) {
    checked++;
    failed++;
    console.error('❌ Syntax error: webapp.html — không tìm thấy thẻ <script type="module"> nào (format đổi?)');
  }
  for (const [index, source] of modules.entries()) {
    checked++;
    try {
      execFileSync(process.execPath, ["--input-type=module", "--check"], {
        input: source,
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (err) {
      failed++;
      const label = modules.length > 1 ? `webapp.html (inline module #${index + 1})` : "webapp.html (inline module)";
      console.error(`❌ Syntax error: ${label}`);
      console.error(err.stderr?.toString().trim() || err.message);
    }
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
console.log(`✅ node --check: ${checked}/${checked} target OK (${targets.length} file .mjs + webapp.html inline)`);
