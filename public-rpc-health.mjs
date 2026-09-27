/**
 * Lớp hybrid RPC công khai cho webapp (2026-09-27).
 *
 * Vì sao tồn tại: chainlist là CATALOG biên soạn tay, không phải health probe —
 * probe 2026-09-27 cho thấy eth.meowrpc.com (429 thất thường), eth.merkle.io
 * (429 request đầu) và rpc.flashbots.net (không hỗ trợ eth_call) đều vẫn nằm
 * trong nhóm `tracking: "none"` của chainlist. Danh sách tĩnh trong shared.mjs
 * chỉ chết khi DefiLlama gỡ tay. Lớp này bổ sung chu trình:
 *
 *   fetch catalog chainlist (If-None-Match/ETag — 304 thì tái dùng candidate
 *   đã cache, không parse lại ~2.3MB)                      ← cập nhật 24h/lần
 *   → lọc: chain 1, https, tracking:"none"
 *   → guard: loại URL mang credential (urlLooksCredentialed),
 *            host private/loopback (SSRF), endpoint wss
 *   → probe chủ động từng ứng viên (CHỈ ĐỌC): OPTIONS preflight CORS
 *     (browser phải qua preflight trước POST — probe chỉ nhìn ACAO trên POST
 *     response từng duyệt nhầm endpoint trả ACAO cho POST nhưng im lặng với
 *     OPTIONS), rồi eth_chainId, eth_blockNumber, eth_call, eth_getLogs,
 *     eth_getTransactionReceipt, eth_feeHistory. Lỗi TẠM THỜI (429/timeout/
 *     mạng) được retry đúng 1 lần — probe chạy 4 worker song song nên endpoint
 *     yếu có thể 429 tùy thứ tự request; lỗi logic (thiếu method) thì không.
 *   → chọn MAX endpoint nhanh nhất, cache vào PUBLIC_RPC_HEALTH_PATH
 *
 * Cache tươi (dưới PUBLIC_RPC_CACHE_MAX_AGE_HOURS) được webapp-server dùng
 * TRƯỚC danh sách tĩnh; probe hỏng/cache cũ → fallback tĩnh, không bao giờ
 * để browser với danh sách cụt hơn ngưỡng tối thiểu.
 *
 * Thuần + injectable (fetch/now/timeout/log) để test không ra Internet thật.
 * Mọi request đều POST JSON-RPC chỉ đọc với nhịp 150ms, concurrency ≤4.
 */

import fs from "node:fs";
import path from "node:path";
import { PUBLIC_RPC_MIN_ENDPOINTS, PUBLIC_RPC_MAX_ENDPOINTS, PUBLIC_RPC_PROBE_TIMEOUT_MS } from "./shared.mjs";
import { urlLooksCredentialed } from "./webapp-config.mjs";

// Catalog chính thức của chainlist.org (DefiLlama). URL PIN CỨNG: không bao giờ
// nhận URL nguồn từ env/input user — catalog là dữ liệu ngoài, target của nó
// thì còn phải qua 4 lớp guard trước khi tới browser.
export const CHAINLIST_CATALOG_URL = "https://chainlist.org/rpcs.json";

/** chainId Ethereum mainnet — lớp này chỉ phục vụ webapp trên chain 1. */
const ETH_MAINNET_CHAIN_ID = 1;

/** Nhịp giữa 2 request liên tiếp tới CÙNG một endpoint (ms) — không tự tạo burst. */
const PROBE_INTER_REQUEST_DELAY_MS = 150;

/** Số endpoint probe đồng thời tối đa. */
const PROBE_CONCURRENCY = 4;

/**
 * Hostname không bao giờ được probe/inject kể cả khi catalog trả về (SSRF:
 * server sẽ tự gọi vào chính nó hoặc vào dịch vụ nội bộ VPS).
 */
function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.")) return true;
  // 172.16.0.0/12: 172.16–172.31
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Ứng viên thô từ catalog: chain 1 + https + tracking "none". Trả về MẢNG URL
 * duy nhất (giữ thứ tự catalog). Entry thiếu url sai dạng bị bỏ qua lặng lẽ.
 */
export function extractCandidates(catalog) {
  if (!Array.isArray(catalog)) return [];
  const eth = catalog.find((c) => Number(c?.chainId) === ETH_MAINNET_CHAIN_ID);
  if (!eth || !Array.isArray(eth.rpc)) return [];
  const seen = new Set();
  const urls = [];
  for (const entry of eth.rpc) {
    const url = typeof entry === "string" ? entry : entry?.url;
    if (typeof url !== "string" || !url) continue;
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.protocol !== "https:") continue; // browser không dùng wss/https khác
    if (entry?.tracking !== "none") continue; // chỉ nhóm không theo dõi user
    if (isPrivateHost(u.hostname)) continue;
    if (urlLooksCredentialed(url)) continue;
    const key = u.origin + u.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

/**
 * Gửi OPTIONS preflight y như browser làm trước MỌI POST cross-origin có
 * content-type application/json. Tiêu chí: ACAO có mặt trong response.
 * (Blind spot round trước: nodies.app trả ACAO trên POST nhưng IM LẶNG với
 * OPTIONS ⇒ browser chặn POST ⇒ endpoint vô dụng dù POST probe đạt.)
 */
async function preflightRequest(url, { timeoutMs, fetchImpl, origin }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        ...(origin ? { origin } : {}),
      },
      signal: controller.signal,
    });
    const acao = res.headers?.get?.("access-control-allow-origin");
    return { ok: Boolean(acao), status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gửi MỘT request JSON-RPC chỉ đọc. Trả về luôn HTTP status để caller phân biệt
 * 429 (rate limit) với lỗi khác — đúng triệu chứng meowrpc cần bắt được.
 */
async function rpcRequest(url, method, params, { timeoutMs, fetchImpl, origin }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Origin giả lập browser: một số gateway (blastapi, mevblocker) reflect
        // origin trong CORS header — không đặt thì CORS không đo được.
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON (Cloudflare HTML error page…) */
    }
    const allowOrigin = res.headers?.get?.("access-control-allow-origin");
    if (body?.error) {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        cors: Boolean(allowOrigin),
        rateLimited: res.status === 429 || body.error.code === -32005,
        error: String(body.error.message || JSON.stringify(body.error)).slice(0, 160),
      };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, latencyMs, cors: Boolean(allowOrigin), rateLimited: res.status === 429, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, latencyMs, cors: Boolean(allowOrigin), result: body?.result };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const kind = err?.name === "AbortError" ? "timeout" : "network";
    return { ok: false, status: 0, latencyMs, cors: false, rateLimited: false, kind, error: `${err?.name || "Error"}: ${String(err?.message || "").slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe MỘT endpoint: OPTIONS preflight CORS, rồi chuỗi method chỉ đọc mà
 * webapp thật sự dùng (eth_call/getLogs cho tab Tổng quan + Rút tiền,
 * receipt/feeHistory cho luồng ký).
 *
 * Tiêu chí PASS (tất cả):
 *  - OPTIONS preflight có ACAO (browser gọi trực tiếp được)
 *  - chainId === 0x1
 *  - đủ eth_blockNumber, eth_call, eth_getLogs, eth_getTransactionReceipt, eth_feeHistory
 *  - POST response có ACAO
 *  - KHÔNG dính 429/-32005/timeout/mạng trong suốt vòng (mỗi loại lỗi tạm thời retry đúng 1 lần)
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - timeout mỗi request (default PUBLIC_RPC_PROBE_TIMEOUT_MS).
 * @param {number} [opts.interRequestDelayMs] - nhịp giữa 2 request liên tiếp
 *   (default 150ms). Test truyền 0 để chạy nhanh.
 */
export async function probePublicRpc(url, {
  timeoutMs = PUBLIC_RPC_PROBE_TIMEOUT_MS,
  interRequestDelayMs = PROBE_INTER_REQUEST_DELAY_MS,
  fetchImpl = fetch,
  origin = "https://morpho-webapp.local",
} = {}) {
  const call = (method, params) => rpcRequest(url, method, params, { timeoutMs, fetchImpl, origin });
  const delay = () => new Promise((r) => setTimeout(r, interRequestDelayMs));

  const pre = await preflightRequest(url, { timeoutMs, fetchImpl, origin });
  if (!pre.ok) {
    return { ok: false, latencyMs: 0, reason: "preflight OPTIONS không có access-control-allow-origin — browser không gọi trực tiếp được" };
  }

  const chainId = await call("eth_chainId", []);
  if (!chainId.ok) return { ok: false, latencyMs: chainId.latencyMs, reason: `chainId: ${chainId.error}` };
  if (chainId.result !== "0x1") return { ok: false, latencyMs: chainId.latencyMs, reason: `chainId=${chainId.result} (không phải mainnet)` };
  if (!chainId.cors) return { ok: false, latencyMs: chainId.latencyMs, reason: "POST không có access-control-allow-origin" };

  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const SELECTOR_DECIMALS = "0x313ce567";
  const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

  const checks = [
    ["eth_blockNumber", []],
    ["eth_call", [{ to: USDC, data: SELECTOR_DECIMALS }, "latest"]],
    ["eth_getLogs", [{ address: MORPHO_BLUE, fromBlock: "latest", toBlock: "latest" }]],
    ["eth_getTransactionReceipt", ["0x" + "a".repeat(64)]],
    ["eth_feeHistory", ["0x5", "latest", [10, 50, 90]]],
  ];

  let total = chainId.latencyMs;
  for (const [method, params] of checks) {
    // eslint-disable-next-line no-await-in-loop -- nhịp tuần tự có chủ ý: delay giữa các request, không burst
    await delay();
    // eslint-disable-next-line no-await-in-loop
    let r = await call(method, params);
    if (!r.ok && (r.rateLimited || r.kind === "timeout" || r.kind === "network")) {
      // Lỗi tạm thời (429/timeout/mạng): probe chạy 4 worker song song nên endpoint
      // yếu có thể 429 tùy thứ tự request — retry ĐÚNG 1 lần, không retry lỗi logic.
      await delay();
      r = await call(method, params);
    }
    total += r.latencyMs;
    if (!r.ok) {
      return {
        ok: false,
        latencyMs: Math.round(total / (checks.length + 1)),
        reason: r.rateLimited ? `429/-32005 tại ${method}` : `${method}: ${r.error}`,
      };
    }
  }
  return { ok: true, latencyMs: Math.round(total / (checks.length + 1)), reason: null };
}

/**
 * Probe danh sách ứng viên với concurrency giới hạn. Trả về danh sách
 * { url, latencyMs, reason } ĐÃ SẮP XẾP theo latency tăng dần (ok trước).
 */
export async function probeCandidates(urls, opts = {}) {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const idx = cursor++;
      const url = urls[idx];
      const r = await probePublicRpc(url, opts);
      results[idx] = { url, ok: r.ok, latencyMs: r.latencyMs, reason: r.reason };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, urls.length) }, worker));
  return results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return a.latencyMs - b.latencyMs;
  });
}

/**
 * Cache shape v1: { version: 1, verifiedAt, urls, probe, catalogEtag,
 * candidateUrls }. `catalogEtag` + `candidateUrls` phục vụ revalidate 304:
 * chu kỳ sau gửi If-None-Match, nhận 304 thì tái dùng candidateUrls (không
 * parse lại catalog ~2.3MB). Cache v1 cũ thiếu 2 trường vẫn đọc được.
 */
function cacheToJSON(verifiedAt, rows, { catalogEtag = null, candidateUrls = [] } = {}) {
  const probe = {};
  for (const r of rows) probe[r.url] = { latencyMs: r.latencyMs };
  return { version: 1, verifiedAt, catalogEtag, candidateUrls, urls: rows.map((r) => r.url), probe };
}

/**
 * Đọc thô cache để lấy etag + candidate từ lần verify trước (cho If-None-Match).
 * Trả null khi thiếu/hỏng — 304 không có gì để revalidate thì bỏ qua.
 */
function readCachedCatalogState(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (parsed?.version === 1 && typeof parsed.catalogEtag === "string" && Array.isArray(parsed.candidateUrls) && parsed.candidateUrls.length > 0) {
      return { etag: parsed.catalogEtag, candidates: parsed.candidateUrls };
    }
  } catch {
    /* chưa có cache / hỏng — không có gì để revalidate */
  }
  return null;
}

/**
 * Chu trình đầy đủ: fetch catalog → lọc → probe → cache.
 *
 * @returns {Promise<{ ok: boolean, urls: string[], reason?: string }>}
 *   ok=true  — probe đạt ≥ minEndpoints, cache đã ghi (hoặc đã có cache tươi).
 *   ok=false — KHÔNG ghi cache (dưới ngưỡng / catalog lỗi); caller fallback tĩnh.
 */
export async function verifyPublicRpcs({
  catalogUrl = CHAINLIST_CATALOG_URL,
  cachePath,
  minEndpoints = PUBLIC_RPC_MIN_ENDPOINTS,
  maxEndpoints = PUBLIC_RPC_MAX_ENDPOINTS,
  timeoutMs = PUBLIC_RPC_PROBE_TIMEOUT_MS,
  interRequestDelayMs = PROBE_INTER_REQUEST_DELAY_MS,
  fetchImpl = fetch,
  now = Date.now,
  log = (msg) => console.log(msg),
} = {}) {
  const startedAt = now();
  let candidates = [];
  let etagToStore = null;
  try {
    const prev = readCachedCatalogState(cachePath);
    const res = await fetchImpl(catalogUrl, {
      headers: { accept: "application/json", ...(prev ? { "if-none-match": prev.etag } : {}) },
    });
    if (res.status === 304 && prev) {
      candidates = prev.candidates;
      etagToStore = prev.etag;
      log(`[public-rpc-health] catalog 304 (etag giữ nguyên) — tái dùng ${candidates.length} candidate đã cache`);
    } else {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const catalog = await res.json();
      candidates = extractCandidates(catalog);
      etagToStore = res.headers?.get?.("etag") ?? null;
    }
  } catch (err) {
    return { ok: false, urls: [], reason: `catalog: ${err?.message || err}` };
  }
  if (candidates.length === 0) {
    return { ok: false, urls: [], reason: "catalog không còn ứng viên https key-less nào cho chain 1" };
  }

  log(`[public-rpc-health] catalog: ${candidates.length} ứng viên key-less (https, tracking=none) cho chain 1 — bắt đầu probe…`);

  const probed = await probeCandidates(candidates, { timeoutMs, interRequestDelayMs, fetchImpl });
  const passing = probed.filter((r) => r.ok);
  log(
    `[public-rpc-health] probe xong: ${passing.length}/${probed.length} đạt` +
      (passing.length > 0 ? ` (nhanh nhất ${passing[0].url} — ${passing[0].latencyMs}ms)` : "") +
      ` (${Date.now() - startedAt}ms)`
  );

  if (passing.length < minEndpoints) {
    // KHÔNG ghi cache — một vòng probe hỏng không được phép cụt hóa danh sách browser.
    const details = probed
      .filter((r) => !r.ok)
      .slice(0, 8)
      .map((r) => `${r.url} → ${r.reason}`)
      .join("; ");
    return {
      ok: false,
      urls: [],
      reason: `chỉ ${passing.length}/${probed.length} endpoint đạt (< ngưỡng tối thiểu ${minEndpoints}). ${details}`,
    };
  }

  const chosen = passing.slice(0, maxEndpoints);
  const verifiedAt = new Date(now()).toISOString();
  const payload = cacheToJSON(verifiedAt, chosen, { catalogEtag: etagToStore, candidateUrls: candidates });
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${cachePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, cachePath);
  log(`[public-rpc-health] cache ghi ${chosen.length} endpoint → ${cachePath}`);
  return { ok: true, urls: chosen.map((r) => r.url), verifiedAt };
}

/**
 * Đọc cache đã kiểm chứng. Trả { urls, verifiedAt } khi cache HỢP LỆ và CÒN TƯƠI
 * (dưới maxAgeHours kể từ verifiedAt), ngược lại null — caller rơi về danh sách tĩnh.
 * Cache hỏng/không đọc được được đổi tên thành *.corrupt để không đọc lại mãi mãi.
 */
export function readVerifiedCache(cachePath, { maxAgeHours = 48, now = Date.now } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return null; // chưa có cache — bình thường ở lần boot đầu
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try { fs.renameSync(cachePath, `${cachePath}.corrupt`); } catch { /* ignore */ }
    return null;
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.urls) || parsed.urls.length === 0 || typeof parsed.verifiedAt !== "string") {
    try { fs.renameSync(cachePath, `${cachePath}.corrupt`); } catch { /* ignore */ }
    return null;
  }
  const verifiedMs = Date.parse(parsed.verifiedAt);
  if (!Number.isFinite(verifiedMs)) {
    try { fs.renameSync(cachePath, `${cachePath}.corrupt`); } catch { /* ignore */ }
    return null;
  }
  const ageHours = (now() - verifiedMs) / 3_600_000;
  if (ageHours > maxAgeHours) return null; // cũ — không xoá (làm bằng chứng), chỉ bỏ qua
  return { urls: parsed.urls.filter((u) => typeof u === "string" && u.startsWith("https://")), verifiedAt: parsed.verifiedAt };
}
