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
  const n = Number(v);
  return isNaN(n) ? fallback : n;
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
  "https://lb.drpc.live/ethereum/AlqTJ3Pbb0gGqQof0HI4hLunOH9fcQYR8aFWVjewFaCJ," +
  "https://lb.drpc.live/ethereum/AunJZVj7QEqckownxj_qxRnQ2DzbcQYR8aFXVjewFaCJ," +
  "https://ethereum-rpc.publicnode.com," +
  "https://eth-mainnet.g.alchemy.com/v2/usw2oMtZYpOnwPTrHcEGL," +
  "https://eth-mainnet.g.alchemy.com/v2/WeGRNBp6KnWDuMSuyE7r9," +
  "https://rpc.ankr.com/eth/0bda9fd26145d611152a6eec8b728bf7747688a87037d5da4a0bb1feb42977f8," +
  "https://rpc.ankr.com/eth/75c3d8f64c68d868b9e194da044b3f61849506bef26508a419985bfc5c46c338," +
  "https://mainnet.infura.io/v3/a8e97104e75046a58490a844b734c274," +
  "https://mainnet.infura.io/v3/70c484519b7646d7820601e5071474e8," +
  "https://ethereum-mainnet.core.chainstack.com/ea59b26bd098e71a4ad2cf8292ae4f3a," +
  "https://ethereum-mainnet.core.chainstack.com/9a4bbcc8b9369e3c7247274b75736e64"
).split(",").map(u => u.trim()).filter(Boolean);

// ---- Monitor ----
export const MONITOR_INTERVAL_MS = envNum("MONITOR_INTERVAL_MS", 30000);
export const NOTIFICATION_COOLDOWN_MS =
  envNum("NOTIFICATION_COOLDOWN_MINUTES", 30) * 60 * 1000;
export const MAX_NOTIFICATIONS_PER_DAY = envNum("MAX_NOTIFICATIONS_PER_DAY", 10);

// Minimum liquidity threshold (converted from USDC to wei: USDC has 6 decimals)
export const MIN_LIQUIDITY_THRESHOLD =
  BigInt(envNum("MIN_LIQUIDITY_THRESHOLD_USDC", 100)) * 1_000_000n;

// Hệ số ngưỡng giảm thanh khoản đột ngột
// drainThreshold = supplyAssets × SUDDEN_DRAIN_MULTIPLIER
// Mặc định 2: cảnh báo khi liquidity ≤ 2× vị thế lender
// Hỗ trợ số thập phân, vd: 1.5, 2.25
const _drainMultiplier = envNum("SUDDEN_DRAIN_MULTIPLIER", 2);
export const SUDDEN_DRAIN_MULTIPLIER =
  _drainMultiplier >= 1 ? _drainMultiplier : 2;

// ---- ntfy ----
export const NTFY_SERVER = env("NTFY_SERVER", "https://ntfy.sh");
export const NTFY_TOPIC = env("NTFY_TOPIC", ""); // empty = auto-generate

// ---- VoIP (cypherpunk REST API) ----
// Để trống VOIP_SECRET_KEY để tắt tính năng gọi VoIP
export const VOIP_SECRET_KEY = env("VOIP_SECRET_KEY", "");
export const VOIP_API_URL = env("VOIP_API_URL", "http://cypherpunk.chainno.de:8000");
export const VOIP_TARGET = env("VOIP_TARGET", "sip:vanphandinh@sip.linphone.org");
export const VOIP_MAX_RETRIES = envNum("VOIP_MAX_RETRIES", 3);
export const VOIP_RETRY_DELAY_MS = envNum("VOIP_RETRY_DELAY_MS", 5000);

// ---- Webapp ----
export const WEBAPP_URL = env("WEBAPP_URL", "http://localhost:3000");
export const WEBAPP_PORT = envNum("WEBAPP_PORT", 3000);

// ---- SSL/TLS (để trống = HTTP, thiết lập = HTTPS) ----
// Đường dẫn tới fullchain.pem và privkey.pem (Let's Encrypt)
export const SSL_CERT_PATH = env("SSL_CERT_PATH", "");
export const SSL_KEY_PATH = env("SSL_KEY_PATH", "");
export const USE_SSL = !!(SSL_CERT_PATH && SSL_KEY_PATH);

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
 * Create a viem public client with round-robin, retry, and circuit breaker.
 * Delegates to the robust client factory in rpc-client.mjs.
 *
 * Uses the round-robin transport so that requests are distributed evenly
 * across all RPC URLs. Circuit breaker per-URL automatically skips
 * unhealthy endpoints.
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
// AUTH HELPERS (used by both webapp-server and proxy-rpc)
// ============================================================

/**
 * Verify a Bearer token (HMAC-based, verifiable by both webapp-server and proxy-rpc).
 * Returns { address, expiresAt } or null.
 * @param {object} req - Node.js IncomingMessage
 * @param {string} [devAddress="dev"] - address returned in dev mode (no WEBAPP_PASSWORD)
 */
export function verifyToken(req, devAddress = "dev") {
  if (!WEBAPP_PASSWORD) return { address: devAddress, expiresAt: Infinity }; // dev mode
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return verifySessionToken(token);
}

/**
 * Check internal secret (Basic Auth with WEBAPP_PASSWORD).
 * Used for webapp-server ↔ proxy internal communication.
 */
export function checkInternalSecret(req) {
  if (!WEBAPP_PASSWORD) return true;
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Basic ")) return false;
  try {
    const [, encoded] = auth.split(" ");
    const [, pass] = Buffer.from(encoded, "base64").toString("utf-8").split(":");
    return pass === WEBAPP_PASSWORD;
  } catch {
    return false;
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
 * Unified danger-zone logic: triggers when liquidity enters the zone
 * [minLiquidityThreshold, supplyAssets × suddenDrainMultiplier] from outside.
 * Two entry directions:
 *   - "sudden_drain":     từ trên xuống (last > drainThreshold → now ≤ drainThreshold)
 *   - "liquidity_appeared": từ dưới lên (last < threshold → now ≥ threshold)
 *
 * Returns { shouldNotify: boolean, reason: string, scenario: string|null }.
 */

/**
 * Compute drainThreshold = supplyAssets × multiplier.
 * Supports fractional multipliers (e.g., 1.5) via BigInt rational arithmetic.
 */
export function computeDrainThreshold(supplyAssets, multiplier) {
  if (supplyAssets == null || supplyAssets === 0n) return 0n;
  // Guard: multiplier must be a positive finite number (or string that converts to one)
  if (typeof multiplier === "string") {
    multiplier = Number(multiplier);
  }
  if (multiplier == null || typeof multiplier !== "number" || !isFinite(multiplier) || multiplier <= 0) {
    return 0n;
  }
  const str = String(multiplier);
  const dot = str.indexOf(".");
  if (dot === -1) {
    return supplyAssets * BigInt(Number(multiplier));
  }
  // Fractional: 1.5 → (supplyAssets × 15) / 10
  const decimals = str.length - dot - 1;
  const numerator = BigInt(str.replace(".", ""));
  const denominator = 10n ** BigInt(decimals);
  return (supplyAssets * numerator) / denominator;
}

/**
 * Pure function: determine whether a presigned bundle should be broadcast.
 * Returns true only when liquidity is positive AND in the danger zone
 * (at or below the drain threshold).
 */
export function shouldBroadcastPresigned(liquidity, drainThreshold) {
  if (liquidity == null || liquidity === 0n) return false;
  if (drainThreshold == null) return false;
  return liquidity <= drainThreshold;
}

/**
 * Pure function: determine whether a notification should be sent.
 */
export function shouldNotify({
  liquidity,
  lastSeenLiquidity,
  supplyAssets,
  hasNotifiedThisCycle,
  lastNotificationTime,
  notificationsToday,
  notificationDayStart,
  minLiquidityThreshold,
  suddenDrainMultiplier,
  notificationCooldownMs,
  maxNotificationsPerDay,
}) {
  // Guard: không có vị thế → không cần theo dõi
  if (supplyAssets == null || supplyAssets === 0n) {
    return { shouldNotify: false, reason: "no_position", scenario: null };
  }

  let drainThreshold = computeDrainThreshold(supplyAssets, suddenDrainMultiplier);
  // Guard: prevent empty zone when drainThreshold < minLiquidityThreshold
  if (drainThreshold < minLiquidityThreshold) {
    drainThreshold = minLiquidityThreshold;
  }
  const inZone =
    liquidity >= minLiquidityThreshold && liquidity <= drainThreshold;

  // ================================================================
  // Xác định scenario: liquidity đi vào vùng nguy hiểm từ đâu?
  // ================================================================
  let scenario = null;

  if (inZone && lastSeenLiquidity != null) {
    if (lastSeenLiquidity > drainThreshold) {
      // Từ trên xuống: sudden drain
      scenario = "sudden_drain";
    } else if (lastSeenLiquidity < minLiquidityThreshold) {
      // Từ dưới lên: liquidity mới xuất hiện trong vùng nguy hiểm
      scenario = "liquidity_appeared";
    }
    // else: đã ở trong zone từ trước → không phải transition mới
  }

  // ================================================================
  // Không có scenario nào trigger → trả về reason để hiển thị
  // ================================================================
  if (!scenario) {
    let reason;
    if (liquidity < minLiquidityThreshold) {
      reason = "below_threshold";
    } else if (liquidity > drainThreshold) {
      reason = "above_drain_threshold";
    } else {
      // inZone = true nhưng không có transition (đã ở trong zone từ trước)
      reason = "in_zone_no_transition";
    }
    return { shouldNotify: false, reason, scenario: null };
  }

  // ================================================================
  // Shared anti-spam checks (áp dụng cho cả 2 scenario)
  // ================================================================

  // 3. Cycle check: không gửi trùng trong cùng một chu kỳ
  if (hasNotifiedThisCycle) {
    return { shouldNotify: false, reason: "already_notified_this_cycle", scenario };
  }

  // 4. Cooldown check
  const now = Date.now();
  if (now - lastNotificationTime < notificationCooldownMs) {
    return { shouldNotify: false, reason: "cooldown", scenario };
  }

  // 5. Daily limit check (with day-roll detection)
  const dayElapsed = now - notificationDayStart;
  if (dayElapsed > 24 * 60 * 60 * 1000) {
    // Day has rolled over — counters will be reset by caller,
    // so we treat this as 0 notifications today.
  } else if (notificationsToday >= maxNotificationsPerDay) {
    return { shouldNotify: false, reason: "daily_limit", scenario };
  }

  return { shouldNotify: true, reason: "all_checks_passed", scenario };
}
