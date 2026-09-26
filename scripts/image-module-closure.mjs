#!/usr/bin/env node
/**
 * Kiểm đồ thị module browser NẰM TRONG một thư mục đã triển khai (vòng 6, P5).
 *
 *   node scripts/image-module-closure.mjs .        # kiểm ngay tại cây nguồn
 *   node scripts/image-module-closure.mjs /app     # kiểm bên trong image Docker
 *
 * Vì sao cần một script riêng cho việc này: `Dockerfile` chỉ `COPY *.mjs ./` — tức nó copy mọi
 * module ở GỐC repo. Hôm nay cả 10 module browser đều ở gốc nên image đủ file, nhưng nếu lần tách
 * module sau đặt file trong thư mục con (hoặc ai đó "dọn" Dockerfile thành danh sách file tường
 * minh rồi quên một cái), image sẽ **thiếu module** mà:
 *   - `docker build` vẫn thành công (không ai kiểm),
 *   - mọi test trong repo vẫn xanh (chúng chạy trên cây nguồn, không phải trên image),
 *   - và triệu chứng duy nhất là browser nhận 404 ⇒ module không nạp ⇒ UI chết lặng.
 *
 * Đây đúng lớp lỗi D7 (3 danh sách module lệch nhau) nhưng ở tầng artifact triển khai, nên nó được
 * kiểm ở tầng đó: đọc import closure thật của entry trong artifact rồi khẳng định từng file có mặt.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? process.cwd());
const entry = "webapp-app.mjs";
const RELATIVE_IMPORT_RE = /(?:^|\s)(?:import|export)[^"']*?from\s*"\.\/([^"]+)"/g;

if (!fs.existsSync(root)) {
  console.error(`❌ không có thư mục: ${root}`);
  process.exit(1);
}

const missing = [];
const seen = new Set();
const queue = [entry];
while (queue.length > 0) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const full = path.join(root, name);
  if (!fs.existsSync(full)) {
    missing.push(name);
    continue;
  }
  const source = fs.readFileSync(full, "utf8");
  for (const [, target] of source.matchAll(RELATIVE_IMPORT_RE)) queue.push(target);
}

const htmlPath = path.join(root, "webapp.html");
if (!fs.existsSync(htmlPath)) missing.push("webapp.html");

if (missing.length > 0) {
  console.error(`❌ artifact ${root} THIẾU ${missing.length} file thuộc đồ thị webapp:`);
  for (const file of missing) console.error(`   - ${file}`);
  console.error("   (browser sẽ nhận 404 và cả UI chết lặng — xem Dockerfile `COPY *.mjs`)");
  process.exit(1);
}

console.log(`✅ artifact ${root}: đủ ${seen.size + 1} file của đồ thị webapp (${seen.size} module + html)`);
