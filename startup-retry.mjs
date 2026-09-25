/**
 * Retry khởi động — phân loại lỗi **config** (fatal, chết ngay) và lỗi **hạ tầng** (thử lại có
 * giới hạn). Audit vòng 5, O3.
 *
 * Vấn đề trước đây: `main()` trong `monitor.mjs` gọi `createMarketReader(...)` rồi `.catch` →
 * `process.exit(1)`, nên hai lớp lỗi rất khác nhau đi cùng một đường:
 *
 *   - `MARKET_PARAMS_ZERO` — một id sai trong `markets.json`. Chết ngay là ĐÚNG: retry chỉ làm
 *     chậm thông báo và che mất nguyên nhân.
 *   - lỗi transport (RPC không nối được lúc container vừa lên) — thử lại là ĐÚNG, vì đây là
 *     tình trạng tạm thời; trước đây nó thành vòng restart của container.
 *
 * Bất biến: chỉ những lỗi được coi là **tạm thời** mới bị thử lại; lỗi config ném ra nguyên vẹn
 * ngay lần đầu. Hàm ở đây thuần điều khiển luồng, mọi I/O (sleep, log) đều injectable nên test
 * được mà không chờ thật.
 */

/**
 * Mã lỗi bắt buộc phải FATAL (không thử lại). Test ghim sự khớp với `MARKET_PARAMS_ZERO` của
 * `market-reader.mjs` để hai hằng số không lệch nhau.
 */
export const FATAL_STARTUP_CODES = new Set(["MARKET_PARAMS_ZERO"]);

/** Lịch thử lại mặc định: 5 lần, tổng chờ ~30s. */
export const STARTUP_RETRY = { attempts: 5, delaysMs: [2_000, 4_000, 8_000, 16_000] };

/**
 * Lỗi này có nên thử lại không?
 *
 * Fail-open cho mã lạ (thử lại) — retry thêm vài giây rẻ hơn nhiều so với bỏ lỡ hẳn một cảnh báo
 * — nhưng fail-closed cho danh sách FATAL ở trên.
 */
export function isRetryableStartupError(err) {
  if (!err) return false;
  return !FATAL_STARTUP_CODES.has(err.code);
}

/**
 * Gọi `fn` với thử lại có giới hạn. Ném lại lỗi CUỐI CÙNG nếu hết lượt (không nuốt lỗi).
 *
 * @param {() => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.attempts]
 * @param {number[]} [opts.delaysMs] - thời gian chờ trước mỗi lần thử lại (lần cuối dùng lại)
 * @param {(err: any) => boolean} [opts.isRetryable]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {{ error: Function }} [opts.log]
 */
export async function retryStartup(fn, {
  attempts = STARTUP_RETRY.attempts,
  delaysMs = STARTUP_RETRY.delaysMs,
  isRetryable = isRetryableStartupError,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Lỗi config (hoặc lỗi không rõ): ném ngay, không thử lại, không chờ.
      if (!isRetryable(err)) throw err;
      if (attempt === attempts) break;
      const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0;
      log.error(
        `[monitor] khởi động lần ${attempt}/${attempts} thất bại: ${err?.message || err} — thử lại sau ${Math.round(delay / 1000)}s`
      );
      await sleep(delay);
    }
  }
  throw lastError;
}
