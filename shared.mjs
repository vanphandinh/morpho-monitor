import { createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";

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
  "https://ethereum-rpc.publicnode.com," +
  "https://eth.drpc.org," +
  "https://1rpc.io/eth," +
  "https://rpc.mevblocker.io," +
  "https://cloudflare-eth.com"
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
export const WEBAPP_PASSWORD = env("WEBAPP_PASSWORD", "");

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
 * Create a viem public client, trying each RPC URL in order.
 */
export async function createClient(urls = RPC_URLS) {
  for (const url of urls) {
    const client = createPublicClient({
      chain: mainnet,
      transport: http(url, { timeout: 15_000 }),
    });
    try {
      await client.getChainId();
      return client;
    } catch {
      // Try next URL
    }
  }
  throw new Error("No RPC endpoints available");
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

  // 2. Transition check: only alert on 0-to-positive transition
  if (lastSeenLiquidity !== 0n) {
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
