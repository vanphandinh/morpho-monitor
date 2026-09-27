#!/usr/bin/env node
/**
 * Probe tay danh sách public RPC cho browser — 2 mục đích:
 *
 *  1. Kiểm chứng NGAY không cần đợi chu kỳ refresh của webapp-server
 *     (node scripts/refresh-public-rpcs.mjs — kết quả ghi đúng cache mà server đọc).
 *  2. Chẩn đoán: in chi tiết từng ứng viên đạt/rớt kèm lý do (429? thiếu
 *     method? CORS?) — feedback loop cho "RPC nào đang yếu?".
 *
 * Mặc định probe danh sách ứng viên từ catalog chainlist (như server chạy);
 * PUBLIC_RPC_URLS=... node scripts/refresh-public-rpcs.mjs để probe đúng danh
 * sách operator override. Mọi request CHỈ ĐỌC (chainId/call/getLogs/…), nhịp
 * 150ms giữa các request, concurrency 4 — an toàn để chạy trên production VPS.
 * Lưu ý: script LUÔN quét đầy đủ (không revalidate ETag 304 như chu kỳ nền
 * của server — chế độ tay phải ra kết quả tươi, không tái dùng candidate cũ).
 *
 * Chạy: node --env-file=.env scripts/refresh-public-rpcs.mjs
 *       node --env-file=.env scripts/refresh-public-rpcs.mjs --out=/tmp/probe.json
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_RPC_HEALTH_PATH, PUBLIC_RPC_URLS } from "../shared.mjs";
import { extractCandidates, probeCandidates, CHAINLIST_CATALOG_URL } from "../public-rpc-health.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const outArg = process.argv.find((a) => a.startsWith("--out="));
const outPath = outArg
  ? path.resolve(outArg.slice("--out=".length))
  : path.join(__dirname, "..", PUBLIC_RPC_HEALTH_PATH);

const urlsArg = process.argv.find((a) => a.startsWith("--urls="));
let candidates;
if (urlsArg) {
  candidates = urlsArg.slice("--urls=".length).split(",").map((u) => u.trim()).filter(Boolean);
  console.log(`[probe-tay] probe ${candidates.length} URL truyền qua --urls`);
} else if (process.env.PUBLIC_RPC_URLS) {
  candidates = PUBLIC_RPC_URLS;
  console.log(`[probe-tay] PUBLIC_RPC_URLS được set — probe đúng danh sách operator (${candidates.length} URL), KHÔNG fetch chainlist`);
} else {
  console.log(`[probe-tay] fetch catalog ${CHAINLIST_CATALOG_URL} …`);
  const res = await fetch(CHAINLIST_CATALOG_URL, { headers: { accept: "application/json" } });
  if (!res.ok) {
    console.error(`[probe-tay] ❌ catalog HTTP ${res.status}`);
    process.exit(1);
  }
  candidates = extractCandidates(await res.json());
  console.log(`[probe-tay] ${candidates.length} ứng viên key-less (https, tracking=none) cho chain 1`);
}

if (candidates.length === 0) {
  console.error("[probe-tay] ❌ Không có ứng viên nào để probe.");
  process.exit(1);
}

const results = await probeCandidates(candidates, { timeoutMs: 8000 });

console.log("\n=== KẾT QUẢ PROBE (sắp xếp: đạt + nhanh nhất trước) ===");
for (const r of results) {
  if (r.ok) console.log(`  ✅ ${r.url} — ${r.latencyMs}ms`);
  else console.log(`  ❌ ${r.url} — ${r.reason}`);
}
const passing = results.filter((r) => r.ok);
console.log(`\nTổng: ${passing.length}/${results.length} đạt.`);

if (outArg) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(outPath), { recursive: true });
  // Script tay chỉ GHI khi có --out (mặc định ghi đúng cache server đọc như
  // verifyPublicRpcs làm — nhưng chỉ khi đạt ngưỡng tối thiểu để không cụt hóa).
  const payload = {
    version: 1,
    verifiedAt: new Date().toISOString(),
    urls: passing.map((r) => r.url),
    probe: Object.fromEntries(passing.map((r) => [r.url, { latencyMs: r.latencyMs }])),
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`[probe-tay] đã ghi ${passing.length} endpoint → ${outPath}`);
} else {
  console.log("[probe-tay] chỉ báo cáo — truyền --out=<path> để ghi cache (server đọc file đó).");
}
