#!/usr/bin/env node
/**
 * [DEBUG-br2] Replay burst eth_call kiểu Ambire — feedback loop cho
 * "[proxy] eth_call forwarding failed" (window 17:36–17:43, khi ví đang simulate).
 *
 * Mô phỏng đúng pattern nghi vấn:
 *   Phase A — burst số lượng: 4 đợt × 12 eth_call nhỏ đồng thời (như Ambire poll portfolio).
 *   Phase B — payload lớn: 2 đợt × 4 eth_call ~32KB + stateOverride (multicall sim thật).
 * Chạy QUA createRobustPublicClient của project (round-robin + retry×2 + circuit breaker)
 * nên circuit OPEN / "RPC Request failed" xuất hiện y như production.
 *
 * RED (exit 1) khi: có request hỏng tầng transport / timeout, HOẶC ≥1 URL bị
 * circuit breaker ghi nhận failure. GREEN (exit 0) = không tái hiện.
 *
 * Chỉ đọc (eth_call) — không tốn phí. Chạy:
 *   node --env-file=.env scripts/replay-eth-call-burst.mjs
 *   docker compose --profile debug run --rm probe-burst
 */
import { createRobustPublicClient, circuits } from "../rpc-client.mjs";

const RPC_URLS = (process.env.RPC_URLS ?? "https://ethereum-rpc.publicnode.com")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const MORPHO = process.env.MORPHO_BLUE_ADDRESS
  ?? "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SEL_DECIMALS = "0x313ce567";

const smallParams = () => [{ to: USDC, data: SEL_DECIMALS }, "latest"];
const bigParams = (i) => {
  // ~32KB data → Morpho Blue fallback revert nhanh; kích thước là điều ta đo,
  // execution cost không quan trọng. 1/2 call kèm stateOverride như Ambire.
  const params = [{ to: MORPHO, data: "0x" + "ab".repeat(32_000) }, "latest"];
  if (i % 2 === 1) params.push({ [MORPHO]: { balance: "0x1" } });
  return params;
};

function classify(err) {
  // Chi tiết thật của viem nằm ở details/cause — shortMessage "RPC Request failed."
  // KHÔNG phải tín hiệu mạng (đã fix trong proxy-dispatcher.mjs, regression test kèm).
  const detail = `${err?.details || ""} ${err?.cause?.message || ""}`;
  const msg = `${err?.shortMessage || ""} ${err?.message || ""} ${detail}`;
  if (/revert/i.test(detail)) return "revert";
  if (/took too long/i.test(msg)) return "timeout";
  if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|Circuit breaker|HTTP request failed/i.test(msg))
    return "transport";
  if (/revert/i.test(msg)) return "revert";
  return "other";
}

const client = createRobustPublicClient(RPC_URLS);
const tally = { transport: 0, timeout: 0, revert: 0, other: 0, ok: 0 };
const firstErrs = new Map();

async function wave(label, n, paramsFor) {
  const results = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => client.request({ method: "eth_call", params: paramsFor(i) }))
  );
  let bad = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      tally.ok++;
      continue;
    }
    const kind = classify(r.reason);
    if (tally[kind] !== undefined) tally[kind]++;
    else tally.other++;
    if (kind === "transport" || kind === "timeout") bad++;
    if (!firstErrs.has(kind)) firstErrs.set(kind, String(r.reason?.details || r.reason?.cause?.message || r.reason?.message || r.reason).slice(0, 120));
  }
  console.log(`[DEBUG-br2] ${label}: ${n} call, ${bad} transport/timeout hỏng`);
  return bad;
}

console.log(`[DEBUG-br2] Replay burst qua ${RPC_URLS.length} endpoint — ${new Date().toISOString()}`);
const t0 = Date.now();

for (let w = 1; w <= 4; w++) await wave(`Phase A đợt ${w}/4 (12 nhỏ)`, 12, smallParams);
for (let w = 1; w <= 2; w++) await wave(`Phase B đợt ${w}/2 (4 lớn + stateOverride)`, 4, bigParams);

const elapsedMs = Date.now() - t0;
const urlsFailed = [...circuits.entries()]
  .filter(([, c]) => c.failures > 0 || c.openUntil > 0)
  .map(([url]) => {
    try { return new URL(url).hostname; } catch { return "?"; }
  });

console.log("\n=== [DEBUG-br2] TÓM TẮT ===");
console.log(`Hoàn tất trong ${elapsedMs}ms — ok=${tally.ok} transport=${tally.transport} timeout=${tally.timeout} revert=${tally.revert} other=${tally.other}`);
for (const [kind, msg] of firstErrs) console.log(`  lỗi[${kind}]: ${msg}`);
console.log(`Circuit breaker ghi nhận failure ở: ${urlsFailed.length ? urlsFailed.join(", ") : "(không)"}`);

const reproduced = tally.transport > 0 || tally.timeout > 0 || urlsFailed.length > 0;
console.log(reproduced
  ? "→ RED: tái hiện triệu chứng eth_call forwarding failed / circuit OPEN."
  : "→ GREEN: không tái hiện ở cường độ này.");
process.exit(reproduced ? 1 : 0);
