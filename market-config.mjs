import fs from "node:fs";

const MARKET_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/** Error code: the configured markets file does not exist. */
export const MARKETS_FILE_MISSING = "MARKETS_FILE_MISSING";

/**
 * Shared config preflight for legacy `loadMarkets` callers and manual file
 * reads. A missing markets file used to fail with a bare ENOENT, which reads
 * as a crash-loop on Docker (three services restarting every ~2s — M4). This
 * throws an actionable Vietnamese message instead, and the file is
 * intentionally gitignored so a manual deployment must create or mount it
 * explicitly. Auto-mode entry points call `resolveMarkets`, which only invokes
 * this preflight when the manual file actually exists.
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
 * Validate and normalize a markets document. Shared by manual file loading
 * and Morpho API discovery so both sources enforce the same 1–9 contract.
 */
export function normalizeMarkets(parsed, { label = "markets.json" } = {}) {
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.markets)) {
    throw new Error(`${label} must be { version: 1, markets: [...] }`);
  }
  if (parsed.markets.length === 0 || parsed.markets.length > 9) {
    throw new Error(`${label} must contain between 1 and 9 markets`);
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

/**
 * Load a markets document and keep its top-level metadata (for example the
 * auto-discovery marker) alongside the normalized market list.
 */
export function loadMarketsDocument(filePath) {
  if (!filePath) throw new Error("MARKETS_FILE is required");
  preflightMarketsFile(filePath);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read MARKETS_FILE (${filePath}): ${err.message}`);
  }

  return { markets: normalizeMarkets(parsed), document: parsed };
}

/**
 * Load the explicit multi-market configuration. This remains the manual
 * allow-list; deployments may instead use the auto-discovered file.
 */
export function loadMarkets(filePath) {
  return loadMarketsDocument(filePath).markets;
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
