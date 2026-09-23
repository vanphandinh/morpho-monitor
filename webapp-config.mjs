/**
 * Browser config cho webapp.html — derive từ shared.mjs (A3).
 *
 * Audit 2026-09-23 (C3): webapp-server.mjs đọc thô `process.env.PROXY_RPC_URL`
 * và `.env`/`.env.example` không set biến đó (shared.mjs mới là nơi derive từ
 * WEBAPP_URL + PROXY_PORT). Vì `JSON.stringify` bỏ key `undefined`, browser
 * nhận `proxyRpcUrl: undefined` rồi rơi về `http://127.0.0.1:8545` — trên VPS
 * qua HTTPS địa chỉ đó trỏ về máy của user, không phải server.
 */
import { LENDER_ADDRESS, PROXY_RPC_URL, RPC_URLS } from "./shared.mjs";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Build `window.MORPHO_CONFIG`. Fail fast (thông báo tiếng Việt) khi thiếu
 * lender/proxy URL thay vì để browser chạy với giá trị mặc định sai.
 *
 * @param {object} deps
 * @param {Array<{id: string, minLiquidity: string, suddenDrainMultiplier: number}>} deps.markets
 * @param {string} [deps.lenderAddress]
 * @param {string} [deps.proxyRpcUrl]
 * @param {string[]} [deps.rpcUrls]
 */
export function buildWebappConfig({
  markets,
  lenderAddress = LENDER_ADDRESS,
  proxyRpcUrl = PROXY_RPC_URL,
  rpcUrls = RPC_URLS,
} = {}) {
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error("❌ Không có market nào được cấu hình — kiểm tra config/markets.json (MARKETS_FILE).");
  }

  const lender = typeof lenderAddress === "string" ? lenderAddress.trim() : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(lender) || lender.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      "❌ Thiếu LENDER_ADDRESS trong .env — webapp cần địa chỉ ví lender để xác thực và hiển thị vị thế.\n" +
      "   → Đặt LENDER_ADDRESS=0x... (ví lender) trong .env rồi khởi động lại webapp."
    );
  }

  const proxyUrl = typeof proxyRpcUrl === "string" ? proxyRpcUrl.trim() : "";
  if (!proxyUrl) {
    throw new Error(
      "❌ Không xác định được PROXY_RPC_URL cho browser.\n" +
      "   → Set WEBAPP_URL (proxy URL sẽ tự derive: host + PROXY_PORT) hoặc PROXY_RPC_URL trực tiếp trong .env."
    );
  }

  const urls = Array.isArray(rpcUrls) ? rpcUrls.filter((u) => typeof u === "string" && u.trim()) : [];
  if (urls.length === 0) {
    throw new Error(
      "❌ RPC_URLS đang trống — browser cần ít nhất 1 HTTP RPC endpoint.\n" +
      "   → Set RPC_URLS=https://... trong .env (danh sách phân cách bằng dấu phẩy)."
    );
  }

  return { markets, lenderAddress: lender, proxyRpcUrl: proxyUrl, rpcUrls: urls };
}

/**
 * Inject config vào `</head>`. Escape `<` → `\u003c` để env không thể đóng
 * thẻ script (XSS qua PROXY_RPC_URL / poison env).
 */
export function injectWebappConfig(html, config, { marker = "</head>" } = {}) {
  if (typeof html !== "string" || !html.includes(marker)) {
    throw new Error(`❌ webapp.html thiếu marker ${marker} — không inject được window.MORPHO_CONFIG.`);
  }
  const payload = JSON.stringify(config).replace(/</g, "\\u003c");
  return html.replace(marker, `<script>window.MORPHO_CONFIG=${payload}</script>${marker}`);
}
