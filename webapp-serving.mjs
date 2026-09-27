/**
 * Orchestration của lớp hybrid RPC serving (2026-09-27, tách từ webapp-server.mjs).
 *
 * Sở hữu DUY NHẤT state "danh sách RPC đang phục vụ cho browser":
 *   boot: đọc cache verified (nếu bật + operator không override) → build HTML
 *   refresh: verifyPublicRpcs → OK thì REBUILD HTML, handler đọc MỖI request
 *            ⇒ tab mở lâu nhận config mới không cần F5/restart
 *
 * Tách làm module riêng vì: (a) webapp-server.mjs là bootstrap không test được
 * (listen + process.exit + top-level state) — cơ chế rebuild chưa từng có test
 * (audit vòng 2, F5); (b) một owner cho state verified/serving thay vì các `let`
 * rải trong bootstrap.
 *
 * Thuần + injectable (verify/readCache/log/…): test không ra Internet, không
 * kích hoạt listen, không process.exit — lỗi build THROW để caller quyết định.
 */

import { buildWebappConfig, injectWebappConfig } from "./webapp-config.mjs";
import { verifyPublicRpcs, readVerifiedCache } from "./public-rpc-health.mjs";

/**
 * @param {object} deps
 * @param {Array<{id: string}>} deps.markets - configured market allow-list
 * @param {string} deps.htmlContent - webapp.html raw (đọc 1 lần lúc boot)
 * @param {string} deps.lenderAddress - LENDER_ADDRESS (truyền rõ cho builder — không phụ thuộc env ngầm)
 * @param {string} deps.proxyRpcUrl - PROXY_RPC_URL (truyền rõ cho builder)
 * @param {boolean} deps.operatorOverrodePublicRpcs - PUBLIC_RPC_URLS set trong env?
 * @param {boolean} deps.refreshEnabled - PUBLIC_RPC_REFRESH_HOURS > 0?
 * @param {number} [deps.refreshHoursMs] - chu kỳ refresh nền (ms) khi refreshEnabled
 * @param {string} [deps.cachePath] - đường dẫn cache verified (absolute)
 * @param {number} [deps.maxAgeHours] - cache cũ hơn ⇒ bỏ qua (fallback tĩnh)
 * @param {typeof verifyPublicRpcs} [deps.verify]
 * @param {typeof readVerifiedCache} [deps.readCache]
 * @param {typeof setInterval} [deps.setIntervalImpl]
 * @param {(msg: string) => void} [deps.log]
 * @param {(msg: string) => void} [deps.warn]
 */
export function createHybridRpcServing({
  markets,
  htmlContent,
  lenderAddress,
  proxyRpcUrl,
  operatorOverrodePublicRpcs,
  refreshEnabled,
  refreshHoursMs,
  cachePath,
  maxAgeHours = 48,
  verify = verifyPublicRpcs,
  readCache = readVerifiedCache,
  setIntervalImpl = setInterval,
  log = (msg) => console.log(msg),
  warn = (msg) => console.warn(msg),
} = {}) {
  let verifiedRpcUrls = null;
  let verifiedRpcAt = null;
  let servingConfig = null;
  let servingHtml = null;

  function buildServing() {
    // Throw để caller (bootstrap) quyết định fail-fast; test dùng input hợp lệ.
    servingConfig = buildWebappConfig({
      markets,
      lenderAddress,
      proxyRpcUrl,
      verifiedRpcUrls,
      verifiedAt: verifiedRpcAt,
    });
    servingHtml = injectWebappConfig(htmlContent, servingConfig);
  }

  // Boot: đọc cache verified TRƯỚC khi build lần đầu — request đầu tiên sau
  // restart đã dùng danh sách tốt nhất đã biết, không phải đợi chu kỳ probe.
  if (refreshEnabled && !operatorOverrodePublicRpcs) {
    const cached = readCache(cachePath, { maxAgeHours });
    if (cached) {
      verifiedRpcUrls = cached.urls;
      verifiedRpcAt = cached.verifiedAt;
    }
  }
  buildServing();

  /**
   * Một vòng refresh: verify → OK thì build lại serving HTML/Config.
   * KHÔNG bao giờ throw — probe/catalog lỗi phải giữ nguyên serving hiện tại
   * (webapp vẫn chạy với danh sách cũ), lỗi chỉ đi vào warn/log.
   * @returns {Promise<boolean>} true nếu serving đã được rebuild với list mới.
   */
  async function refreshOnce() {
    if (operatorOverrodePublicRpcs) {
      log("[public-rpc-health] PUBLIC_RPC_URLS được operator override — bỏ qua lớp hybrid.");
      return false;
    }
    if (!refreshEnabled) return false; // PUBLIC_RPC_REFRESH_HOURS=0 — luôn dùng danh sách tĩnh
    try {
      const result = await verify({ cachePath });
      if (result.ok) {
        verifiedRpcUrls = result.urls;
        verifiedRpcAt = result.verifiedAt || verifiedRpcAt;
        buildServing(); // handler đọc getHtml() mỗi request ⇒ tự thấy bản mới
        log(`[public-rpc-health] serving ${servingConfig.rpcUrls.length} endpoint(s) verified lúc ${servingConfig.rpcVerifiedAt}`);
        return true;
      }
      if (result.reason) {
        warn(`[public-rpc-health] probe không đạt — giữ nguyên danh sách hiện tại: ${result.reason}`);
      }
      return false;
    } catch (err) {
      warn(`[public-rpc-health] refresh lỗi (giữ danh sách hiện tại): ${err?.message || err}`);
      return false;
    }
  }

  return {
    /** HTML hiện tại — handler gọi MỖI request GET/HEAD trang chính. */
    getHtml: () => servingHtml,
    /** Config hiện tại — boot log + refresh log. */
    getConfig: () => servingConfig,
    /** Đã bật lớp động và không bị operator override? */
    isActive: () => refreshEnabled && !operatorOverrodePublicRpcs,
    refreshOnce,
    /**
     * Interval refresh nền (unref'd — không giữ process); null khi tắt.
     * Callback là refreshOnce — một chu kỳ verify lỗi không hạ được server.
     */
    startRefreshTimer() {
      if (!this.isActive()) {
        if (operatorOverrodePublicRpcs) {
          log("[public-rpc-health] PUBLIC_RPC_URLS được operator override — dùng danh sách tĩnh, lớp hybrid tắt.");
        }
        return null;
      }
      const timer = setIntervalImpl(() => refreshOnce(), refreshHoursMs);
      timer.unref?.();
      return timer;
    },
  };
}

/** ms cho một chu kỳ refresh từ số giờ (helper để bootstrap không tự nhân). */
export function refreshHoursToMs(hours) {
  return Math.max(1, Math.round(hours * 3_600_000));
}
