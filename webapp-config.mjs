/**
 * Browser config cho webapp.html — derive từ shared.mjs (A3).
 *
 * Audit 2026-09-23 (C3): webapp-server.mjs đọc thô `process.env.PROXY_RPC_URL`
 * và `.env`/`.env.example` không set biến đó (shared.mjs mới là nơi derive từ
 * WEBAPP_URL + PROXY_PORT). Vì `JSON.stringify` bỏ key `undefined`, browser
 * nhận `proxyRpcUrl: undefined` rồi rơi về `http://127.0.0.1:8545` — trên VPS
 * qua HTTPS địa chỉ đó trỏ về máy của user, không phải server.
 */
import { LENDER_ADDRESS, PROXY_RPC_URL, RPC_URLS, WEBAPP_PASSWORD } from "./shared.mjs";
import { RECOVERY_THRESHOLD_MS } from "./presigned-broadcast.mjs";

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

  // claimRecoveryMs: ngưỡng "claim đã quá hạn recovery" (presigned-broadcast.mjs)
  // để browser hiển thị tuổi claim đang broadcasting mà không copy hằng số (R1).
  return { markets, lenderAddress: lender, proxyRpcUrl: proxyUrl, rpcUrls: urls, claimRecoveryMs: RECOVERY_THRESHOLD_MS };
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

/**
 * Fail closed khi WEBAPP_PASSWORD trống (audit 2026-09-24 P1): không password
 * thì MỌI request đều được coi là đã xác thực — kể cả DELETE /api/presign
 * (xóa bundle đã ký) — trong khi docker-compose publish webapp ra ngoài.
 * Dev local có thể chủ đích tắt bằng WEBAPP_ALLOW_INSECURE=1.
 */
/**
 * Chính sách auth của proxy (audit R3).
 *
 * webapp fail-fast khi thiếu WEBAPP_PASSWORD, nhưng proxy chỉ warn — mà trong dev
 * mode `checkInternalSecret()` trả `true` cho MỌI request, nên bind public mà
 * không có mật khẩu là mở `GET /captured` (liệt kê txHash) và `DELETE /captured`
 * (xoá buffer capture) cho bất kỳ ai vào được port 8545. docker-compose publish
 * đúng port này, nên đây không phải tình huống giả định.
 *
 * Loopback (mặc định) vẫn chạy không cần mật khẩu cho dev. Bind public thì cần
 * mật khẩu, hoặc chấp nhận rủi ro TƯỜNG MINH bằng WEBAPP_ALLOW_INSECURE=1.
 */
export function assertProxyAuthConfig({
  host,
  password = WEBAPP_PASSWORD,
  allowInsecure = /^(1|true|yes)$/i.test(process.env.WEBAPP_ALLOW_INSECURE || ""),
} = {}) {
  const isLoopback = !host || host === "127.0.0.1" || host === "localhost" || host === "::1";
  const publicBind = !isLoopback;
  if (password) return { secure: true, warning: null, publicBind };
  if (!publicBind) return { secure: false, warning: null, publicBind: false };
  if (allowInsecure) {
    return {
      secure: false,
      publicBind: true,
      warning:
        `⚠️  WEBAPP_PASSWORD trống + PROXY_HOST=${host} (public) — /captured và DELETE /captured MỞ cho mọi người (dev mode).` +
        "\n   Chỉ dùng tạm để debug; đặt WEBAPP_PASSWORD trong .env trước khi expose.",
    };
  }
  throw new Error(
    `❌ PROXY_HOST=${host} (public) nhưng WEBAPP_PASSWORD trống — proxy sẽ MỞ /captured và DELETE /captured cho bất kỳ ai.\n` +
    "   → Đặt WEBAPP_PASSWORD=<mật khẩu mạnh> trong .env, hoặc bind loopback (PROXY_HOST=127.0.0.1).\n" +
    "   → Chấp nhận rủi ro có ý thức (KHÔNG dùng trên VPS): set WEBAPP_ALLOW_INSECURE=1."
  );
}

export function assertWebappAuthConfig({
  password = WEBAPP_PASSWORD,
  allowInsecure = /^(1|true|yes)$/i.test(process.env.WEBAPP_ALLOW_INSECURE || ""),
} = {}) {
  if (password) return { secure: true, warning: null };
  if (allowInsecure) {
    return {
      secure: false,
      warning:
        "⚠️  WEBAPP_PASSWORD trống — API webapp MỞ hoàn toàn (dev mode): mọi request đều được coi là đã xác thực." +
        "\n   Chỉ dùng cho local; trên VPS/public phải đặt WEBAPP_PASSWORD trong .env.",
    };
  }
  throw new Error(
    "❌ WEBAPP_PASSWORD trống — webapp sẽ MỞ hoàn toàn (mọi request đều được coi là đã xác thực, kể cả DELETE bundle đã ký).\n" +
    "   → Sản xuất: đặt WEBAPP_PASSWORD=<mật khẩu mạnh> trong .env rồi khởi động lại webapp.\n" +
    "   → Dev local: set WEBAPP_ALLOW_INSECURE=1 để chạy không cần mật khẩu (KHÔNG dùng trên VPS)."
  );
}
