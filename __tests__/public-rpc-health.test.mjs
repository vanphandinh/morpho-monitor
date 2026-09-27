/**
 * Lớp hybrid RPC công khai (2026-09-27): catalog chainlist + probe + cache.
 *
 * Tất cả chạy trên fetch/now GIẢ LẬP — không request Internet thật. Các kịch
 * bản ghim bắt từ probe THẬT 2026-09-27 (docs/plans/2026-09-27-public-rpc-list-update.md):
 *  - meowrpc: 429 thất thường ⇒ bị loại
 *  - flashbots: thiếu eth_call ⇒ bị loại
 *  - blxrbdn: thiếu eth_getLogs ⇒ bị loại
 *  - endpoint không CORS ⇒ bị loại (browser gọi trực tiếp)
 *  - catalog chứa URL credential/private/wss ⇒ bị chặn trước cả probe
 *  - probe hỏng ⇒ KHÔNG ghi cache (không cụt hóa danh sách browser)
 *  - cache cũ/hỏng ⇒ readVerifiedCache trả null ⇒ server fallback tĩnh
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractCandidates,
  probePublicRpc,
  probeCandidates,
  verifyPublicRpcs,
  readVerifiedCache,
  CHAINLIST_CATALOG_URL,
} from "../public-rpc-health.mjs";

// ---------------------------------------------------------------- fixtures
const GOOD_RPC = "https://good.example.com/rpc";
const SLOW_RPC = "https://slow.example.com/rpc";

/**
 * Endpoint giả lập: route theo method. Trả về shape giống response thật
 * (status, headers.get, json()).
 */
function jsonRpcResponse(result, { status = 200, cors = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === "access-control-allow-origin" ? (cors ? "*" : null) : null) },
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  };
}

function errorResponse(status, message, { code = null, cors = true } = {}) {
  return {
    ok: false,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === "access-control-allow-origin" ? (cors ? "*" : null) : null) },
    json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: code ?? -32000, message } }),
  };
}

/**
 * Endpoint khỏe: preflight OPTIONS có ACAO + đủ method probe cần.
 * `preflightCors: false` mô phỏng nodies.app — POST có ACAO nhưng OPTIONS im lặng.
 */
function makeGoodFetcher({ extraBehavior = null, cors = true, preflightCors = true } = {}) {
  return async (url, init = {}) => {
    if (init.method === "OPTIONS") {
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (String(h).toLowerCase() === "access-control-allow-origin" ? (preflightCors ? "*" : null) : null) },
      };
    }
    if (extraBehavior) {
      const override = extraBehavior(url, JSON.parse(init.body));
      if (override) return override;
    }
    const { method } = JSON.parse(init.body);
    const results = {
      eth_chainId: "0x1",
      eth_blockNumber: "0x1234",
      eth_call: "0x0000000000000000000000000000000000000000000000000000000000000006",
      eth_getLogs: [],
      eth_getTransactionReceipt: null,
      eth_feeHistory: { baseFeePerGas: [], gasUsedRatio: [] },
    };
    if (!(method in results)) return errorResponse(200, `method ${method} not supported`);
    return jsonRpcResponse(results[method], { cors });
  };
}

const CATALOG = [
  {
    chainId: 1,
    name: "Ethereum Mainnet",
    rpc: [
      { url: GOOD_RPC, tracking: "none" },
      { url: "wss://wss.example.com/ws", tracking: "none" },
      { url: "http://http.example.com/rpc", tracking: "none" },
      { url: "https://tracked.example.com/rpc", tracking: "yes" },
      { url: "https://eth-mainnet.g.alchemy.com/v2/" + "f".repeat(32), tracking: "none" },
      { url: "https://127.0.0.1:8545", tracking: "none" },
      { url: "https://10.0.0.5:8545", tracking: "none" },
      { url: "https://192.168.1.10:8545", tracking: "none" },
      { url: "https://172.31.0.9:8545", tracking: "none" },
      { url: "https://169.254.1.2:8545", tracking: "none" },
      { url: "https://box.internal:8545", tracking: "none" },
      { url: "https://myserver.local:8545", tracking: "none" },
      { url: "not a url", tracking: "none" },
      { url: "https://localhost:8545", tracking: "none" },
      { url: "https://dup.example.com/rpc", tracking: "none" },
      { url: "https://dup.example.com/rpc?q=1", tracking: "none" },
    ],
  },
  { chainId: 8453, name: "Base", rpc: [{ url: "https://base.example.com/rpc", tracking: "none" }] },
];

// ---------------------------------------------------------------- extractCandidates
describe("extractCandidates — lọc catalog chainlist", () => {
  it("chỉ giữ https + tracking=none + không credential + không host private", () => {
    const urls = extractCandidates(CATALOG);
    expect(urls).toContain(GOOD_RPC);
    expect(urls).toContain("https://dup.example.com/rpc");
    // loại wss / http / tracking!=none / credential / private / rác
    expect(urls).not.toContain("wss://wss.example.com/ws");
    expect(urls).not.toContain("http://http.example.com/rpc");
    expect(urls).not.toContain("https://tracked.example.com/rpc");
    expect(urls).not.toContain("https://eth-mainnet.g.alchemy.com/v2/" + "f".repeat(32));
    expect(urls).not.toContain("https://127.0.0.1:8545");
    expect(urls).not.toContain("https://10.0.0.5:8545");
    expect(urls).not.toContain("https://192.168.1.10:8545");
    expect(urls).not.toContain("https://172.31.0.9:8545");
    expect(urls).not.toContain("https://169.254.1.2:8545");
    expect(urls).not.toContain("https://box.internal:8545");
    expect(urls).not.toContain("https://myserver.local:8545");
    expect(urls).not.toContain("not a url");
    expect(urls).not.toContain("https://localhost:8545");
    // dedup theo origin+pathname
    expect(urls).toHaveLength(2);
  });

  it("chỉ nhận chain 1 (Base bị bỏ)", () => {
    const urls = extractCandidates(CATALOG);
    expect(urls).not.toContain("https://base.example.com/rpc");
  });

  it("catalog rỗng/sai dạng ⇒ mảng rỗng, không throw", () => {
    expect(extractCandidates(null)).toEqual([]);
    expect(extractCandidates({})).toEqual([]);
    expect(extractCandidates([{ chainId: 1 }])).toEqual([]);
    expect(extractCandidates([{ chainId: 1, rpc: "oops" }])).toEqual([]);
  });
});

// ---------------------------------------------------------------- probePublicRpc
describe("probePublicRpc — các lớp lỗi bắt được (ghim từ probe thật 2026-09-27)", () => {
  it("endpoint khỏe ⇒ ok với latency hợp lý", async () => {
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: makeGoodFetcher(), timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.reason).toBe(null);
  });

  // Audit 2026-09-27: probe cũ chỉ nhìn ACAO trên POST response và duyệt nhầm
  // nodies.app — POST trả ACAO nhưng OPTIONS preflight im lặng ⇒ browser chặn.
  it("PREFLIGHT kiểu nodies: OPTIONS không ACAO ⇒ loại trước khi POST (ghim blind spot)", async () => {
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: makeGoodFetcher({ preflightCors: false }), timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/preflight|OPTIONS/i);
  });

  it("preflight request đúng shape (method OPTIONS, ACRM POST, ACRH content-type, origin)", async () => {
    const seen = [];
    const fetcher = async (url, init) => {
      seen.push({ url, method: init.method, headers: init.headers });
      return makeGoodFetcher()(url, init);
    };
    await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    const pre = seen.find((s) => s.method === "OPTIONS");
    expect(pre).toBeDefined();
    expect(pre.headers["Access-Control-Request-Method"]).toBe("POST");
    expect(pre.headers["Access-Control-Request-Headers"]).toBe("content-type");
    expect(pre.headers.origin).toBe("https://morpho-webapp.local");
  });

  it("429 tạm thời ĐƯỢC RETRY 1 lần: 429 lần đầu, OK lần sau ⇒ vẫn đạt", async () => {
    let calls = 0;
    const fetcher = makeGoodFetcher({
      extraBehavior: (_url, body) => {
        if (body.method === "eth_call") {
          calls++;
          if (calls === 1) return errorResponse(429, "Too Many Requests");
        }
        return null;
      },
    });
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(r.ok).toBe(true);
  });

  it("429 LẶP LẠI (kiểu meowrpc thật) ⇒ loại với reason 429/-32005", async () => {
    const fetcher = makeGoodFetcher({
      extraBehavior: (_url, body) =>
        body.method === "eth_call" ? errorResponse(429, "Too Many Requests") : null,
    });
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/429/);
  });

  it("JSON-RPC -32005 lặp lại (HTTP 200) ⇒ loại", async () => {
    const fetcher = makeGoodFetcher({
      extraBehavior: (_url, body) =>
        body.method === "eth_call" ? errorResponse(200, "rate limit", { code: -32005 }) : null,
    });
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/429|-32005|rate/i);
  });

  it("thiếu eth_call kiểu flashbots ⇒ loại (lỗi logic KHÔNG retry)", async () => {
    let calls = 0;
    const fetcher = makeGoodFetcher({
      extraBehavior: (_url, body) => {
        if (body.method === "eth_call") {
          calls++;
          return errorResponse(200, "rpc method is not whitelisted");
        }
        return null;
      },
    });
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/eth_call/);
    expect(calls).toBe(1); // lỗi logic — không lãng phí retry
  });

  it("thiếu eth_getLogs kiểu blxrbdn ⇒ loại", async () => {
    const fetcher = makeGoodFetcher({
      extraBehavior: (_url, body) =>
        body.method === "eth_getLogs" ? errorResponse(200, "method not available") : null,
    });
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/eth_getLogs/);
  });

  it("POST không CORS (kiểu endpoint chỉ dành cho server) ⇒ loại", async () => {
    const fetcher = makeGoodFetcher({ cors: false });
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/access-control-allow-origin/i);
  });

  it("chainId ≠ 0x1 ⇒ loại (không phải mainnet)", async () => {
    const fetcher = makeGoodFetcher({
      extraBehavior: (_url, body) => (body.method === "eth_chainId" ? jsonRpcResponse("0x2105") : null),
    });
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/mainnet|0x2105/i);
  });

  it("mạng chết (AbortError ở mọi request) ⇒ loại ngay ở preflight, không treo", async () => {
    const fetcher = async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/preflight/i);
  });

  it("timeout xảy ra SAU preflight (ở chainId) ⇒ loại với reason chainId", async () => {
    let optionsSeen = false;
    const fetcher = async (url, init = {}) => {
      if (init.method === "OPTIONS") {
        optionsSeen = true;
        return { ok: true, status: 200, headers: { get: () => "*" } };
      }
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(optionsSeen).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/chainId/);
  });

  it("body HTML (Cloudflare error page) ⇒ loại, không crash", async () => {
    const fetcher = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "*" },
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });
    const r = await probePublicRpc(GOOD_RPC, { fetchImpl: fetcher, timeoutMs: 1000 });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------- probeCandidates
describe("probeCandidates — sort + concurrency", () => {
  it("trả đủ kết quả cho mọi URL, đạt lên trước", async () => {
    // fetcher phải xử lý cả OPTIONS preflight (browser contract) — dùng mock chuẩn.
    const base = makeGoodFetcher();
    const fetcher = async (url, init) => base(url, init);
    const results = await probeCandidates([SLOW_RPC, GOOD_RPC], { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(results.map((r) => r.url).sort()).toEqual([GOOD_RPC, SLOW_RPC].sort());
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("trộn khỏe/lỗi ⇒ ok đứng trước trong kết quả", async () => {
    const fetcher = async (url, init) => {
      if (url === SLOW_RPC) return errorResponse(429, "Too Many Requests");
      return makeGoodFetcher()(url, init);
    };
    const results = await probeCandidates([SLOW_RPC, GOOD_RPC], { fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0 });
    expect(results[0].url).toBe(GOOD_RPC);
    expect(results[0].ok).toBe(true);
    expect(results[1].url).toBe(SLOW_RPC);
    expect(results[1].ok).toBe(false);
  });
});

// ---------------------------------------------------------------- verifyPublicRpcs
describe("verifyPublicRpcs — chu trình catalog → probe → cache", () => {
  function tmpFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rpc-health-")), "verified.json");
  }

  it("probe đạt ≥ ngưỡng ⇒ ghi cache đúng shape", async () => {
    const cachePath = tmpFile();
    const fetcher = async (url, init) => {
      if (url === CHAINLIST_CATALOG_URL) return { ok: true, status: 200, json: async () => CATALOG, headers: { get: () => null } };
      return makeGoodFetcher()(url, init);
    };
    const result = await verifyPublicRpcs({
      cachePath,
      minEndpoints: 1,
      maxEndpoints: 8,
      fetchImpl: fetcher,
      timeoutMs: 1000,
      interRequestDelayMs: 0,
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.urls).toContain(GOOD_RPC);
    const onDisk = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.urls).toEqual(result.urls);
    expect(typeof onDisk.verifiedAt).toBe("string");
    expect(onDisk.probe[GOOD_RPC].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("dưới ngưỡng tối thiểu ⇒ ok=false và KHÔNG ghi cache", async () => {
    const cachePath = tmpFile();
    const fetcher = async (url) => {
      if (url === CHAINLIST_CATALOG_URL) return { ok: true, status: 200, json: async () => CATALOG, headers: { get: () => null } };
      // Mọi endpoint đều lỗi kiểu meowrpc
      return errorResponse(429, "Too Many Requests");
    };
    const result = await verifyPublicRpcs({
      cachePath,
      minEndpoints: 1,
      fetchImpl: fetcher,
      timeoutMs: 1000,
      interRequestDelayMs: 0,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ngưỡng|429/i);
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("catalog lỗi (HTTP 500) ⇒ ok=false, không ghi cache, reason nói rõ catalog", async () => {
    const cachePath = tmpFile();
    const fetcher = async () => ({ ok: false, status: 500, json: async () => ({}), headers: { get: () => null } });
    const result = await verifyPublicRpcs({
      cachePath,
      fetchImpl: fetcher,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/catalog/);
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("catalog trả JSON hỏng ⇒ ok=false, không crash", async () => {
    const cachePath = tmpFile();
    const fetcher = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError("bad json");
      },
    });
    const result = await verifyPublicRpcs({ cachePath, fetchImpl: fetcher, log: () => {} });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("maxEndpoints chặn số endpoint ghi cache", async () => {
    const cachePath = tmpFile();
    // catalog với 3 ứng viên khỏe
    const many = {
      chainId: 1,
      rpc: [1, 2, 3].map((i) => ({ url: `https://n${i}.example.com/rpc`, tracking: "none" })),
    };
    const fetcher = async (url, init) => {
      if (url === CHAINLIST_CATALOG_URL) return { ok: true, status: 200, json: async () => [many], headers: { get: () => null } };
      return makeGoodFetcher()(url, init);
    };
    const result = await verifyPublicRpcs({
      cachePath,
      minEndpoints: 1,
      maxEndpoints: 2,
      fetchImpl: fetcher,
      timeoutMs: 1000,
      interRequestDelayMs: 0,
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.urls).toHaveLength(2);
  });

  // ===== ETag revalidate (audit 2026-09-27: lời hứa ETag chưa từng implement) =====
  it("ETag: chu kỳ sau gửi If-None-Match, nhận 304 ⇒ tái dùng candidate đã cache (không parse catalog)", async () => {
    const cachePath = tmpFile();
    let catalogFetches = 0; // đếm HTTP hit tới catalog (304 cũng là 1 fetch)
    let catalogParses = 0;  // đếm json() thật — 304 KHÔNG được parse
    const catalogJson = async () => { catalogParses++; return CATALOG; };
    const etag = '"W/abc123"';
    const fetcher = async (url, init = {}) => {
      if (url === CHAINLIST_CATALOG_URL) {
        catalogFetches++;
        if (init.headers?.["if-none-match"] === etag) {
          return { status: 304, ok: false, headers: { get: () => etag }, json: catalogJson };
        }
        return { ok: true, status: 200, headers: { get: (h) => (String(h).toLowerCase() === "etag" ? etag : null) }, json: catalogJson };
      }
      return makeGoodFetcher()(url, init);
    };
    // Chu kỳ 1: 200 — fetch 1 lần, parse 1 lần, cache ghi etag + candidateUrls
    const r1 = await verifyPublicRpcs({ cachePath, minEndpoints: 1, fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0, log: () => {} });
    expect(r1.ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    expect(onDisk.catalogEtag).toBe(etag);
    expect(onDisk.candidateUrls).toContain(GOOD_RPC);
    expect(catalogFetches).toBe(1);
    expect(catalogParses).toBe(1);

    // Chu kỳ 2: 304 — fetch lại (revalidate) nhưng KHÔNG parse body
    const r2 = await verifyPublicRpcs({ cachePath, minEndpoints: 1, fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0, log: () => {} });
    expect(r2.ok).toBe(true);
    expect(r2.urls).toEqual(r1.urls);
    expect(catalogFetches).toBe(2);
    expect(catalogParses).toBe(1); // json() không được gọi lại ở chu kỳ 304
  });

  it("cache cũ v1 (thiếu catalogEtag/candidateUrls) ⇒ chu kỳ sau fetch 200 bình thường, không gửi If-None-Match", async () => {
    const cachePath = tmpFile();
    fs.writeFileSync(cachePath, JSON.stringify({ version: 1, verifiedAt: new Date().toISOString(), urls: [GOOD_RPC], probe: {} }));
    let sawIfNoneMatch = false;
    const fetcher = async (url, init = {}) => {
      if (url === CHAINLIST_CATALOG_URL) {
        if (init.headers?.["if-none-match"]) sawIfNoneMatch = true;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => CATALOG };
      }
      return makeGoodFetcher()(url, init);
    };
    const r = await verifyPublicRpcs({ cachePath, minEndpoints: 1, fetchImpl: fetcher, timeoutMs: 1000, interRequestDelayMs: 0, log: () => {} });
    expect(r.ok).toBe(true);
    expect(sawIfNoneMatch).toBe(false);
  });
});

// ---------------------------------------------------------------- readVerifiedCache
describe("readVerifiedCache — tuổi + shape + hỏng", () => {
  function tmpFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rpc-cache-")), "verified.json");
  }

  it("cache tươi + đúng shape ⇒ trả urls + verifiedAt", () => {
    const p = tmpFile();
    fs.writeFileSync(p, JSON.stringify({ version: 1, verifiedAt: new Date().toISOString(), urls: [GOOD_RPC], probe: {} }));
    const r = readVerifiedCache(p, { maxAgeHours: 48 });
    expect(r).not.toBe(null);
    expect(r.urls).toEqual([GOOD_RPC]);
  });

  it("cache cũ hơn maxAgeHours ⇒ null (fallback tĩnh), file giữ nguyên làm bằng chứng", () => {
    const p = tmpFile();
    const old = new Date(Date.now() - 49 * 3_600_000).toISOString();
    fs.writeFileSync(p, JSON.stringify({ version: 1, verifiedAt: old, urls: [GOOD_RPC], probe: {} }));
    expect(readVerifiedCache(p, { maxAgeHours: 48 })).toBe(null);
    expect(fs.existsSync(p)).toBe(true); // không xoá — chỉ bỏ qua
  });

  it("cache JSON hỏng ⇒ null và đổi tên .corrupt", () => {
    const p = tmpFile();
    fs.writeFileSync(p, "{oops");
    expect(readVerifiedCache(p)).toBe(null);
    expect(fs.existsSync(p)).toBe(false);
    expect(fs.existsSync(p + ".corrupt")).toBe(true);
  });

  it("cache sai shape (version lạ / urls không phải mảng / thiếu verifiedAt) ⇒ null + .corrupt", () => {
    for (const bad of [
      { version: 2, verifiedAt: new Date().toISOString(), urls: [GOOD_RPC] },
      { version: 1, verifiedAt: new Date().toISOString(), urls: "nope" },
      { version: 1, verifiedAt: 42, urls: [GOOD_RPC] },
    ]) {
      const p = tmpFile();
      fs.writeFileSync(p, JSON.stringify(bad));
      expect(readVerifiedCache(p)).toBe(null);
      expect(fs.existsSync(p + ".corrupt")).toBe(true);
    }
  });

  it("thiếu file ⇒ null (boot đầu tiên, bình thường)", () => {
    expect(readVerifiedCache(path.join(os.tmpdir(), "rpc-khong-ton-tai-" + Date.now() + ".json"))).toBe(null);
  });

  it("lọc bỏ url không phải https trong cache (phòng thủ sâu)", () => {
    const p = tmpFile();
    fs.writeFileSync(p, JSON.stringify({
      version: 1,
      verifiedAt: new Date().toISOString(),
      urls: [GOOD_RPC, "http://evil.example.com", 42],
      probe: {},
    }));
    const r = readVerifiedCache(p, { maxAgeHours: 48 });
    expect(r.urls).toEqual([GOOD_RPC]);
  });
});
