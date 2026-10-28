#!/usr/bin/env node
/**
 * [DEBUG-mn3] Minimise: tìm ngưỡng kích thước eth_call mà provider chặn.
 * Gọi TRỰC TIẾP từng endpoint (không qua transport) để quy kết chính xác,
 * 2 biến độc lập: kích thước calldata × có/không stateOverride.
 *
 * Phân loại kết quả mỗi call:
 *   ok         — RPC trả result (payload được chấp nhận)
 *   revert     — JSON-RPC execution reverted (payload được chấp nhận, exec hỏng)
 *   BLOCKED    — HTTP error / JSON-RPC error khác / network / timeout (bị chặn)
 *
 * RED (exit 1) khi ≥1 endpoint BLOCKED ở bất kỳ size nào ≥ 1KB.
 * Chỉ đọc — không tốn phí. Chạy:
 *   node --env-file=.env scripts/probe-payload-limit.mjs
 *   docker compose --profile debug run --rm probe-payload-limit
 */
import { setTimeout as sleep } from "node:timers/promises";
import { CHAIN_ID, CHAIN_NAME, MORPHO_BLUE_ADDRESS, RPC_URLS } from "../shared.mjs";

const MORPHO = MORPHO_BLUE_ADDRESS;
const SIZES = [448, 1024, 4096, 8192, 16384, 32768, 65536];

function redactUrl(raw) {
  try {
    const u = new URL(raw);
    const path = u.pathname.split("/").map((s) => (s.length > 16 ? "/<REDACTED>" : "/" + s)).join("");
    return u.hostname + path + (u.search ? "?<REDACTED>" : "");
  } catch {
    return "<invalid-url>";
  }
}

async function chainIdOf(url, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body?.error) throw new Error(String(body.error.message || JSON.stringify(body.error)).slice(0, 90));
    return Number(body?.result);
  } finally {
    clearTimeout(t);
  }
}

async function rpc(url, params, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params }),
      signal: ctrl.signal,
    });
    const status = res.status;
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    const latencyMs = Math.round(performance.now() - started);
    if (body?.error) {
      const msg = String(body.error.message || JSON.stringify(body.error));
      const isRevert = /revert|VM execution|out of gas/i.test(msg);
      return { kind: isRevert ? "revert" : "BLOCKED", status, latencyMs, msg: msg.slice(0, 90) };
    }
    if (!res.ok) return { kind: "BLOCKED", status, latencyMs, msg: `HTTP ${status}` };
    return { kind: "ok", status, latencyMs, msg: String(body?.result ?? "").slice(0, 10) };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const cause = err?.cause?.code ? ` (${err.cause.code})` : "";
    const kind = err.name === "AbortError" ? "BLOCKED" : "BLOCKED";
    return { kind, status: 0, latencyMs, msg: `${err.name}${cause}: ${String(err.message).slice(0, 80)}` };
  } finally {
    clearTimeout(t);
  }
}

async function ladder(url, withOverride) {
  const cells = [];
  for (const size of SIZES) {
    const tx = { to: MORPHO, data: "0x" + "ab".repeat(size) };
    const params = [tx, "latest"];
    if (withOverride) params.push({ [MORPHO]: { balance: "0x1" } });
    const r = await rpc(url, params);
    cells.push({ size, ...r });
    if (r.kind === "BLOCKED") break; // ngưỡng đầu tiên bị chặn — đủ để kết luận cột này
    await sleep(100);
  }
  return cells;
}

const endpoints = await Promise.all(RPC_URLS.map(async (url) => {
  const label = redactUrl(url);
  try {
    const chainId = await chainIdOf(url);
    if (chainId !== CHAIN_ID) {
      return { url, label, chainId, chainMismatch: true, noOverride: [], withOverride: [] };
    }
  } catch (error) {
    return { url, label, chainError: error, noOverride: [], withOverride: [] };
  }
  const noOverride = await ladder(url, false);
  const withOverride = await ladder(url, true);
  return { url, label, noOverride, withOverride };
}));

console.log(`=== [DEBUG-mn3] Payload-limit ladder — ${CHAIN_NAME} (${CHAIN_ID}) — ${new Date().toISOString()} ===`);
let anyBlocked = false;
for (const e of endpoints) {
  console.log(`\n▸ ${e.label}`);
  if (e.chainMismatch) {
    anyBlocked = true;
    console.log(`  SAI CHAIN: ${e.chainId} (expected ${CHAIN_ID}) — bỏ qua ladder`);
    continue;
  }
  if (e.chainError) {
    anyBlocked = true;
    console.log(`  KHÔNG ĐỌC ĐƯỢC CHAIN: ${String(e.chainError?.message || e.chainError).slice(0, 90)} — bỏ qua ladder`);
    continue;
  }
  const fmt = (cells) => {
    const last = cells[cells.length - 1];
    if (!last) return "n/a";
    if (last.kind === "BLOCKED") {
      anyBlocked = true;
      return `CHẶN @${last.size}B (HTTP ${last.status || "-"}, ${last.latencyMs}ms) "${last.msg}"`;
    }
    return `OK tới ${SIZES[SIZES.length - 1]}B`;
  };
  console.log(`  không override : ${fmt(e.noOverride)}`);
  console.log(`  có override    : ${fmt(e.withOverride)}`);
}

console.log("\n=== TÓM TẮT ===");
if (endpoints.length === 0) {
  console.error("❌ Không có RPC endpoint nào để probe — kiểm tra RPC_URLS/config/chains.json.");
  process.exit(1);
}
console.log(anyBlocked
  ? "→ RED: có provider chặn eth_call, sai chain, hoặc không đọc được chain."
  : "→ GREEN: tất cả endpoint đúng chain và không provider nào chặn ở các size đo được (tối đa 64KB).");
process.exit(anyBlocked ? 1 : 0);
