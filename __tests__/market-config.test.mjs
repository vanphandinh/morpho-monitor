import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMarkets, requireConfiguredMarket, preflightMarketsFile, MARKETS_FILE_MISSING } from "../market-config.mjs";
import { emptyRegistry, readRegistry, updateRegistry } from "../presigned-store.mjs";

const ID_A = "0x" + "11".repeat(32);
const ID_B = "0x" + "22".repeat(32);

function temporaryJson(value) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "morpho-test-")), "markets.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("multi-market configuration", () => {
  it("requires a versioned, unique market allow-list", () => {
    const file = temporaryJson({ version: 1, markets: [
      { id: `0x${"11".repeat(32).toUpperCase()}`, minLiquidity: "100.25", suddenDrainMultiplier: 1.5 },
      { id: ID_B, minLiquidity: "0" },
    ] });
    expect(loadMarkets(file)).toEqual([
      { id: ID_A, minLiquidity: "100.25", suddenDrainMultiplier: 1.5 },
      { id: ID_B, minLiquidity: "0", suddenDrainMultiplier: 2 },
    ]);
  });

  it("enforces the 1–9 market limit and shares configured-market validation", () => {
    const nine = Array.from({ length: 9 }, (_, index) => ({
      id: `0x${index.toString(16).padStart(2, "0").repeat(32)}`,
      minLiquidity: "1",
    }));
    const markets = loadMarkets(temporaryJson({ version: 1, markets: nine }));
    expect(requireConfiguredMarket(markets, nine[0].id.toUpperCase())).toBe(nine[0].id);
    expect(() => requireConfiguredMarket(markets, ID_A)).toThrow("not configured");
    expect(() => loadMarkets(temporaryJson({ version: 1, markets: [...nine, { id: ID_A, minLiquidity: "1" }] }))).toThrow("between 1 and 9");
  });

  it("C1/M4: preflight báo lỗi hành động được khi thiếu MARKETS_FILE", () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "morpho-preflight-")), "markets.json");
    const err = (() => { try { preflightMarketsFile(missing); } catch (e) { return e; } })();
    expect(err.code).toBe(MARKETS_FILE_MISSING);
    expect(err.message).toMatch(/markets\.example\.json/); // hướng dẫn copy
    expect(err.message).toMatch(/Docker/); // hướng dẫn mount
    expect(() => preflightMarketsFile("")).toThrow(/MARKETS_FILE/);
    // Mọi entry point (monitor/webapp/proxy/index) đều đi qua loadMarkets.
    expect(() => loadMarkets(missing)).toThrow(/markets\.example\.json/);
  });

  it("config/markets.example.json là mẫu hợp lệ (copy là chạy được)", () => {
    const example = path.join(process.cwd(), "config", "markets.example.json");
    const markets = loadMarkets(example);
    expect(markets).toHaveLength(1);
    expect(markets[0].id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects absent config and duplicate markets", () => {
    expect(() => loadMarkets("")).toThrow("MARKETS_FILE is required");
    const file = temporaryJson({ version: 1, markets: [{ id: ID_A, minLiquidity: "1" }, { id: ID_A, minLiquidity: "1" }] });
    expect(() => loadMarkets(file)).toThrow("Duplicate market id");
  });
});

describe("presigned registry v2", () => {
  it("creates and serializes one registry without accepting legacy data", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-registry-"));
    const file = path.join(dir, "presigned.json");
    expect(readRegistry(file)).toEqual(emptyRegistry());
    await updateRegistry(file, (registry) => { registry.bundles[ID_A] = { version: 2, nonce: 7, withdrawals: [] }; });
    expect(readRegistry(file).bundles[ID_A].nonce).toBe(7);
    fs.writeFileSync(file, JSON.stringify({ version: 1, withdrawals: [] }));
    expect(() => readRegistry(file)).toThrow("version 2");
  });
});
