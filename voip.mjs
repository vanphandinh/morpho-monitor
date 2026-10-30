import {
  VOIP_SECRET_KEY,
  VOIP_API_URL,
  VOIP_TARGET,
  VOIP_MAX_RETRIES,
  VOIP_RETRY_DELAY_MS,
  toTtsFriendly,
} from "./shared.mjs";

// ============================================================
// TTS NUMBER FORMAT
// ============================================================
//
// Số của `formatUnits` không đọc được bằng tiếng Việt: "2450000" bị provider
// gom hàng nghìn kiểu Anh ("2,450,000") rồi đọc dấu "," như dấu thập phân,
// còn "12345.678901" thành 6 chữ số lẻ rời rạc. Ba hàm dưới đây đổi sang câu
// đọc được: đơn vị lớn (nghìn/triệu/tỷ), dấu "," thập phân, "phần trăm".
// Bất biến: mọi cụm chữ số ≤ 3 ký tự ⇒ provider không còn gì để chèn dấu
// phân cách hàng nghìn.

/** Trần ký tự của một tin nhắn VoIP (giới hạn của API). */
const MAX_VOIP_MESSAGE_CHARS = 500;

/** Chia và làm tròn nửa lên cho BigInt — không đi qua Number. */
function roundDiv(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

/**
 * Đọc một số nguyên theo đơn vị lớn: 2450000 → "2 triệu 450 nghìn".
 * Tối đa hai nhóm; nhóm dưới được làm tròn tới đơn vị của nó và có thể nâng
 * cấp (999.999.999 → "1 tỷ") nên không bao giờ sinh ra "1000 triệu".
 */
function formatIntegerForTts(value) {
  if (value < 1000n) return value.toString();
  if (value >= 10n ** 12n) return `${formatIntegerForTts(roundDiv(value, 10n ** 9n))} tỷ`;

  const levels = [
    { scale: 10n ** 9n, word: "tỷ", lower: 10n ** 6n, lowerWord: "triệu" },
    { scale: 10n ** 6n, word: "triệu", lower: 10n ** 3n, lowerWord: "nghìn" },
    { scale: 10n ** 3n, word: "nghìn", lower: 1n, lowerWord: "" },
  ];
  for (const level of levels) {
    if (value < level.scale) continue;
    const rounded = roundDiv(value, level.lower) * level.lower;
    // Làm tròn tràn lên cấp trên (vd 999.999.999 → 1.000.000.000).
    if (rounded >= level.scale * 1000n) return formatIntegerForTts(rounded);
    const high = rounded / level.scale;
    const low = (rounded % level.scale) / level.lower;
    if (low === 0n) return `${high} ${level.word}`;
    return level.lowerWord
      ? `${high} ${level.word} ${low} ${level.lowerWord}`
      : `${high} ${level.word} ${low}`;
  }
  return value.toString();
}

/**
 * Số token đọc được bằng tiếng Việt.
 * - ≥ 1000: đơn vị lớn, bỏ phần lẻ (sai số tương đối < 0,1%).
 * - < 1000: tối đa 2 số lẻ; riêng < 1 dùng 3 số lẻ để vị thế nhỏ không thành 0.
 *
 * @param {bigint|string|number} amount - base units
 * @param {number} [decimals=18]
 * @returns {string} chỉ phần số, chưa kèm symbol
 */
export function formatTokenAmountForTts(amount, decimals = 18) {
  const value = amount == null ? 0n : BigInt(amount);
  if (value <= 0n) return "0";

  const base = 10n ** BigInt(decimals);
  let whole = value / base;
  const fraction = value % base;
  if (whole >= 1000n) return formatIntegerForTts(whole);

  if (whole > 0n) {
    let hundredths = roundDiv(fraction * 100n, base);
    if (hundredths === 100n) {
      whole += 1n;
      hundredths = 0n;
      if (whole >= 1000n) return formatIntegerForTts(whole);
    }
    if (hundredths === 0n) return whole.toString();
    return `${whole},${hundredths.toString().padStart(2, "0").replace(/0+$/, "")}`;
  }

  const thousandths = roundDiv(fraction * 1_000n, base);
  if (thousandths >= 1_000n) return "1";
  if (thousandths === 0n) return "nhỏ hơn 0,001";
  return `0,${thousandths.toString().padStart(3, "0").replace(/0+$/, "")}`;
}

/**
 * Đọc tỉ lệ WAD thành phần trăm: 0.785e18 → "78,5 phần trăm".
 * Ký hiệu "%" không bao giờ xuất hiện trong tin nhắn TTS.
 */
export function formatPercentForTts(wad) {
  if (wad == null) return "không có dữ liệu";
  const value = BigInt(wad);
  const tenths = roundDiv(value, 10n ** 15n); // 1e15 WAD = 0,1%
  if (tenths === 0n) return value === 0n ? "0 phần trăm" : "dưới 0,1 phần trăm";
  const whole = tenths / 10n;
  const fraction = (tenths % 10n).toString().replace(/0+$/, "");
  // > 999% (market bất thường) vẫn phải ≤ 3 chữ số: "1 nghìn phần trăm".
  const wholeText = whole >= 1000n ? formatIntegerForTts(whole) : whole.toString();
  return fraction ? `${wholeText},${fraction} phần trăm` : `${wholeText} phần trăm`;
}

/**
 * Đọc APY (phân số) thành phần trăm: 0.0387 → "3,87 phần trăm".
 * APY cực nhỏ vẫn nghe được là "dưới 0,01 phần trăm", không phải "0".
 */
export function formatApyForTts(apy) {
  if (apy == null) return "không có dữ liệu";
  const percent = apy * 100;
  if (!Number.isFinite(percent)) return "không xác định";
  if (percent === 0) return "0 phần trăm";
  if (percent > 0 && percent < 0.005) return "dưới 0,01 phần trăm";
  // Làm tròn trước rồi mới chọn nhánh: 999,999% làm tròn thành 1000% cũng phải
  // đi qua đơn vị lớn, nếu không sẽ sinh cụm 4 chữ số "1000 phần trăm".
  const rounded = Math.round(percent * 100) / 100;
  // percent sát 1e308 làm phép nhân tràn Infinity; BigInt(Infinity) sẽ ném lỗi
  // ngay trong đường gọi điện — trả câu vô hại thay vì crash.
  if (!Number.isFinite(rounded)) return "không xác định";
  if (rounded >= 1000) return `${formatIntegerForTts(BigInt(Math.round(rounded)))} phần trăm`;
  const text = rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
  return `${text} phần trăm`;
}

/**
 * Ghép câu và cắt ở ranh giới câu: TTS không bao giờ đọc một số/từ bị chẻ đôi.
 * Bỏ hẳn "..." vì engine đọc thành "chấm chấm chấm".
 */
function joinSentencesForTts(sentences, maxLength = MAX_VOIP_MESSAGE_CHARS) {
  let message = "";
  for (const sentence of sentences) {
    const next = message ? `${message} ${sentence}` : sentence;
    if (next.length > maxLength) break;
    message = next;
  }
  // Câu đầu đã vượt trần (chain name bất thường): cắt cứng, vẫn kết thúc bằng dấu chấm.
  if (!message) return `${sentences[0].slice(0, maxLength - 1)}.`;
  return message;
}

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
 * Tối đa 500 ký tự, cắt ở ranh giới câu.
 *
 * Số tiền đi qua `formatTokenAmountForTts`/`formatPercentForTts`/`formatApyForTts`
 * (KHÔNG dùng output thô của `formatUnits`): provider TTS gom chuỗi số dài thành
 * "2,450,000" kiểu Anh rồi đọc dấu "," theo luật tiếng Việt — dấu thập phân —
 * nên nghe sai bậc. Đơn vị lớn + dấu "," thập phân + "phần trăm" là dạng đọc được.
 *
 * @param {object} market - Dữ liệu market từ Morpho Blue
 * @param {object} loanToken - Token metadata (symbol, decimals)
 * @param {object} collateralToken - Token metadata (symbol, decimals)
 * @param {object} position - Vị thế lender (supplyAssets)
 * @param {string} scenario - "sudden_drain" | "liquidity_appeared"
 * @param {string|null} [chainName] - Tên chain (Base/Monad) để TTS nói rõ deployment
 * @returns {string} Tin nhắn tiếng Việt có dấu
 */
export function buildVoipMessage(market, loanToken, collateralToken, position, scenario, chainName = null) {
  const loanSymbol = toTtsFriendly(loanToken?.symbol);
  const collateralSymbol = toTtsFriendly(collateralToken?.symbol);
  const loanDecimals = loanToken?.decimals ?? 18;
  const isSuddenDrain = scenario === "sudden_drain";
  const chainPrefix = chainName ? `Trên ${chainName}. ` : "";

  const liquidityStr = formatTokenAmountForTts(market.liquidity, loanDecimals);
  const supplyStr = formatTokenAmountForTts(position.supplyAssets, loanDecimals);
  const utilizationStr = formatPercentForTts(market.utilization);
  const apyStr = formatApyForTts(market.supplyApy);

  // "&" không được đảm bảo đọc thành "và" trên mọi engine.
  const marketLabel = `${collateralSymbol} và ${loanSymbol}`;
  const sentences = isSuddenDrain
    ? [
      `${chainPrefix}Cảnh báo! Thanh khoản trên thị trường ${marketLabel} đã giảm mạnh.`,
      `Thanh khoản hiện tại: ${liquidityStr} ${loanSymbol}.`,
      `Vị thế của bạn: ${supplyStr} ${loanSymbol}.`,
      `Tỉ lệ sử dụng: ${utilizationStr}.`,
      `Lãi suất năm: ${apyStr}.`,
      "Hãy vào trang web để rút tiền ngay.",
    ]
    : [
      `${chainPrefix}Thông báo! Thanh khoản đã xuất hiện trên thị trường ${marketLabel}.`,
      `Thanh khoản hiện tại: ${liquidityStr} ${loanSymbol}.`,
      `Vị thế của bạn: ${supplyStr} ${loanSymbol}.`,
      `Tỉ lệ sử dụng: ${utilizationStr}.`,
      `Lãi suất năm: ${apyStr}.`,
      "Hãy vào trang web để rút tiền.",
    ];

  return joinSentencesForTts(sentences);
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
    chainName = null,
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
    scenario,
    chainName
  );

  // Lưới an toàn: buildVoipMessage đã cắt ở ranh giới câu, không dùng "..." vì
  // engine đọc thành "chấm chấm chấm".
  if (message.length > MAX_VOIP_MESSAGE_CHARS) {
    message = message.slice(0, MAX_VOIP_MESSAGE_CHARS - 1) + ".";
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
