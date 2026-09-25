import {
  VOIP_SECRET_KEY,
  VOIP_API_URL,
  VOIP_TARGET,
  VOIP_MAX_RETRIES,
  VOIP_RETRY_DELAY_MS,
  formatTokenAmount,
  wadToPercent,
  formatApy,
  toTtsFriendly,
} from "./shared.mjs";

// ============================================================
// TOKEN CACHE (module-level, persists across calls)
// ============================================================

/** @type {{ token: string, expiresAt: number } | null} */
let tokenCache = null;

// ============================================================
// INTERNAL HELPERS
// ============================================================
//
// Audit P1.6: các hàm dưới đây nhận `fetchImpl`/`sleepImpl`/`now` qua tham số
// (mặc định là global) và được EXPORT để __tests__/voip.test.mjs import ĐÚNG code
// production thay vì nhân bản nó. Trước đây test có một bản sao song song của cả
// 5 hàm — cùng lớp lỗi mà audit A.1b đã diệt cho webapp-logic.

/** Sleep for `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ============================================================
// BEARER TOKEN MANAGEMENT
// ============================================================

/**
 * Lấy bearer token từ cache hoặc gọi API auth.
 * Token được cache ở module level, tự động refresh khi sắp hết hạn
 * (60 giây trước khi hết hạn) hoặc khi nhận được HTTP 401.
 *
 * @param {string} secretKey - VOIP_SECRET_KEY
 * @param {string} apiUrl - Base URL của VoIP API
 * @returns {Promise<string>} access_token
 */
export async function getBearerToken(secretKey, apiUrl, { fetchImpl = fetch, now = Date.now } = {}) {
  // Cache hit: token còn hạn > 60 giây → dùng lại
  if (tokenCache && now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const response = await fetchImpl(`${apiUrl}/api/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret_key: secretKey }),
  });

  if (!response.ok) {
    throw new Error(
      `VoIP auth thất bại (${response.status}): ${await response.text()}`
    );
  }

  const data = await response.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: now() + data.expires_in * 1000,
  };
  return tokenCache.token;
}

/**
 * Xóa token cache (dùng khi nhận 401 — token không hợp lệ).
 */
export function clearVoipTokenCache() {
  tokenCache = null;
}

// ============================================================
// MESSAGE CONSTRUCTION
// ============================================================

/**
 * Tạo nội dung tin nhắn tiếng Việt cho cuộc gọi VoIP.
 * Plain text, không có markdown, tối ưu cho TTS (text-to-speech).
 * Tối đa 500 ký tự.
 *
 * @param {object} market - Dữ liệu market từ Morpho Blue
 * @param {object} loanToken - Token metadata (symbol, decimals)
 * @param {object} collateralToken - Token metadata (symbol, decimals)
 * @param {object} position - Vị thế lender (supplyAssets)
 * @param {string} scenario - "sudden_drain" | "liquidity_appeared"
 * @returns {string} Tin nhắn tiếng Việt có dấu
 */
export function buildVoipMessage(market, loanToken, collateralToken, position, scenario) {
  const loanSymbol = toTtsFriendly(loanToken?.symbol);
  const collateralSymbol = toTtsFriendly(collateralToken?.symbol);
  const loanDecimals = loanToken?.decimals ?? 18;
  const isSuddenDrain = scenario === "sudden_drain";

  const liquidityStr = formatTokenAmount(market.liquidity, loanDecimals, loanSymbol);
  const supplyStr = formatTokenAmount(position.supplyAssets, loanDecimals, loanSymbol);
  const utilizationStr = wadToPercent(market.utilization);
  const apyStr = formatApy(market.supplyApy);

  if (isSuddenDrain) {
    return (
      `Cảnh báo! Thanh khoản trên thị trường ${collateralSymbol} & ${loanSymbol} đã giảm mạnh. ` +
      `Thanh khoản hiện tại: ${liquidityStr}. ` +
      `Vị thế của bạn: ${supplyStr}. ` +
      `Tỉ lệ sử dụng: ${utilizationStr}. ` +
      `Lãi suất năm: ${apyStr}. ` +
      `Hãy vào trang web để rút tiền ngay.`
    );
  } else {
    return (
      `Thông báo! Thanh khoản đã xuất hiện trên thị trường ${collateralSymbol} & ${loanSymbol}. ` +
      `Thanh khoản hiện tại: ${liquidityStr}. ` +
      `Vị thế của bạn: ${supplyStr}. ` +
      `Tỉ lệ sử dụng: ${utilizationStr}. ` +
      `Lãi suất năm: ${apyStr}. ` +
      `Hãy vào trang web để rút tiền.`
    );
  }
}

// ============================================================
// CALL INITIATION + STATUS POLLING
// ============================================================

/**
 * Gửi yêu cầu tạo cuộc gọi VoIP qua REST API.
 *
 * @param {string} apiUrl - Base URL
 * @param {string} bearerToken - Access token
 * @param {string} target - SIP URI (vd: sip:user@sip.linphone.org)
 * @param {string} message - Nội dung tiếng Việt (plain text)
 * @returns {Promise<{callId: string}>}
 */
export async function initiateCall(apiUrl, bearerToken, target, message, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiUrl}/api/v1/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({
      target,
      message,
      repeat: 2,
      repeat_delay: 1.0,
      callback_url: null,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    // Nếu 401 → token hết hạn, xóa cache để lấy token mới ở lần retry sau
    if (response.status === 401) {
      clearVoipTokenCache();
    }
    throw new Error(
      `VoIP initiateCall thất bại (${response.status}): ${body}`
    );
  }

  const data = await response.json();
  return { callId: data.call_id };
}

/**
 * Poll trạng thái cuộc gọi cho đến khi đạt trạng thái terminal hoặc timeout.
 *
 * Trạng thái terminal: "completed", "failed", "no_answer", "busy"
 * Trạng thái non-terminal: "queued", "synthesizing", "calling"
 *
 * @param {string} apiUrl - Base URL
 * @param {string} bearerToken - Access token
 * @param {string} callId - ID cuộc gọi cần kiểm tra
 * @param {number} [maxPollMs=60000] - Thời gian poll tối đa (ms)
 * @param {number} [pollIntervalMs=2000] - Khoảng cách giữa các lần poll (ms)
 * @returns {Promise<{callId: string, status: string, duration_seconds?: number, error_message?: string}>}
 */
export async function pollCallStatus(
  apiUrl,
  bearerToken,
  callId,
  maxPollMs = 60000,
  pollIntervalMs = 2000,
  { fetchImpl = fetch, sleepImpl = sleep, now = Date.now } = {}
) {
  const startedAt = now();

  while (true) {
    const response = await fetchImpl(`${apiUrl}/api/v1/call/${callId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${bearerToken}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401) {
        clearVoipTokenCache();
      }
      throw new Error(
        `VoIP pollCallStatus thất bại (${response.status}): ${body}`
      );
    }

    const data = await response.json();
    const terminalStatuses = ["completed", "failed", "no_answer", "busy"];

    if (terminalStatuses.includes(data.status)) {
      return {
        callId: data.call_id,
        status: data.status,
        duration_seconds: data.duration_seconds,
        error_message: data.error_message,
      };
    }

    // Kiểm tra timeout
    if (now() - startedAt >= maxPollMs) {
      return {
        callId: data.call_id,
        status: data.status,
      };
    }

    await sleepImpl(pollIntervalMs);
  }
}

// ============================================================
// RETRY LOGIC
// ============================================================

/**
 * Thử gọi VoIP với retry. Retry khi:
 * - Lỗi mạng / HTTP error
 * - Trạng thái terminal không phải "completed" (failed, no_answer, busy)
 *
 * @param {object} config
 * @param {string} config.apiUrl
 * @param {string} config.secretKey
 * @param {string} config.target
 * @param {string} config.message
 * @param {number} config.maxRetries
 * @param {number} config.retryDelayMs
 * @returns {Promise<{sent: boolean, callId?: string, status?: string, attempts: number, error?: string}>}
 */
export async function callWithRetry({
  apiUrl,
  secretKey,
  target,
  message,
  maxRetries,
  retryDelayMs,
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = Date.now,
}) {
  let lastError = null;
  let lastCallId = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Lấy token (từ cache hoặc auth mới)
      const token = await getBearerToken(secretKey, apiUrl, { fetchImpl, now });

      // Tạo cuộc gọi
      const { callId } = await initiateCall(apiUrl, token, target, message, fetchImpl);
      lastCallId = callId;

      // Poll trạng thái
      const result = await pollCallStatus(apiUrl, token, callId, 60000, 2000, { fetchImpl, sleepImpl, now });
      lastStatus = result.status;

      if (result.status === "completed") {
        return {
          sent: true,
          callId,
          status: "completed",
          attempts: attempt,
        };
      }

      // Chỉ retry khi trạng thái terminal rõ ràng thất bại.
      // KHÔNG retry khi poll timeout (non-terminal: calling/synthesizing/queued)
      // vì mỗi lần retry tạo ra một cuộc gọi SIP mới — cuộc gọi cũ vẫn tiếp tục
      // chạy trên server, gây ra nhiều cuộc gọi trùng lặp đến người dùng.
      if (result.status === "failed" || result.status === "no_answer" || result.status === "busy") {
        lastError = new Error(
          `Cuộc gọi kết thúc với trạng thái: ${result.status}` +
            (result.error_message ? ` (${result.error_message})` : "")
        );

        if (attempt < maxRetries) {
          await sleepImpl(retryDelayMs);
          continue; // Thử lại với cuộc gọi mới
        }
      }

      // Non-terminal (poll timeout) hoặc trạng thái không mong đợi:
      // Cuộc gọi đã được tạo, không rõ kết quả cuối cùng.
      // Trả về "unknown" — không tạo thêm cuộc gọi mới.
      if (result.status !== "failed" && result.status !== "no_answer" && result.status !== "busy") {
        return {
          sent: true,
          callId,
          status: result.status || "unknown",
          attempts: attempt,
        };
      }
    } catch (err) {
      lastError = err;
      // Nếu là lỗi auth (401), token cache đã bị xóa trong initiateCall/pollCallStatus
      // Lần retry sau sẽ tự động lấy token mới
      if (attempt < maxRetries) {
        await sleepImpl(retryDelayMs);
      }
    }
  }

  return {
    sent: false,
    callId: lastCallId,
    status: lastStatus,
    attempts: maxRetries,
    error: lastError?.message,
  };
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Gửi thông báo qua cuộc gọi VoIP đến SIP target.
 *
 * Hàm này được gọi từ monitor.mjs trong checkMarkets() (qua notification-dispatch.mjs).
 * Khi VOIP_SECRET_KEY rỗng, hàm trả về { sent: false } ngay lập tức
 * (không gọi API) — đây là cơ chế tắt tính năng VoIP.
 *
 * @param {object} market - Dữ liệu market Morpho Blue
 * @param {object} loanToken - Token metadata
 * @param {object} collateralToken - Token metadata
 * @param {object} position - Vị thế lender
 * @param {string} scenario - "sudden_drain" | "liquidity_appeared"
 * @returns {Promise<{sent: boolean, callId?: string, status?: string, attempts: number}>}
 */
export async function sendVoipNotification(
  market,
  loanToken,
  collateralToken,
  position,
  scenario,
  {
    fetchImpl = fetch,
    sleepImpl = sleep,
    now = Date.now,
    secretKey = VOIP_SECRET_KEY,
    apiUrl = VOIP_API_URL,
    target = VOIP_TARGET,
    maxRetries = VOIP_MAX_RETRIES,
    retryDelayMs = VOIP_RETRY_DELAY_MS,
  } = {}
) {
  // Không có secret key → tắt tính năng VoIP
  if (!secretKey) {
    return { sent: false, attempts: 0 };
  }

  // Tạo nội dung tin nhắn tiếng Việt
  let message = buildVoipMessage(
    market,
    loanToken,
    collateralToken,
    position,
    scenario
  );

  // Đảm bảo không vượt quá 500 ký tự
  if (message.length > 500) {
    message = message.slice(0, 497) + "...";
  }

  // Gọi API với retry
  return callWithRetry({
    apiUrl,
    secretKey,
    target,
    message,
    maxRetries,
    retryDelayMs,
    fetchImpl,
    sleepImpl,
    now,
  });
}
