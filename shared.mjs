import { formatUnits, recoverMessageAddress } from "viem";
import crypto from "node:crypto";

// ============================================================
// CONFIG — tất cả đọc từ biến môi trường (file .env)
// ============================================================

/** Read a string env var with a default fallback. */
export const env = (key, fallback) => process.env[key] ?? fallback;

/** Read a number env var with a default fallback. */
export const envNum = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return Number(v);
};

// ---- Morpho Blue ----
export const MARKET_ID = env("MARKET_ID",
  "0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6");
export const LENDER_ADDRESS = env("LENDER_ADDRESS",
  "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3");
export const MORPHO_BLUE_ADDRESS = env("MORPHO_BLUE_ADDRESS",
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");

// ---- RPC ----
export const RPC_URLS = env("RPC_URLS",
  "https://eth.blockrazor.xyz," +          // 171ms — fastest
  "https://ethereum-rpc.publicnode.com," + // 353ms
  "https://eth.drpc.org," +                // 390ms
  "https://eth.api.pocket.network," +      // 546ms
  "https://0xrpc.io/eth," +                // 591ms
  "https://rpc.flashbots.net," +           // 615ms
  "https://rpc.mevblocker.io," +           // 631ms
  "https://rpc.nodeflare.app/eth/public"   // 905ms
).split(",").map(u => u.trim()).filter(Boolean);

// ---- Monitor ----
export const MONITOR_INTERVAL_MS = envNum("MONITOR_INTERVAL_MS", 30000);
export const NOTIFICATION_COOLDOWN_MS =
  envNum("NOTIFICATION_COOLDOWN_MINUTES", 30) * 60 * 1000;
export const MAX_NOTIFICATIONS_PER_DAY = envNum("MAX_NOTIFICATIONS_PER_DAY", 10);

// Minimum liquidity threshold (converted from USDC to wei: USDC has 6 decimals)
export const MIN_LIQUIDITY_THRESHOLD =
  BigInt(envNum("MIN_LIQUIDITY_THRESHOLD_USDC", 100)) * 1_000_000n;

// ---- ntfy ----
export const NTFY_SERVER = env("NTFY_SERVER", "https://ntfy.sh");
export const NTFY_TOPIC = env("NTFY_TOPIC", ""); // empty = auto-generate

// ---- Webapp ----
export const WEBAPP_URL = env("WEBAPP_URL", "http://localhost:3000");
export const WEBAPP_PORT = envNum("WEBAPP_PORT", 3000);

// ---- Webapp Auth ----
export const WEBAPP_PASSWORD = env("WEBAPP_PASSWORD", ""); // internal secret for proxy↔webapp
export const SESSION_EXPIRY_MS = envNum("SESSION_EXPIRY_HOURS", 24) * 60 * 60 * 1000;
export const CHALLENGE_EXPIRY_MS = envNum("CHALLENGE_EXPIRY_MINUTES", 5) * 60 * 1000;

// ---- Presigned Bundle ----
export const PRESIGNED_FILE = env("PRESIGNED_FILE", "./data/presigned.json");
export const PROXY_PORT = envNum("PROXY_PORT", 8545);
// Proxy URL: cùng host với webapp, port 8545
export const PROXY_RPC_URL = (() => {
  const explicit = env("PROXY_RPC_URL", "");
  if (explicit) return explicit;
  // Derive from WEBAPP_URL: http://host:3000 → http://host:8545
  const webappUrl = env("WEBAPP_URL", "http://127.0.0.1:3000");
  try {
    const u = new URL(webappUrl);
    return `${u.protocol}//${u.hostname}:${PROXY_PORT}`;
  } catch {
    return `http://127.0.0.1:${PROXY_PORT}`;
  }
})();

// ---- Misc ----
export const ETHERSCAN_BASE_URL = "https://etherscan.io";

// ============================================================
// HELPERS
// ============================================================

/**
 * Format a WAD-scaled value (1e18) as a percentage string.
 */
export function wadToPercent(wad) {
  return (Number(wad) / 1e16).toFixed(2) + "%";
}

/**
 * Format a bigint token amount to a human-readable string.
 */
export function formatTokenAmount(amount, decimals, symbol) {
  if (decimals != null) {
    const formatted = formatUnits(amount, decimals);
    return `${formatted} ${symbol ?? "tokens"}`;
  }
  return `${amount.toString()} (raw)`;
}

/**
 * Format APY as a percentage string.
 */
export function formatApy(apy) {
  if (apy == null) return "N/A";
  return (apy * 100).toFixed(4) + "%";
}

/**
 * Shorten an Ethereum address for display (0x1234...abcd).
 */
export function shortenAddress(address) {
  if (!address) return "N/A";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Create a viem public client with fallback, retry, and circuit breaker.
 * Delegates to the robust client factory in rpc-client.mjs.
 *
 * Unlike the old sequential-try approach, this client uses viem's
 * `fallback` transport so that if one RPC URL fails mid-request,
 * subsequent requests automatically try the next URL with backoff.
 */
export async function createClient(urls = RPC_URLS) {
  const { createRobustPublicClient } = await import("./rpc-client.mjs");
  return createRobustPublicClient(urls);
}

/**
 * Recover the Ethereum address that signed a message.
 * Uses viem's recoverMessageAddress for standard personal_sign verification.
 * Returns the recovered address (lowercase) or null on failure.
 */
export async function recoverSignerAddress(message, signature) {
  try {
    const address = await recoverMessageAddress({ message, signature });
    return address.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Create a self-verifiable session token using HMAC-SHA256.
 * Both webapp-server and proxy-rpc can verify tokens independently
 * because they share WEBAPP_PASSWORD as the HMAC secret.
 *
 * Token format: payload.hmac
 *   payload = base64url(address:expiryTimestamp:randomHex)
 *   hmac = hex(HMAC-SHA256(payload, WEBAPP_PASSWORD))
 */
export function createSessionToken(address, expiryMs) {
  const secret = WEBAPP_PASSWORD || "dev-mode-no-secret";
  const random = crypto.randomBytes(16).toString("hex");
  const expiry = Date.now() + expiryMs;
  const payload = Buffer.from(`${address}:${expiry}:${random}`).toString("base64url");
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

/**
 * Verify a self-verifiable session token.
 * Returns { address, expiresAt } or null if invalid/expired.
 */
export function verifySessionToken(token) {
  if (!token) return null;
  const secret = WEBAPP_PASSWORD || "dev-mode-no-secret";
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, hmac] = parts;
  const expectedHmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (hmac !== expectedHmac) return null;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    const [address, expiryStr] = decoded.split(":");
    const expiry = parseInt(expiryStr, 10);
    if (isNaN(expiry) || Date.now() > expiry) return null;
    return { address, expiresAt: expiry };
  } catch {
    return null;
  }
}

// ============================================================
// MONITOR ANTI-SPAM LOGIC (pure function, independently testable)
// ============================================================

/**
 * Pure function: determine whether a notification should be sent.
 * All anti-spam rules live here so they can be unit-tested without
 * mocking any I/O.
 *
 * Returns { shouldNotify: boolean, reason: string }.
 */
export function shouldNotify({
  liquidity,
  lastSeenLiquidity,
  hasNotifiedThisCycle,
  lastNotificationTime,
  notificationsToday,
  notificationDayStart,
  minLiquidityThreshold,
  notificationCooldownMs,
  maxNotificationsPerDay,
}) {
  // 1. Threshold check
  if (liquidity < minLiquidityThreshold) {
    return { shouldNotify: false, reason: "below_threshold" };
  }

  // 2. Transition check: only alert when liquidity crosses above threshold.
  // If it was already above threshold last cycle, this isn't a new event.
  if (lastSeenLiquidity >= minLiquidityThreshold) {
    return { shouldNotify: false, reason: "no_transition" };
  }

  // 3. Cycle check: don't notify twice for the same liquidity event
  if (hasNotifiedThisCycle) {
    return { shouldNotify: false, reason: "already_notified_this_cycle" };
  }

  // 4. Cooldown check
  const now = Date.now();
  if (now - lastNotificationTime < notificationCooldownMs) {
    return { shouldNotify: false, reason: "cooldown" };
  }

  // 5. Daily limit check (with day-roll detection)
  const dayElapsed = now - notificationDayStart;
  if (dayElapsed > 24 * 60 * 60 * 1000) {
    // Day has rolled over — counters will be reset by caller,
    // so we treat this as 0 notifications today.
  } else if (notificationsToday >= maxNotificationsPerDay) {
    return { shouldNotify: false, reason: "daily_limit" };
  }

  return { shouldNotify: true, reason: "all_checks_passed" };
}
