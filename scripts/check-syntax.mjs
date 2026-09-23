/**
 * `node --check` cho mọi file .mjs trong repo.
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
for (const file of targets) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    failed++;
    console.error(`❌ Syntax error: ${path.relative(root, file)}`);
    console.error(err.stderr?.toString().trim() || err.message);
  }
}

if (failed > 0) {
  console.error(`❌ node --check: ${failed}/${targets.length} file lỗi cú pháp`);
  process.exit(1);
}
console.log(`✅ node --check: ${targets.length}/${targets.length} file OK`);
