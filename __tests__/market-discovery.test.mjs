import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_AUTO_MARKETS_FILE,
  DEFAULT_MANUAL_MARKETS_FILE,
  discoverAndWriteMarkets,
  discoverMarkets,
  resolveMarkets,
  resolveMarketsFilePath,
  writeAutoMarketsFile,
} from "../market-discovery.mjs";

const ID_A = "0x" + "11".repeat(32);
const ID_B = "0x" + "22".repeat(32);
const LENDER = "0x" + "aa".repeat(20);
const MORPHO = "0x" + "bb".repeat(20);
const MARKETS = [{ id: ID_A, minLiquidity: "10000", suddenDrainMultiplier: 2 }];
const execFileAsync = promisify(execFile);

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe("discoverMarkets", () => {
  it("lọc đúng chain, bỏ supply_shares = 0, map threshold mặc định", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return jsonResponse({
        data: [
          { chain_id: 1, market_id: ID_A, supply_shares: "100" },
          { chain_id: 8453, market_id: ID_B, supply_shares: "100" },
          { chain_id: 1, market_id: ID_B, supply_shares: "0" },
        ],
        cursor: null,
      });
    };

    const markets = await discoverMarkets({ lenderAddress: LENDER, chainId: 1, fetchImpl });

    expect(markets).toEqual([
      { id: ID_A, minLiquidity: "10000", suddenDrainMultiplier: 2 },
    ]);
    const url = new URL(calls[0]);
    expect(url.origin).toBe("https://api.morpho.org");
    expect(url.pathname).toBe(`/v0/blue/users/${LENDER}/positions`);
    expect(url.searchParams.get("active_only")).toBe("true");
    expect(url.searchParams.get("chain_ids")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("theo cursor đến hết và sắp xếp id tăng dần", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return jsonResponse({
          data: [{ chain_id: 1, market_id: ID_B, supply_shares: "1" }],
          cursor: "next",
        });
      }
      return jsonResponse({
        data: [{ chain_id: 1, market_id: ID_A, supply_shares: "1" }],
        cursor: null,
      });
    };

    const markets = await discoverMarkets({ lenderAddress: LENDER, chainId: 1, fetchImpl });

    expect(markets.map((market) => market.id)).toEqual([ID_A, ID_B]);
    expect(new URL(calls[1]).searchParams.get("cursor")).toBe("next");
  });

  it("retry lỗi tạm thời rồi thành công", async () => {
    let calls = 0;
    const sleeps = [];
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return jsonResponse({
        data: [{ chain_id: 1, market_id: ID_A, supply_shares: "1" }],
        cursor: null,
      });
    };

    await discoverMarkets({
      lenderAddress: LENDER,
      chainId: 1,
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it("không retry lỗi 4xx", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return jsonResponse({ error: "bad request" }, 400);
    };

    await expect(discoverMarkets({ lenderAddress: LENDER, chainId: 1, fetchImpl }))
      .rejects.toMatchObject({ code: "AUTO_DISCOVERY_FAILED" });
    expect(calls).toBe(1);
  });

  it("4xx và JSON hỏng không được đánh dấu retryable", async () => {
    const badRequest = await discoverMarkets({
      lenderAddress: LENDER,
      chainId: 1,
      fetchImpl: async () => jsonResponse({ error: "bad request" }, 400),
    }).catch((err) => err);
    expect(badRequest.code).toBe("AUTO_DISCOVERY_FAILED");
    expect(badRequest.retryable).toBe(false);

    const badJson = await discoverMarkets({
      lenderAddress: LENDER,
      chainId: 1,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("invalid json"); },
        text: async () => "",
      }),
    }).catch((err) => err);
    expect(badJson.code).toBe("AUTO_DISCOVERY_FAILED");
    expect(badJson.retryable).toBe(false);
  });

  it("0 market active → AUTO_MARKETS_EMPTY", async () => {
    const fetchImpl = async () => jsonResponse({ data: [], cursor: null });

    await expect(discoverMarkets({ lenderAddress: LENDER, chainId: 1, fetchImpl }))
      .rejects.toMatchObject({ code: "AUTO_MARKETS_EMPTY" });
  });

  it("hơn 9 market → AUTO_MARKETS_TOO_MANY", async () => {
    const data = Array.from({ length: 10 }, (_, index) => ({
      chain_id: 1,
      market_id: "0x" + index.toString(16).padStart(2, "0").repeat(32),
      supply_shares: "1",
    }));
    const fetchImpl = async () => jsonResponse({ data, cursor: null });

    await expect(discoverMarkets({ lenderAddress: LENDER, chainId: 1, fetchImpl }))
      .rejects.toMatchObject({ code: "AUTO_MARKETS_TOO_MANY" });
  });

  it("từ chối lender/chain/API URL không hợp lệ", async () => {
    await expect(discoverMarkets({ lenderAddress: "0x0", chainId: 1 }))
      .rejects.toMatchObject({ code: "AUTO_LENDER_INVALID" });
    await expect(discoverMarkets({ lenderAddress: LENDER, chainId: 0 }))
      .rejects.toMatchObject({ code: "AUTO_INPUT_INVALID" });
    await expect(discoverMarkets({ lenderAddress: LENDER, chainId: 1, apiUrl: "ftp://x" }))
      .rejects.toMatchObject({ code: "AUTO_INPUT_INVALID" });
  });
});

function autoDocument(overrides = {}) {
  return {
    version: 1,
    managedBy: "auto",
    chainId: 1,
    morphoBlueAddress: MORPHO,
    lenderAddress: LENDER,
    generatedAt: "2026-11-15T00:00:00.000Z",
    markets: MARKETS,
    ...overrides,
  };
}

describe("auto file persistence", () => {
  it("ghi file auto đúng schema, tạo thư mục cha, không để lại tmp/lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-auto-"));
    const file = path.join(dir, "nested", "markets.auto.json");

    await writeAutoMarketsFile({
      filePath: file,
      markets: MARKETS,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      lenderAddress: "0x" + "AA".repeat(20),
      now: () => new Date("2026-11-15T00:00:00Z"),
    });

    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(document).toMatchObject({
      version: 1,
      managedBy: "auto",
      chainId: 1,
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
      generatedAt: "2026-11-15T00:00:00.000Z",
      markets: MARKETS,
    });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["markets.auto.json"]);
  });

  it("hai writer song song → file cuối vẫn hợp lệ, không còn tmp/lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-auto-race-"));
    const file = path.join(dir, "markets.auto.json");
    const write = () => writeAutoMarketsFile({
      filePath: file,
      markets: MARKETS,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
    });

    await Promise.all([write(), write()]);

    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(document.managedBy).toBe("auto");
    expect(fs.readdirSync(dir)).toEqual(["markets.auto.json"]);
  });

  it("writeAutoMarketsFile → resolveMarkets đọc lại đúng schema", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-auto-roundtrip-"));
    const autoFile = path.join(dir, "data", "markets.auto.json");

    await writeAutoMarketsFile({
      filePath: autoFile,
      markets: MARKETS,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      lenderAddress: LENDER,
    });

    const markets = await resolveMarkets({
      marketsFile: path.join(dir, "missing-manual.json"),
      autoMarketsFile: autoFile,
      lenderAddress: LENDER,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    expect(markets).toEqual(MARKETS);
  });

  it("CLI discover-markets ghi file từ API stub", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-cli-"));
    const autoFile = path.join(dir, "markets.auto.json");
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        data: [{ chain_id: 1, market_id: ID_A, supply_shares: "1" }],
        cursor: null,
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = server.address().port;
      const { stdout } = await execFileAsync(process.execPath, ["discover-markets.mjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CHAIN_ID: "1",
          CHAIN_CONFIG_FILE: path.join(process.cwd(), "config", "chains.json"),
          LENDER_ADDRESS: LENDER,
          MARKETS_FILE: path.join(dir, "missing-manual.json"),
          AUTO_MARKETS_FILE: autoFile,
          MORPHO_API_URL: `http://127.0.0.1:${port}`,
          MORPHO_API_TIMEOUT_MS: "2000",
          AUTO_MIN_LIQUIDITY: "10000",
          AUTO_SUDDEN_DRAIN_MULTIPLIER: "2",
          MORPHO_BLUE_ADDRESS: "",
        },
      });

      expect(stdout).toContain("auto: 1 market");
      const document = JSON.parse(fs.readFileSync(autoFile, "utf8"));
      expect(document.markets).toEqual(MARKETS);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("file thủ công → không gọi discovery, không ghi", async () => {
    const discovery = vi.fn();
    const writeFile = vi.fn();

    const result = await discoverAndWriteMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: (file) => file === "manual.json",
      readDocument: () => ({ markets: MARKETS, document: { version: 1, markets: MARKETS } }),
      discovery,
      writeFile,
    });

    expect(result).toEqual({ mode: "manual", markets: MARKETS });
    expect(discovery).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("không có file thủ công/auto → discovery rồi ghi auto", async () => {
    const writeFile = vi.fn(async () => {});

    const result = await discoverAndWriteMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: () => false,
      discovery: async () => MARKETS,
      writeFile,
      lenderAddress: LENDER,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      canonicalMorphoBlueAddress: MORPHO,
    });

    expect(result).toEqual({ mode: "auto", markets: MARKETS });
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "auto.json",
      markets: MARKETS,
    }));
  });

  it("lỗi tạm thời + đã có file auto → dùng file cũ, warning", async () => {
    const warn = vi.fn();
    const writeFile = vi.fn();

    const result = await discoverAndWriteMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: (file) => file === "auto.json",
      readDocument: () => ({ markets: MARKETS, document: autoDocument() }),
      discovery: async () => {
        throw Object.assign(new Error("timeout"), { code: "AUTO_DISCOVERY_FAILED", retryable: true });
      },
      writeFile,
      logger: { log: vi.fn(), warn },
      lenderAddress: LENDER,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      canonicalMorphoBlueAddress: MORPHO,
    });

    expect(result.mode).toBe("stale");
    expect(result.markets).toEqual(MARKETS);
    expect(writeFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("lỗi không transient + đã có file auto → reject, không ghi", async () => {
    const writeFile = vi.fn();

    await expect(discoverAndWriteMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: (file) => file === "auto.json",
      readDocument: () => ({ markets: MARKETS, document: autoDocument() }),
      discovery: async () => {
        throw Object.assign(new Error("400"), { code: "AUTO_DISCOVERY_FAILED", retryable: false });
      },
      writeFile,
      logger: { log: vi.fn(), warn: vi.fn() },
      lenderAddress: LENDER,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      canonicalMorphoBlueAddress: MORPHO,
    })).rejects.toMatchObject({ code: "AUTO_DISCOVERY_FAILED" });

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("auto file của lender khác → không ghi đè", async () => {
    const discovery = vi.fn();
    const writeFile = vi.fn();

    await expect(discoverAndWriteMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: (file) => file === "auto.json",
      readDocument: () => ({
        markets: MARKETS,
        document: autoDocument({ lenderAddress: "0x" + "cc".repeat(20) }),
      }),
      discovery,
      writeFile,
      logger: { log: vi.fn(), warn: vi.fn() },
      lenderAddress: LENDER,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      canonicalMorphoBlueAddress: MORPHO,
    })).rejects.toMatchObject({ code: "AUTO_LENDER_MISMATCH" });

    expect(discovery).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writeAutoMarketsFile từ chối lender không hợp lệ", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-auto-lender-"));
    await expect(writeAutoMarketsFile({
      filePath: path.join(dir, "markets.auto.json"),
      markets: MARKETS,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      lenderAddress: "0x0000000000000000000000000000000000000000",
    })).rejects.toMatchObject({ code: "AUTO_LENDER_INVALID" });
  });

  it("0 market hoặc >9 market → không ghi đè file auto cũ", async () => {
    for (const code of ["AUTO_MARKETS_EMPTY", "AUTO_MARKETS_TOO_MANY"]) {
      const writeFile = vi.fn();

      await expect(discoverAndWriteMarkets({
        marketsFile: "manual.json",
        autoMarketsFile: "auto.json",
        fileExists: (file) => file === "auto.json",
        readDocument: () => ({ markets: MARKETS, document: autoDocument() }),
        discovery: async () => {
          throw Object.assign(new Error(code), { code });
        },
        writeFile,
        logger: { log: vi.fn(), warn: vi.fn() },
        lenderAddress: LENDER,
        chainId: 1,
        morphoBlueAddress: MORPHO,
        canonicalMorphoBlueAddress: MORPHO,
      })).rejects.toMatchObject({ code });

      expect(writeFile).not.toHaveBeenCalled();
    }
  });

  it("auto file của chain/Morpho khác → không ghi đè", async () => {
    for (const [document, code] of [
      [autoDocument({ chainId: 8453 }), "AUTO_MARKETS_CHAIN_MISMATCH"],
      [autoDocument({ morphoBlueAddress: "0x" + "22".repeat(20) }), "AUTO_MARKETS_CUSTOM_MORPHO"],
    ]) {
      const discovery = vi.fn();
      const writeFile = vi.fn();

      await expect(discoverAndWriteMarkets({
        marketsFile: "manual.json",
        autoMarketsFile: "auto.json",
        fileExists: (file) => file === "auto.json",
        readDocument: () => ({ markets: MARKETS, document }),
        discovery,
        writeFile,
        lenderAddress: LENDER,
        chainId: 1,
        morphoBlueAddress: MORPHO,
        canonicalMorphoBlueAddress: MORPHO,
      })).rejects.toMatchObject({ code });

      expect(discovery).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    }
  });
});

describe("resolveMarketsFilePath", () => {
  it("env rỗng hoặc whitespace dùng default dưới baseDir", () => {
    expect(resolveMarketsFilePath("/app", "", DEFAULT_MANUAL_MARKETS_FILE))
      .toBe(path.resolve("/app", DEFAULT_MANUAL_MARKETS_FILE));
    expect(resolveMarketsFilePath("/app", "   ", DEFAULT_AUTO_MARKETS_FILE))
      .toBe(path.resolve("/app", DEFAULT_AUTO_MARKETS_FILE));
    expect(resolveMarketsFilePath("/app", undefined, DEFAULT_AUTO_MARKETS_FILE))
      .toBe(path.resolve("/app", DEFAULT_AUTO_MARKETS_FILE));
  });

  it("relative path dưới baseDir; absolute path giữ nguyên", () => {
    expect(resolveMarketsFilePath("/app", "./config/markets.json", DEFAULT_MANUAL_MARKETS_FILE))
      .toBe(path.resolve("/app", "./config/markets.json"));

    const absolute = path.join(os.tmpdir(), "morpho", "markets.auto.json");
    expect(resolveMarketsFilePath("/app", absolute, DEFAULT_AUTO_MARKETS_FILE)).toBe(absolute);
  });
});

describe("wiring", () => {
  it("entrypoint chạy discover-markets trước start_service", () => {
    const entry = fs.readFileSync(new URL("../docker-entrypoint.sh", import.meta.url), "utf8");
    expect(entry.indexOf("discover-markets.mjs")).toBeGreaterThan(-1);
    expect(entry.indexOf("discover-markets.mjs")).toBeLessThan(entry.indexOf('start_service "MONITOR"'));
  });

  it("package có script discover; shared có auto path mặc định", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["markets:discover"]).toBe("node --env-file=.env discover-markets.mjs");
    const shared = fs.readFileSync(new URL("../shared.mjs", import.meta.url), "utf8");
    expect(shared).toContain('env("AUTO_MARKETS_FILE", "./data/markets.auto.json")');
  });

  it("cả 4 entry point dùng resolveMarkets, không gọi loadMarkets trực tiếp", () => {
    for (const name of ["index.mjs", "monitor.mjs", "webapp-server.mjs", "proxy-rpc.mjs"]) {
      const src = fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
      expect(src).toContain("resolveMarkets(");
      expect(src).not.toMatch(/\bloadMarkets\s*\(/);
    }
  });

  it("webapp-server resolve path qua helper, default khi env rỗng", () => {
    const src = fs.readFileSync(new URL("../webapp-server.mjs", import.meta.url), "utf8");
    expect(src).toContain("resolveMarketsFilePath(__dirname, MARKETS_FILE, DEFAULT_MANUAL_MARKETS_FILE)");
    expect(src).toContain("resolveMarketsFilePath(__dirname, AUTO_MARKETS_FILE, DEFAULT_AUTO_MARKETS_FILE)");
    expect(src).not.toContain("path.resolve(__dirname, MARKETS_FILE)");
  });
});

describe("resolveMarkets", () => {
  it("file thủ công → đọc file, không discovery", async () => {
    const discovery = vi.fn();

    const markets = await resolveMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: (file) => file === "manual.json",
      readDocument: () => ({ markets: MARKETS, document: { version: 1, markets: MARKETS } }),
      discovery,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    expect(markets).toEqual(MARKETS);
    expect(discovery).not.toHaveBeenCalled();
  });

  it("không có file thủ công + có file auto → đọc auto, log auto", async () => {
    const logs = [];
    const discovery = vi.fn();

    const markets = await resolveMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: (file) => file === "auto.json",
      readDocument: () => ({ markets: MARKETS, document: autoDocument() }),
      discovery,
      lenderAddress: LENDER,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      logger: { log: (message) => logs.push(message), warn: vi.fn() },
    });

    expect(markets).toEqual(MARKETS);
    expect(discovery).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/auto/);
  });

  it("auto file của chain khác → từ chối", async () => {
    await expect(resolveMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: (file) => file === "auto.json",
      readDocument: () => ({ markets: MARKETS, document: autoDocument({ chainId: 8453 }) }),
      lenderAddress: LENDER,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      logger: { log: vi.fn(), warn: vi.fn() },
    })).rejects.toMatchObject({ code: "AUTO_MARKETS_CHAIN_MISMATCH" });
  });

  it("auto file của lender khác → từ chối", async () => {
    await expect(resolveMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: (file) => file === "auto.json",
      readDocument: () => ({
        markets: MARKETS,
        document: autoDocument({ lenderAddress: "0x" + "cc".repeat(20) }),
      }),
      lenderAddress: LENDER,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      logger: { log: vi.fn(), warn: vi.fn() },
    })).rejects.toMatchObject({ code: "AUTO_LENDER_MISMATCH" });
  });

  it("cả hai file đều thiếu → discovery RAM", async () => {
    const discovery = vi.fn(async () => MARKETS);

    const markets = await resolveMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: () => false,
      discovery,
      lenderAddress: LENDER,
      chainId: 1,
      morphoBlueAddress: MORPHO,
      canonicalMorphoBlueAddress: MORPHO,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    expect(markets).toEqual(MARKETS);
    expect(discovery).toHaveBeenCalledOnce();
  });

  it("custom Morpho + không có file → từ chối auto", async () => {
    await expect(resolveMarkets({
      marketsFile: "manual.json",
      autoMarketsFile: "auto.json",
      fileExists: () => false,
      lenderAddress: LENDER,
      chainId: 1,
      morphoBlueAddress: "0x" + "11".repeat(20),
      canonicalMorphoBlueAddress: "0x" + "22".repeat(20),
      logger: { log: vi.fn(), warn: vi.fn() },
    })).rejects.toMatchObject({ code: "AUTO_MARKETS_CUSTOM_MORPHO" });
  });
});
