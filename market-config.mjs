import fs from "node:fs";

const MARKET_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/** Error code: the configured markets file does not exist. */
export const MARKETS_FILE_MISSING = "MARKETS_FILE_MISSING";

/**
 * Shared config preflight for every entry point (monitor, webapp, proxy, index).
 * A missing markets file used to fail with a bare ENOENT, which reads as a
 * crash-loop on Docker (three services restarting every ~2s — M4). This throws
 * an actionable Vietnamese message instead, and the file is intentionally
 * gitignored so it must be created or mounted explicitly.
 */
export function preflightMarketsFile(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    const err = new Error(
      "❌ MARKETS_FILE đang trống.\n" +
      "   → Local:  cp config/markets.example.json config/markets.json rồi set MARKETS_FILE=./config/markets.json\n" +
      "   → Docker: thêm volume `- ./config:/app/config:ro` và đặt MARKETS_FILE=/app/config/markets.json"
    );
    err.code = MARKETS_FILE_MISSING;
    throw err;
  }
  if (fs.existsSync(filePath)) return filePath;

  const err = new Error(
    `❌ Không tìm thấy file cấu hình market: ${filePath}\n` +
    "   → Local:  cp config/markets.example.json config/markets.json (rồi sửa market id + ngưỡng)\n" +
    "   → Docker: mount ./config vào /app/config:ro và set MARKETS_FILE=/app/config/markets.json"
  );
  err.code = MARKETS_FILE_MISSING;
  err.filePath = filePath;
  throw err;
}

/**
 * Load the explicit multi-market configuration. This is intentionally the
 * only configuration source: deployments must provide MARKETS_FILE.
 */
export function loadMarkets(filePath) {
  if (!filePath) throw new Error("MARKETS_FILE is required");
  preflightMarketsFile(filePath);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read MARKETS_FILE (${filePath}): ${err.message}`);
  }

  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.markets)) {
    throw new Error("markets.json must be { version: 1, markets: [...] }");
  }
  if (parsed.markets.length === 0 || parsed.markets.length > 9) {
    throw new Error("markets.json must contain between 1 and 9 markets");
  }

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
      suddenDrainMultiplier: multiplier == null ? 2 : Number(multiplier),
    };
  });
}

/** Error codes for HTTP mapping: 400 = malformed input, 404 = unknown configured market. */
export const MARKET_INPUT_INVALID = "MARKET_INPUT_INVALID";
export const MARKET_NOT_CONFIGURED = "MARKET_NOT_CONFIGURED";

function marketError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Normalize a requested configured market ID exactly once at the API boundary. */
export function requireConfiguredMarket(markets, marketId) {
  if (typeof marketId !== "string" || !/^0x[0-9a-f]{64}$/i.test(marketId)) {
    throw marketError(MARKET_INPUT_INVALID, "market must be a configured 32-byte hex market id");
  }
  const normalized = marketId.toLowerCase();
  if (!markets.some((market) => market.id === normalized)) {
    throw marketError(MARKET_NOT_CONFIGURED, "market is not configured");
  }
  return normalized;
}
