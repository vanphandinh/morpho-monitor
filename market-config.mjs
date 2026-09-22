import fs from "node:fs";

const MARKET_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Load the explicit multi-market configuration. This is intentionally the
 * only configuration source: deployments must provide MARKETS_FILE.
 */
export function loadMarkets(filePath) {
  if (!filePath) throw new Error("MARKETS_FILE is required");

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read MARKETS_FILE (${filePath}): ${err.message}`);
  }

  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.markets)) {
    throw new Error("markets.json must be { version: 1, markets: [...] }");
  }
  if (parsed.markets.length === 0) throw new Error("markets.json must contain at least one market");

  const ids = new Set();
  return parsed.markets.map((market, index) => {
    if (!market || typeof market !== "object") throw new Error(`markets[${index}] must be an object`);
    if (typeof market.id !== "string" || !MARKET_ID_RE.test(market.id)) {
      throw new Error(`markets[${index}].id must be a 32-byte hex market id`);
    }
    const id = market.id.toLowerCase();
    if (ids.has(id)) throw new Error(`Duplicate market id: ${market.id}`);
    ids.add(id);
    if (typeof market.minLiquidity !== "string" || !/^\d+(?:\.\d+)?$/.test(market.minLiquidity)) {
      throw new Error(`markets[${index}].minLiquidity must be a non-negative decimal string`);
    }
    const multiplier = market.suddenDrainMultiplier;
    if (multiplier != null && (!Number.isFinite(Number(multiplier)) || Number(multiplier) < 1)) {
      throw new Error(`markets[${index}].suddenDrainMultiplier must be at least 1`);
    }
    return {
      id,
      minLiquidity: market.minLiquidity,
      suddenDrainMultiplier: multiplier == null ? null : Number(multiplier),
    };
  });
}
