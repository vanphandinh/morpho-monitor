/**
 * F5 (audit 2026-09-27): cơ chế rebuild HTML của lớp hybrid RPC serving.
 *
 * Trước đây logic này nằm ở top-level webapp-server.mjs (listen + process.exit
 * + state module-level) nên KHÔNG có seam test — giờ tách thành factory
 * `createHybridRpcServing` (webapp-serving.mjs) với mọi phụ thuộc injectable.
 *
 * Hợp đồng ghim:
 *  1. Boot đọc cache verified trước khi build ⇒ request đầu đã dùng list tốt nhất.
 *  2. refreshOnce() OK ⇒ REBUILD HTML: getHtml() trả config mới KHÔNG CẦN RESTART —
 *     đây là behavior cho phép tab mở lâu nhận danh sách RPC mới.
 *  3. probe lỗi (ok:false / throw) ⇒ giữ nguyên serving, KHÔNG throw.
 *  4. Operator override ⇒ lớp hybrid tắt: không đọc cache, không verify, timer null.
 *  5. refreshEnabled=false ⇒ tương tự (PUBLIC_RPC_REFRESH_HOURS=0).
 *  6. startRefreshTimer đăng ký callback refreshOnce với đúng chu kỳ ms, unref'd.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHybridRpcServing, refreshHoursToMs } from "../webapp-serving.mjs";

const MARKET = { id: "0x" + "a".repeat(64), minLiquidity: "100", suddenDrainMultiplier: 2 };
const LENDER = "0x" + "b".repeat(40);
const HTML = "<html><head></head><body>x</body></html>";
const T0 = Date.parse("2026-09-27T00:00:00.000Z");

const STATIC_URLS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://eth-mainnet.public.blastapi.io",
  "https://gateway.tenderly.co/public/mainnet",
  "https://1rpc.io/eth",
  "https://eth.blockrazor.xyz",
  "https://rpc-eth.blockmachine.io",
  "https://rpc.mevblocker.io",
];

function extractConfig(html) {
  const m = html.match(/window\.MORPHO_CONFIG=(\{.*?\})<\/script>/s);
  expect(m, "HTML phải chứa window.MORPHO_CONFIG được inject").toBeTruthy();
  return JSON.parse(m[1]);
}

function tmpCachePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "serving-")), "verified.json");
}

function makeDeps({ overrides = {}, cachedUrls = null, verifyResult = null, verifyThrows = null } = {}) {
  const calls = { readCache: 0, verify: 0, intervals: [] };
  const deps = {
    markets: [MARKET],
    htmlContent: HTML,
    lenderAddress: LENDER,
    proxyRpcUrl: "https://vps.example.com:8545",
    operatorOverrodePublicRpcs: false,
    refreshEnabled: true,
    refreshHoursMs: 3_600_000,
    cachePath: tmpCachePath(),
    maxAgeHours: 48,
    readCache: () => {
      calls.readCache++;
      return cachedUrls ? { urls: cachedUrls, verifiedAt: new Date(T0).toISOString() } : null;
    },
    verify: async () => {
      calls.verify++;
      if (verifyThrows) throw verifyThrows;
      return verifyResult ?? { ok: false, urls: [], reason: "không có verify stub" };
    },
    setIntervalImpl: (fn, ms) => {
      calls.intervals.push({ fn, ms });
      return { unref() {} };
    },
    log: () => {},
    warn: () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe("createHybridRpcServing — F5: rebuild HTML giữa chừng, không restart", () => {
  it("boot: không có cache ⇒ getHtml() phục vụ fallback tĩnh (8 endpoint), rpcVerifiedAt null", () => {
    const { deps } = makeDeps();
    const serving = createHybridRpcServing(deps);
    const cfg = extractConfig(serving.getHtml());
    expect(cfg.rpcUrls).toEqual(STATIC_URLS);
    expect(cfg.rpcVerifiedAt).toBe(null);
  });

  it("boot: có cache tươi ⇒ getHtml() phục vụ verified list NGAY từ request đầu", () => {
    const cached = ["https://cached-a.example.com/rpc", "https://cached-b.example.com/rpc"];
    const { deps } = makeDeps({ cachedUrls: cached });
    const serving = createHybridRpcServing(deps);
    const cfg = extractConfig(serving.getHtml());
    expect(cfg.rpcUrls).toEqual(cached);
    expect(cfg.rpcVerifiedAt).toBe(new Date(T0).toISOString());
  });

  it("REBUILD: refreshOnce() OK ⇒ getHtml() trả config mới, không restart — getHtml đọc mỗi request", async () => {
    const fresh = ["https://fresh-a.example.com", "https://fresh-b.example.com", "https://fresh-c.example.com"];
    const at = "2026-09-27T12:00:00.000Z";
    const { deps, calls } = makeDeps({
      verifyResult: { ok: true, urls: fresh, verifiedAt: at },
    });
    const serving = createHybridRpcServing(deps);
    expect(extractConfig(serving.getHtml()).rpcUrls).toEqual(STATIC_URLS); // trước refresh

    const rebuilt = await serving.refreshOnce();
    expect(rebuilt).toBe(true);
    const cfg = extractConfig(serving.getHtml());
    expect(cfg.rpcUrls).toEqual(fresh); // ← đã đổi mà không restart
    expect(cfg.rpcVerifiedAt).toBe(at);
    expect(calls.verify).toBe(1);
  });

  it("probe ok:false ⇒ giữ nguyên serving hiện tại, không throw", async () => {
    const cached = ["https://cached-a.example.com/rpc"];
    const { deps } = makeDeps({
      cachedUrls: cached,
      verifyResult: { ok: false, urls: [], reason: "chỉ 0/18 đạt" },
    });
    const serving = createHybridRpcServing(deps);
    const before = serving.getHtml();

    await expect(serving.refreshOnce()).resolves.toBe(false);
    expect(extractConfig(serving.getHtml()).rpcUrls).toEqual(cached); // giữ nguyên
    expect(serving.getHtml()).toBe(before); // cùng object — không rebuild
  });

  it("verify throw (lỗi bất ngờ) ⇒ refreshOnce nuốt lỗi, serving nguyên vẹn", async () => {
    const { deps } = makeDeps({
      verifyThrows: new Error("network down"),
    });
    const serving = createHybridRpcServing(deps);
    const before = serving.getHtml();
    await expect(serving.refreshOnce()).resolves.toBe(false);
    expect(serving.getHtml()).toBe(before);
  });

  it("operator override ⇒ hybrid tắt: không đọc cache, không verify, timer null, có log", async () => {
    const logs = [];
    const { deps, calls } = makeDeps({
      overrides: {
        operatorOverrodePublicRpcs: true,
        log: (m) => logs.push(m),
      },
    });
    const serving = createHybridRpcServing(deps);
    expect(calls.readCache).toBe(0); // không đụng cache
    expect(serving.isActive()).toBe(false);

    await expect(serving.refreshOnce()).resolves.toBe(false);
    expect(calls.verify).toBe(0);
    expect(logs.some((l) => l.includes("operator override"))).toBe(true);

    expect(serving.startRefreshTimer()).toBe(null);
  });

  it("refreshEnabled=false (PUBLIC_RPC_REFRESH_HOURS=0) ⇒ tương tự operator override", async () => {
    const { deps, calls } = makeDeps({
      overrides: { refreshEnabled: false },
    });
    const serving = createHybridRpcServing(deps);
    expect(calls.readCache).toBe(0);
    expect(serving.isActive()).toBe(false);
    expect(serving.startRefreshTimer()).toBe(null);
    await expect(serving.refreshOnce()).resolves.toBe(false);
    expect(calls.verify).toBe(0);
  });

  it("startRefreshTimer: đúng callback + chu kỳ ms + unref; sau này tick ⇒ rebuild", async () => {
    const fresh = ["https://tick.example.com/rpc"];
    let verifyFn;
    const { deps, calls } = makeDeps({
      verifyResult: { ok: true, urls: fresh, verifiedAt: new Date(T0).toISOString() },
    });
    // Ghi lại fn interval để mô phỏng tick
    deps.setIntervalImpl = (fn, ms) => {
      verifyFn = fn;
      calls.intervals.push({ ms });
      return { unref() {} };
    };
    const serving = createHybridRpcServing(deps);
    const timer = serving.startRefreshTimer();
    expect(timer).not.toBe(null);
    expect(calls.intervals[0].ms).toBe(3_600_000);

    expect(extractConfig(serving.getHtml()).rpcUrls).toEqual(STATIC_URLS);
    await verifyFn(); // mô phỏng chu kỳ tick
    expect(extractConfig(serving.getHtml()).rpcUrls).toEqual(fresh);
  });

  it("buildWebappConfig throw (input sai) ⇒ lỗi nổ ra lúc boot, không nuốt", () => {
    const { deps } = makeDeps();
    deps.markets = []; // builder fail-fast: không có market
    expect(() => createHybridRpcServing(deps)).toThrow(/markets\.json/);
  });
});

describe("refreshHoursToMs", () => {
  it("24h ⇒ 86_400_000ms; giá trị nhỏ vẫn ≥ 1ms", () => {
    expect(refreshHoursToMs(24)).toBe(86_400_000);
    expect(refreshHoursToMs(0.000001)).toBeGreaterThanOrEqual(1);
  });
});
