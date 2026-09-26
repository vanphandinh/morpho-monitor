/**
 * Browser config cho webapp.html — derive từ shared.mjs (A3).
 *
 * Audit 2026-09-23 (C3): webapp-server.mjs đọc thô `process.env.PROXY_RPC_URL`
 * và `.env`/`.env.example` không set biến đó (shared.mjs mới là nơi derive từ
 * WEBAPP_URL + PROXY_PORT). Vì `JSON.stringify` bỏ key `undefined`, browser
 * nhận `proxyRpcUrl: undefined` rồi rơi về `http://127.0.0.1:8545` — trên VPS
 * qua HTTPS địa chỉ đó trỏ về máy của user, không phải server.
 */
import { LENDER_ADDRESS, PROXY_RPC_URL, PUBLIC_RPC_URLS, WEBAPP_PASSWORD, PROXY_RPC_RATE_LIMIT, PROXY_ALLOW_PUBLIC_RPC } from "./shared.mjs";
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
 * @param {string[]} [deps.publicRpcUrls] - RPC key-less cho browser (PUBLIC_RPC_URLS).
 *   Round-4 audit (quota, 2026-09-25): KHÔNG BAO GIỜ inject RPC_URLS của server —
 *   toàn bộ endpoint đó mang API key, mà webapp public (docker :3000) serve config
 *   này cho bất kỳ visitor nào. URL khớp mẫu credential bị chặn fail closed.
 */
export function buildWebappConfig({
  markets,
  lenderAddress = LENDER_ADDRESS,
  proxyRpcUrl = PROXY_RPC_URL,
  publicRpcUrls = PUBLIC_RPC_URLS,
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

  const urls = Array.isArray(publicRpcUrls) ? publicRpcUrls.filter((u) => typeof u === "string" && u.trim()) : [];
  if (urls.length === 0) {
    throw new Error(
      "❌ PUBLIC_RPC_URLS đang trống — browser cần ít nhất 1 HTTP RPC endpoint key-less.\n" +
      "   → Set PUBLIC_RPC_URLS=https://... trong .env (danh sách phân cách bằng dấu phẩy).\n" +
      "   → KHÔNG dùng RPC_URLS cho browser: danh sách đó mang API key của server."
    );
  }
  // Fail closed: một URL kèm credential lộ qua webapp public là mất key. Chặn
  // lúc cấu hình thay vì tin vào việc operator nhớ dọn .env.
  const credentialed = urls.filter((u) => urlLooksCredentialed(u));
  if (credentialed.length > 0) {
    throw new Error(
      `❌ PUBLIC_RPC_URLS chứa ${credentialed.length} URL mang API key/credential — webapp public sẽ bóc lịch key.\n` +
      `   → Bỏ các URL sau khỏi PUBLIC_RPC_URLS: ${credentialed.map(maskCredential).join(", ")}\n` +
      "   → RPC_URLS (có key) chỉ dành cho server-side (monitor/proxy), không cho browser."
    );
  }

  // claimRecoveryMs: ngưỡng "claim đã quá hạn recovery" (presigned-broadcast.mjs)
  // để browser hiển thị tuổi claim đang broadcasting mà không copy hằng số (R1).
  return { markets, lenderAddress: lender, proxyRpcUrl: proxyUrl, rpcUrls: urls, claimRecoveryMs: RECOVERY_THRESHOLD_MS };
}

/**
 * URL có mang credential (API key trong path/query) không? Sample matcher cho
 * các provider đang dùng trong deployment này + mọi query `apikey=`. Quy tắc
 * chung: query key ⇒ credential; path hex dài ≥32 ký tự sau hostname provider
 * ⇒ credential. URL lạ (không khớp mẫu nào) được coi là an toàn — guard này
 * chặn thao tác DỮ LIỆU đã biết, không phải whitelist provider.
 */
export function urlLooksCredentialed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (["apikey", "api_key", "key"].some((p) => u.searchParams.has(p))) return true;
  const path = u.pathname;
  if (u.hostname.endsWith("alchemy.com") && /\/v2\/[0-9a-zA-Z_-]+$/.test(path)) return true;
  if (u.hostname.endsWith("drpc.live") && /\/ethereum\/[0-9a-zA-Z_-]+$/.test(path)) return true;
  if (u.hostname.endsWith("chainstack.com") && /\/[0-9a-fA-F]{32,}$/.test(path)) return true;
  if (u.hostname.endsWith("ankr.com") && /^\/eth\/[0-9a-fA-F]{32,}$/.test(path)) return true;
  return false;
}

/** Che phần credential khi in URL vào error message (không lặp lại leak trong log). */
function maskCredential(url) {
  return url.replace(/[0-9a-zA-Z_-]{16,}/g, (m) => (m.includes(".") ? m : `<masked:${m.length}>`)).replace(/([?&](?:apikey|api_key|key)=)[^&]+/gi, "$1<masked>");
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
 *
 * Audit vòng 2 (D3): đặt mật khẩu KHÔNG làm proxy kín — nó chỉ bảo vệ /bundle và
 * /captured (lender-gated). Nhánh JSON-RPC phải công khai vì ví (MetaMask) không
 * gửi được header Authorization, nên bind public = ai vào được port cũng forward
 * được eth_call/eth_getLogs/eth_feeHistory sang RPC_URLS của bạn. Vì vậy khi
 * public + ĐÃ có mật khẩu vẫn trả về `warning` (thay vì im lặng).
 */
export function assertProxyAuthConfig({
  host,
  password = WEBAPP_PASSWORD,
  allowInsecure = /^(1|true|yes)$/i.test(process.env.WEBAPP_ALLOW_INSECURE || ""),
  // O2: có bật giới hạn nào cho nhánh JSON-RPC chưa? (đọc lúc gọi, không phải lúc import)
  rpcRateLimit = PROXY_RPC_RATE_LIMIT,
  allowPublicRpc = PROXY_ALLOW_PUBLIC_RPC,
} = {}) {
  const isLoopback = !host || host === "127.0.0.1" || host === "localhost" || host === "::1";
  const publicBind = !isLoopback;
  if (password) {
    if (!publicBind) return { secure: true, warning: null, publicBind };
    return {
      secure: true,
      publicBind: true,
      warning:
        `⚠️  PROXY_HOST=${host} (public): WEBAPP_PASSWORD chỉ bảo vệ /bundle và /captured (lender).` +
        "\n   JSON-RPC (eth_call, eth_getLogs, eth_feeHistory…) KHÔNG xác thực được — ví không gửi được" +
        "\n   header Authorization — nên ai vào được port này cũng forward được sang RPC_URLS của bạn" +
        "\n   (tốn quota/API key, request mang IP của bạn). Capture thì vẫn chỉ nhận tx từ LENDER_ADDRESS." +
        "\n   → Giới hạn bằng firewall / IP allow-list, hoặc chỉ mở port khi cần MetaMask mobile." +
        (rpcRateLimit > 0 || allowPublicRpc
          ? `\n   → Đang bật:${rpcRateLimit > 0 ? ` PROXY_RPC_RATE_LIMIT=${rpcRateLimit} req/phút/IP` : ""}${allowPublicRpc ? " PROXY_ALLOW_PUBLIC_RPC=1 (chỉ method cho ví)" : ""}`
          : "\n   → Chưa bật gì: đặt PROXY_RPC_RATE_LIMIT=<req/phút/IP> để chặn lạm dụng," +
            "\n     và/hoặc PROXY_ALLOW_PUBLIC_RPC=1 để chỉ cho ví dùng tập method tối thiểu."),
    };
  }
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

/**
 * Fail closed khi WEBAPP_PASSWORD trống (audit 2026-09-24 P1): không password
 * thì MỌI request đều được coi là đã xác thực — kể cả DELETE /api/presign
 * (xóa bundle đã ký) — trong khi docker-compose publish webapp ra ngoài.
 * Dev local có thể chủ đích tắt bằng WEBAPP_ALLOW_INSECURE=1.
 */
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
