/**
 * Nguồn sự thật về "module browser" — suy TỪ ĐỒ THỊ IMPORT, không phải danh sách viết tay.
 *
 * Audit P5: sau khi tách `webapp-app.mjs` thành 6 module, mọi test kiểu "webapp có X"
 * mà ghim vào một file cụ thể sẽ đỏ mỗi lần code chuyển nhà (đúng thứ đã xảy ra ở P2.7
 * với esc/row/formatToken). Ở đây đi theo closure import tương đối bắt đầu từ
 * `webapp-app.mjs`, nên:
 *   - thêm module mới ⇒ tự động vào phạm vi kiểm (không cần sửa test);
 *   - tách/đổi tên file ⇒ test vẫn đúng nghĩa "toàn bộ webapp", không phải "file này".
 *
 * Dùng `webappSource()` cho khẳng định về hành vi/chuỗi của webapp nói chung, và
 * `readBrowserSource("tên.mjs")` khi chính file đó là điều cần kiểm (ví dụ: chỉ
 * `webapp-app.mjs` được gán `window.*`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELATIVE_IMPORT_RE = /(?:^|\s)(?:import|export)[^"']*?from\s*"\.\/([^"]+)"/g;

/** Closure import tương đối bắt đầu từ module khởi động. */
export function browserModuleNames() {
  const seen = new Set();
  const queue = ["webapp-app.mjs"];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const src = readBrowserSource(name);
    for (const [, target] of src.matchAll(RELATIVE_IMPORT_RE)) queue.push(target);
  }
  return [...seen];
}

/** Đọc source của một module browser (tên trần, không phải đường dẫn). */
export function readBrowserSource(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

/** Source của mọi module browser, theo thứ tự closure. */
export function browserSources() {
  return browserModuleNames().map(readBrowserSource);
}

/** Toàn bộ webapp như MỘT chuỗi — dùng cho khẳng định "webapp có/không có X". */
export function webappSource() {
  return browserSources().join("\n");
}
