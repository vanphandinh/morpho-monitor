#!/usr/bin/env node
/**
 * [DEBUG-pr1] Probe từng endpoint trong RPC_URLS — feedback loop cho triệu chứng
 * "[proxy] eth_call forwarding failed" (thất bại eth_call hàng loạt ở upstream).
 *
 * GREEN = mọi endpoint phục vụ eth_call OK.
 * RED   = có ít nhất 1 endpoint eth_call hỏng / rate-limit / timeout (đúng triệu chứng log).
 *
 * REDACT: chỉ in hostname + path segment >16 ký tự bị che ("<REDACTED>").
 * API key (Alchemy nằm trong path, provider khác trong query) không bao giờ in ra.
 *
 * Chạy: node --env-file=.env scripts/probe-rpc-endpoints.mjs
 * (probe chỉ đọc: eth_chainId, eth_blockNumber, eth_call — không tốn phí)
 */
import { setTimeout as sleep } from "node:timers/promises";

const RPC_URLS = (process.env.RPC_URLS ?? "https://ethereum-rpc.publicnode.com")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SELECTOR_DECIMALS = "0x313ce567"; // decimals()

function redactUrl(raw) {
  try {
    const u = new URL(raw);
    const path = u.pathname
      .split("/")
      .map((s) => (s.length > 16 ? "<REDACTED>" : s))
      .join("/");
    return u.hostname + (path !== "/" ? path : "") + (u.search ? "?<REDACTED>" : "");
  } catch {
    return "<invalid-url>";
  }
}

async function rpc(url, method, params, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const status = res.status;
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    const latencyMs = Math.round(performance.now() - started);
    if (body?.error) {
      const code = body.error.code;
      return {
        ok: false,
        status,
        latencyMs,
        rateLimited: status === 429 || code === -32005,
        error: String(body.error.message || JSON.stringify(body.error)).slice(0, 140),
      };
    }
    if (!res.ok) {
      return { ok: false, status, latencyMs, rateLimited: status === 429, error: `HTTP ${status}` };
    }
    return { ok: true, status, latencyMs, result: body?.result };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const cause = err?.cause?.code ? ` (${err.cause.code})` : "";
    return {
      ok: false,
      status: 0,
      latencyMs,
      rateLimited: false,
      kind: err.name === "AbortError" ? "timeout" : "network",
      error: `${err.name}${cause}: ${String(err.message).slice(0, 100)}`,
    };
  } finally {
    clearTimeout(t);
  }
}

async function probeEndpoint(url) {
  const row = {
    endpoint: redactUrl(url),
    chainId: null,
    blockNumber: null,
    ethCall: null,
    ethCallNoTo: null, // dạng deployless-sim KHÔNG có `to` (lớp lỗi "→ ?" trong log)
    failures: 0,
  };

  const chain = await rpc(url, "eth_chainId", []);
  row.chainId = chain.ok ? chain.result : `FAIL: ${chain.error}`;

  const blk = await rpc(url, "eth_blockNumber", []);
  row.blockNumber = blk.ok
    ? parseInt(blk.result, 16)
    : `FAIL: ${blk.error}`;

  await sleep(150); // nhẹ nhàng, tránh tự tạo burst

  const call = await rpc(url, "eth_call", [{ to: USDC, data: SELECTOR_DECIMALS }, "latest"]);
  row.ethCall = call.ok
    ? `OK (${call.latencyMs}ms, ${call.result?.slice(0, 10)}...)`
    : `FAIL${call.status ? ` [HTTP ${call.status}]` : ""}: ${call.error}`;
  if (!call.ok) {
    row.failures++;
    row.rateLimited = row.rateLimited || call.rateLimited;
  }

  const noTo = await rpc(url, "eth_call", [{ data: "0x" }, "latest"]);
  row.ethCallNoTo = noTo.ok
    ? `OK (${noTo.latencyMs}ms)`
    : `FAIL${noTo.status ? ` [HTTP ${noTo.status}]` : ""}: ${noTo.error}`;

  return row;
}

const rows = await Promise.all(RPC_URLS.map(probeEndpoint));

console.log("=== [DEBUG-pr1] RPC endpoint probe —", new Date().toISOString(), "===");
for (const r of rows) {
  console.log(`\n▸ ${r.endpoint}`);
  console.log(`  chainId      : ${r.chainId}`);
  console.log(`  blockNumber  : ${r.blockNumber}`);
  console.log(`  eth_call(USDC decimals): ${r.ethCall}`);
  console.log(`  eth_call(không 'to')   : ${r.ethCallNoTo}`);
}

const ethCallFails = rows.filter((r) => r.ethCall?.startsWith("FAIL"));
const rateLimited = rows.filter((r) => r.rateLimited);

console.log("\n=== TÓM TẮT ===");
console.log(`Endpoints probe: ${rows.length}`);
console.log(`eth_call thất bại: ${ethCallFails.length}/${rows.length}`);
if (rateLimited.length) {
  console.log(`Rate-limited: ${rateLimited.map((r) => r.endpoint).join(", ")}`);
}

// RED khi tái hiện triệu chứng: upstream eth_call hỏng ở ≥1 endpoint.
process.exit(ethCallFails.length > 0 ? 1 : 0);
