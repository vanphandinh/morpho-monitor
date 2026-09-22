import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMarkets } from "../market-config.mjs";
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
      { id: ID_B, minLiquidity: "0", suddenDrainMultiplier: null },
    ]);
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
