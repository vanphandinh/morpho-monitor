import { normalizeMarkets } from "./market-config.mjs";

export const MORPHO_API_URL_DEFAULT = "https://api.morpho.org";

/** Error code: LENDER_ADDRESS is missing, malformed, or the zero address. */
export const AUTO_LENDER_INVALID = "AUTO_LENDER_INVALID";
/** Error code: chain id / API URL / timeout input is invalid. */
export const AUTO_INPUT_INVALID = "AUTO_INPUT_INVALID";
/** Error code: the Morpho API could not be reached or returned an unusable response. */
export const AUTO_DISCOVERY_FAILED = "AUTO_DISCOVERY_FAILED";
/** Error code: the lender has no active supply position on this chain. */
export const AUTO_MARKETS_EMPTY = "AUTO_MARKETS_EMPTY";
/** Error code: discovery found more than the supported nine markets. */
export const AUTO_MARKETS_TOO_MANY = "AUTO_MARKETS_TOO_MANY";
/** Error code: an auto file belongs to another chain. */
export const AUTO_MARKETS_CHAIN_MISMATCH = "AUTO_MARKETS_CHAIN_MISMATCH";
/** Error code: auto mode is not valid for a custom/fork Morpho deployment. */
export const AUTO_MARKETS_CUSTOM_MORPHO = "AUTO_MARKETS_CUSTOM_MORPHO";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MARKET_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_MARKETS = 9;
const MAX_PAGES = 20;
const PAGE_LIMIT = 100;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000];

function discoveryError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function validateDiscoveryInputs({ lenderAddress, chainId, apiUrl, timeoutMs }) {
  if (typeof lenderAddress !== "string" || !ADDRESS_RE.test(lenderAddress)
    || lenderAddress.toLowerCase() === ZERO_ADDRESS) {
    throw discoveryError(
      AUTO_LENDER_INVALID,
      `❌ LENDER_ADDRESS không hợp lệ hoặc là zero address: ${lenderAddress ?? "(empty)"}\n` +
      "   → Set LENDER_ADDRESS=0x... (ví lender) trong .env rồi khởi động lại.",
    );
  }

  const numericChainId = Number(chainId);
  if (!Number.isSafeInteger(numericChainId) || numericChainId <= 0) {
    throw discoveryError(
      AUTO_INPUT_INVALID,
      `❌ CHAIN_ID không hợp lệ cho auto-discovery: ${chainId}\n` +
      "   → Kiểm tra CHAIN_ID trong .env hoặc config/chains.json.",
    );
  }

  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw discoveryError(AUTO_INPUT_INVALID, `❌ MORPHO_API_URL không hợp lệ: ${apiUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw discoveryError(AUTO_INPUT_INVALID, `❌ MORPHO_API_URL phải là http(s): ${apiUrl}`);
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw discoveryError(AUTO_INPUT_INVALID, `❌ MORPHO_API_TIMEOUT_MS không hợp lệ: ${timeoutMs}`);
  }
}

function buildPageUrl({ apiUrl, lenderAddress, chainId, cursor }) {
  const base = apiUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/v0/blue/users/${lenderAddress.toLowerCase()}/positions`);
  url.searchParams.set("active_only", "true");
  url.searchParams.set("chain_ids", String(chainId));
  url.searchParams.set("limit", String(PAGE_LIMIT));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url;
}

async function fetchPage({ apiUrl, lenderAddress, chainId, cursor, fetchImpl, timeoutMs }) {
  const url = buildPageUrl({ apiUrl, lenderAddress, chainId, cursor });

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const wrapped = discoveryError(
      AUTO_DISCOVERY_FAILED,
      `❌ Không gọi được Morpho API: ${err?.message || err}\n` +
      "   → Kiểm tra mạng/DNS tới MORPHO_API_URL, hoặc tạo config/markets.json để chạy file mode.",
    );
    wrapped.retryable = true;
    throw wrapped;
  }

  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 300); } catch { /* ignore */ }
    const wrapped = discoveryError(
      AUTO_DISCOVERY_FAILED,
      `❌ Morpho API trả HTTP ${response.status}${detail ? `: ${detail}` : ""}\n` +
      "   → Kiểm tra mạng/API, hoặc tạo config/markets.json để chạy file mode.",
    );
    wrapped.retryable = isRetryableStatus(response.status);
    wrapped.status = response.status;
    throw wrapped;
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw discoveryError(
      AUTO_DISCOVERY_FAILED,
      `❌ Morpho API trả JSON không hợp lệ: ${err?.message || err}`,
    );
  }

  if (!body || !Array.isArray(body.data)) {
    throw discoveryError(AUTO_DISCOVERY_FAILED, "❌ Morpho API response thiếu mảng data.");
  }
  if (body.cursor != null && typeof body.cursor !== "string") {
    throw discoveryError(AUTO_DISCOVERY_FAILED, "❌ Morpho API response có cursor không hợp lệ.");
  }
  return body;
}

async function withRetry(fn, { retries, sleep }) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!err?.retryable || attempt >= retries) throw err;
      const delay = DEFAULT_RETRY_DELAYS_MS[Math.min(attempt, DEFAULT_RETRY_DELAYS_MS.length - 1)];
      await sleep(delay);
      attempt++;
    }
  }
}

function normalizePositionRows(rows, chainId) {
  const byId = new Map();

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      throw discoveryError(AUTO_DISCOVERY_FAILED, "❌ Morpho API trả position không phải object.");
    }

    const rowChainId = Number(row.chain_id);
    if (!Number.isSafeInteger(rowChainId) || rowChainId <= 0) {
      throw discoveryError(AUTO_DISCOVERY_FAILED, "❌ Morpho API trả position thiếu chain_id hợp lệ.");
    }
    if (rowChainId !== Number(chainId)) continue;

    if (typeof row.market_id !== "string" || !MARKET_ID_RE.test(row.market_id)) {
      throw discoveryError(AUTO_DISCOVERY_FAILED, `❌ Morpho API trả market_id không hợp lệ: ${row.market_id}`);
    }

    let supplyShares;
    try {
      supplyShares = BigInt(row.supply_shares);
    } catch {
      throw discoveryError(
        AUTO_DISCOVERY_FAILED,
        `❌ Morpho API trả supply_shares không hợp lệ cho ${row.market_id}: ${row.supply_shares}`,
      );
    }
    if (supplyShares <= 0n) continue;

    byId.set(row.market_id.toLowerCase(), row);
  }

  return [...byId.keys()].sort();
}

/**
 * Discover the markets where `lenderAddress` currently has a positive supply
 * position on `chainId` (Morpho Blue `/v0/blue/users/{address}/positions`).
 *
 * Returns normalized market configs ready for the existing monitor. Throws an
 * error with `.code` on any unusable result; callers decide whether a stale
 * auto file may be used instead.
 */
export async function discoverMarkets({
  lenderAddress,
  chainId,
  apiUrl = MORPHO_API_URL_DEFAULT,
  minLiquidity = "10000",
  suddenDrainMultiplier = 2,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  retries = 2,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  validateDiscoveryInputs({ lenderAddress, chainId, apiUrl, timeoutMs });

  const maxRetries = Number.isSafeInteger(Number(retries)) && Number(retries) >= 0
    ? Number(retries)
    : 2;
  const rows = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await withRetry(
      () => fetchPage({ apiUrl, lenderAddress, chainId, cursor, fetchImpl, timeoutMs }),
      { retries: maxRetries, sleep },
    );
    rows.push(...body.data);

    if (!body.cursor) {
      const ids = normalizePositionRows(rows, chainId);
      if (ids.length === 0) {
        throw discoveryError(
          AUTO_MARKETS_EMPTY,
          `❌ Auto mode: không tìm thấy market nào LENDER_ADDRESS đang cho vay trên chain ${chainId}.\n` +
          "   → Kiểm tra LENDER_ADDRESS/CHAIN_ID, tạo config/markets.json, hoặc xóa data/markets.auto.json.",
        );
      }
      if (ids.length > MAX_MARKETS) {
        throw discoveryError(
          AUTO_MARKETS_TOO_MANY,
          `❌ Auto mode: tìm thấy ${ids.length} market (>${MAX_MARKETS}).\n` +
          "   → Tạo config/markets.json với tối đa 9 market ưu tiên.",
        );
      }

      const markets = ids.map((id) => ({
        id,
        minLiquidity: String(minLiquidity),
        suddenDrainMultiplier: Number(suddenDrainMultiplier),
      }));
      return normalizeMarkets(
        { version: 1, markets },
        { label: "Morpho API discovery" },
      );
    }

    cursor = body.cursor;
  }

  throw discoveryError(
    AUTO_DISCOVERY_FAILED,
    `❌ Morpho API trả quá ${MAX_PAGES} trang position — không thể hoàn tất discovery.`,
  );
}
