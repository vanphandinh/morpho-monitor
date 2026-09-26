#!/usr/bin/env node
/**
 * Cổng lint có TỰ KIỂM ĐỘ PHỦ (vòng 6, P4).
 *
 *   npm run lint                 → oxlint --deny no-undef --deny-warnings .  + tự kiểm độ phủ
 *   node scripts/lint.mjs --scope __tests__      (chỉ dùng cho test của cổng)
 *
 * Vì sao cần lớp tự kiểm: D10 (vòng 5) cho thấy cổng lint có thể **im lặng không quét gì** mà vẫn
 * in `Found 0 warnings and 0 errors` và exit 0 — vì lệnh cũ dựa vào shell expand `*.mjs`, mà shell
 * của npm trên Windows (cmd.exe) không expand. Hệ quả: mọi tuyên bố "lint xanh" chỉ chứng minh được
 * `__tests__` + `scripts` sạch, còn toàn bộ `.mjs` ở gốc (tức production) chưa từng được quét.
 *
 * Lớp này không tin dòng tổng kết, cũng không tin exit code của chính nó: nó đọc số file mà oxlint
 * BÁO ĐÃ QUÉT và đối chiếu với danh sách `.mjs` mà git đang theo dõi. Thiếu một file ⇒ ĐỎ, kèm danh
 * sách file chắc chắn nằm ngoài phạm vi quét.
 *
 * Hai nguyên tắc:
 *   1. **Fail closed.** Không parse được số file ⇒ coi như không kiểm được ⇒ đỏ. Không có nhánh nào
 *      biến "không biết" thành "xanh".
 *   2. **Không tự tính lại việc quét.** Con số phải đến từ oxlint (thứ thực sự quét), không phải từ
 *      việc mình tự đếm file rồi tự khen.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OXLINT_BIN = path.join(ROOT, "node_modules", "oxlint", "bin", "oxlint");
/** Giữ NGUYÊN hai cờ này: `--deny no-undef` bắt lớp lỗi C1, `--deny-warnings` bắt cảnh báo (biến chết…). */
const OXLINT_FLAGS = ["--deny", "no-undef", "--deny-warnings"];

function parseArgs(argv) {
  let scope = ".";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--scope") scope = argv[i += 1];
    else throw new Error(`tham số lạ: ${argv[i]}`);
  }
  return { scope };
}

/** `.mjs` mà git đang theo dõi. Dùng git để định nghĩa "cần quét", không tự đoán theo thư mục. */
function trackedMjsFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", "*.mjs"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\0").filter(Boolean).map((file) => file.replace(/\\/g, "/"));
  } catch (err) {
    // Không có git (vd giải nén tarball): đi bộ cây, bỏ qua thư mục không thuộc nguồn.
    console.error(`[lint] git không dùng được (${err.message.split("\n")[0]}); đếm file bằng fs`);
    const SKIP = new Set(["node_modules", ".git", ".freebuff", ".claude", ".gitnexus", "data", "config"]);
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
          walk(path.join(dir, entry.name));
        } else if (entry.name.endsWith(".mjs")) {
          found.push(path.relative(ROOT, path.join(dir, entry.name)).replace(/\\/g, "/"));
        }
      }
    };
    walk(ROOT);
    return found;
  }
}

function runOxlint(scope) {
  try {
    const stdout = execFileSync(process.execPath, [OXLINT_BIN, ...OXLINT_FLAGS, scope], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: stdout };
  } catch (err) {
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return { status: typeof err.status === "number" ? err.status : 1, output };
  }
}

const { scope } = parseArgs(process.argv.slice(2));
const tracked = trackedMjsFiles();
const result = runOxlint(scope);
process.stdout.write(result.output);

// Con số do oxlint báo ("Finished in 18ms on 80 files with 97 rules using 16 threads").
const scannedMatch = result.output.match(/\bon (\d+) files\b/);
const scanned = scannedMatch ? Number(scannedMatch[1]) : null;

let coverageFailed = false;
if (scanned === null) {
  console.error("[lint] ❌ không đọc được số file oxlint đã quét — coi như KHÔNG kiểm được độ phủ.");
  console.error("[lint]    (fail closed: đổi định dạng output của oxlint ⇒ phải sửa script này, không im lặng cho qua)");
  coverageFailed = true;
} else if (scanned < tracked.length) {
  const inScope = (file) => scope === "." || file === scope.replace(/^\.\//, "").replace(/\/$/, "") || file.startsWith(scope.replace(/^\.\//, "").replace(/\/$/, "") + "/");
  const outside = tracked.filter((file) => !inScope(file));
  console.error(
    `[lint] ❌ oxlint chỉ quét ${scanned} file, nhưng git đang theo dõi ${tracked.length} file .mjs ` +
      `(phạm vi: ${scope}). Đây đúng lớp lỗi D10: cổng "xanh" mà thực ra không quét code production.`
  );
  for (const file of (outside.length > 0 ? outside : tracked).slice(0, 10)) console.error(`[lint]    chưa được quét: ${file}`);
  if (outside.length > 10) console.error(`[lint]    … và ${outside.length - 10} file nữa`);
  coverageFailed = true;
} else {
  console.log(`[lint] ✅ độ phủ: oxlint quét ${scanned} file .mjs (git theo dõi ${tracked.length} file, phạm vi "${scope}")`);
}

process.exitCode = result.status === 0 && !coverageFailed ? 0 : 1;
