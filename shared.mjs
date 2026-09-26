import { formatUnits, recoverMessageAddress } from "viem";
import dns from "node:dns";
import net from "node:net";

// Docker/VPS thường không có route IPv6. ntfy.sh có AAAA; Node 22 Happy Eyeballs
// đua IPv6 rồi ném `fetch failed` / ETIMEDOUT (~250ms) thay vì fallback IPv4.
dns.setDefaultResultOrder("ipv4first");
if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(false);
}

// ============================================================
// CONFIG — tất cả đọc từ biến môi trường (file .env)
// ============================================================
//
// Audit P1.4: file này trước đây là một "túi hỗn hợp" (config + auth token +
// file lock + business rule + format). Phần auth đã tách sang `auth.mjs`, lock
// sang `file-lock.mjs`, business rule sang `monitor-rules.mjs`. Ở lại đây chỉ
// còn config/env, format helper và hai hàm dùng chung không thuộc ba nhóm trên.

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
// Multi-market configuration is intentionally file-backed and there is no
// environment-variable fallback: a deployment must explicitly opt into every
// market it wants to monitor (see market-config.mjs → preflightMarketsFile).
export const MARKETS_FILE = env("MARKETS_FILE", "./config/markets.json");
export const LENDER_ADDRESS = env("LENDER_ADDRESS",
  "0x0000000000000000000000000000000000000000");
export const MORPHO_BLUE_ADDRESS = env("MORPHO_BLUE_ADDRESS",
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");

// ---- RPC ----
export const RPC_URLS = env("RPC_URLS",
  "https://ethereum-rpc.publicnode.com"
).split(",").map(u => u.trim()).filter(Boolean);

// ---- RPC công khai cho browser (webapp) ----
// Round-4 audit (quota, 2026-09-25): RPC_URLS toàn endpoint kèm API key, mà
// webapp public (docker publish :3000) inject config này vào window.MORPHO_CONFIG
// ⇒ mỗi visitor bóc lịch được toàn bộ key. Browser KHÔNG BAO GIỜ nhận RPC_URLS:
// mặc định là 6 endpoint key-less đã PROBE THẬT 2026-09-25 (chainId=0x1, CORS
// mở, latency 100–770ms; chi tiết probe: docs/plans/2026-09-25-round4-quota-rpc.md).
// LƯU Ý: rpc.ankr.com/eth key-less ĐÃ CHẾT (trả -32000 "Unauthorized: You must
// authenticate with an API key") — không thêm lại. Override bằng PUBLIC_RPC_URLS.
export const PUBLIC_RPC_URLS = env("PUBLIC_RPC_URLS",
  [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
    "https://eth-mainnet.public.blastapi.io",
    "https://gateway.tenderly.co/public/mainnet",
    "https://1rpc.io/eth",
    "https://eth.meowrpc.com",
  ].join(",")
).split(",").map(u => u.trim()).filter(Boolean);

// ---- WebSocket RPC (real-time event trigger, tùy chọn) ----
// WSS endpoints để nhận events real-time từ Morpho Blue.
// Để trống để chạy HTTP-only mode. Phân cách bằng dấu phẩy.
// VD: wss://ethereum-rpc.publicnode.com,wss://eth-mainnet.g.alchemy.com/v2/KEY
export const WSS_URLS = env("WSS_URLS",
  "wss://ethereum-rpc.publicnode.com"
).split(",").map(u => u.trim()).filter(Boolean);

// Debounce window cho WebSocket events (ms) — gộp nhiều events trong cùng block
// thành 1 lần check duy nhất để tránh gọi fetchMarket() quá nhiều.
export const WSS_DEBOUNCE_MS = envNum("WSS_DEBOUNCE_MS", 3000);

// ---- Monitor ----
export const MONITOR_INTERVAL_MS = envNum("MONITOR_INTERVAL_MS", 30000);
export const NOTIFICATION_COOLDOWN_MS =
  envNum("NOTIFICATION_COOLDOWN_MINUTES", 30) * 60 * 1000;
export const MAX_NOTIFICATIONS_PER_DAY = envNum("MAX_NOTIFICATIONS_PER_DAY", 10);

// ---- ntfy ----
export const NTFY_SERVER = env("NTFY_SERVER", "https://ntfy.sh");
export const NTFY_TOPIC = env("NTFY_TOPIC", ""); // empty = auto-generate

// ---- VoIP (cypherpunk REST API) ----
// Để trống VOIP_SECRET_KEY để tắt tính năng gọi VoIP
export const VOIP_SECRET_KEY = env("VOIP_SECRET_KEY", "");
export const VOIP_API_URL = env("VOIP_API_URL", "http://localhost:8000");
export const VOIP_TARGET = env("VOIP_TARGET", "sip:0123456789@sip.linphone.org");
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
// Registry v3 (2026-09-24): { version: 3, bundles: { ["marketId@nonce"]: bundle } } — đọc được cả v2.
export const PRESIGNED_FILE = env("PRESIGNED_FILE", "./data/presigned.json");
export const PROXY_PORT = envNum("PROXY_PORT", 8545);
// Bind address for proxy — mặc định localhost. Set PROXY_HOST=0.0.0.0 cho MetaMask mobile / VPS.
export const PROXY_HOST = env("PROXY_HOST", "127.0.0.1");

// ---- Proxy JSON-RPC abuse controls (audit vòng 5, O2) ----
// Relay JSON-RPC KHÔNG xác thực được (ví không gửi header Authorization), nên khi bind public
// chỉ còn hai cách giới hạn: số request mỗi IP, và/hoặc tập method cho phép.
// Mặc định 0/false = giữ nguyên hành vi cũ (không giới hạn).
export const PROXY_RPC_RATE_LIMIT = envNum("PROXY_RPC_RATE_LIMIT", 0);
export const PROXY_ALLOW_PUBLIC_RPC = /^(1|true|yes)$/i.test(env("PROXY_ALLOW_PUBLIC_RPC", ""));
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

/** Max request body size for auth/bundle/presign/RPC (bytes). */
export const MAX_BODY_BYTES = envNum("MAX_BODY_BYTES", 1_048_576); // 1 MiB

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
 * Chuyển token symbol thành dạng thân thiện với TTS.
 * Tách từng ký tự ra để TTS đọc từng chữ cái thay vì cố phát âm.
 * "USDC" → "U S D C", "WETH" → "W E T H"
 */
export function toTtsFriendly(symbol) {
  const s = symbol ?? "token";
  return s.split("").join(" ").toUpperCase();
}

/**
 * Shorten an Ethereum address for display (0x1234...abcd).
 */
export function shortenAddress(address) {
  if (!address) return "N/A";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
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
 * Số byte thân vượt trần mà server còn HÚT-THÊM (không buffer) trước khi cắt
 * kết nối. Đủ rộng cho mọi payload ví thực tế (một eth_call deployless vài MB)
 * để client nhận được 413 thay vì reset.
 */
export const DRAIN_GRACE_BYTES = 4 * 1024 * 1024;

/**
 * Read request body with a hard size cap. Rejects oversized payloads.
 *
 * Audit 2026-09-26 (D13): bản cũ `req.destroy()` NGAY khi thân vượt trần ⇒ socket
 * bị huỷ trước khi caller kịp ghi response, nên MỌI nhánh 413 (webapp-handler ×3,
 * proxy-dispatcher ×2) là code không thể chạy: client chỉ thấy ECONNRESET.
 *
 * Nay khi thân vượt `maxBytes`: bỏ phần đã buffer (không giữ payload quá cỡ trong
 * RAM), hút tiếp phần còn lại tới hết hoặc tới `maxBytes + drainGraceBytes` rồi
 * mới reject — lúc đó kết nối đã sạch, caller ghi được 413 thật. Vượt cả hạn
 * hút-thêm ⇒ cắt kết nối (nhánh DUY NHẤT còn destroy), nên một client gửi vô hạn
 * vẫn bị chặn; trường hợp client nhỏ giọt mãi không kết thúc do `requestTimeout`
 * của Node (mặc định 5 phút) cắt.
 *
 * @param {object} req - Node IncomingMessage
 * @param {number} [maxBytes] - trần kích thước thân request
 * @param {{ drainGraceBytes?: number }} [opts]
 * @returns {Promise<string>}
 */
export function readBodyLimited(req, maxBytes = MAX_BODY_BYTES, { drainGraceBytes = DRAIN_GRACE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let tooLarge = null;
    const drainLimit = maxBytes + drainGraceBytes;
    /** Huỷ socket — CHỈ dùng cho lỗi kết nối và cho thân vượt cả hạn hút-thêm. */
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
      req.destroy();
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        if (!tooLarge) {
          tooLarge = Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" });
        }
        chunks.length = 0; // phần đã đọc chắc chắn bị bỏ ⇒ giải phóng RAM
        if (size > drainLimit) fail(tooLarge);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      // Thân quá cỡ đã được hút hết ⇒ reject TRÊN KẾT NỐI SẠCH để caller ghi 413.
      if (tooLarge) reject(tooLarge);
      else resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => fail(err));
  });
}
