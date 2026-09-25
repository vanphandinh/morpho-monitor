/**
 * startup-retry.mjs — phân loại lỗi khởi động (audit vòng 5, O3).
 *
 * Hợp đồng được ghim:
 *   1. Lỗi tạm thời (transport) ⇒ thử lại theo lịch, và **thử lại được là thành công**.
 *   2. Lỗi config (`MARKET_PARAMS_ZERO`) ⇒ ném ngay lần đầu, KHÔNG chờ, KHÔNG log "thử lại".
 *   3. Hết lượt ⇒ ném lại lỗi cuối cùng (không nuốt lỗi, không trả undefined).
 *   4. Danh sách FATAL phải khớp `MARKET_PARAMS_ZERO` của market-reader (chống lệch hằng số).
 *   5. `monitor.mjs` gọi `loadMarkets` TRƯỚC `retryStartup` ⇒ lỗi config/thiếu file không bị retry.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { retryStartup, isRetryableStartupError, FATAL_STARTUP_CODES, STARTUP_RETRY } from "../startup-retry.mjs";
import { MARKET_PARAMS_ZERO } from "../market-reader.mjs";

const configError = () =>
  Object.assign(new Error("❌ Market id không tồn tại on-chain: 0xaaa…"), { code: MARKET_PARAMS_ZERO, marketId: "0xaaa" });
const transportError = () => new Error("HTTP request failed. Status: 503");

describe("startup-retry — phân loại lỗi", () => {
  it("lỗi transport là tạm thời, lỗi config là fatal", () => {
    expect(isRetryableStartupError(transportError())).toBe(true);
    expect(isRetryableStartupError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isRetryableStartupError(configError())).toBe(false);
    expect(isRetryableStartupError(null)).toBe(false);
  });

  it("danh sách FATAL khớp MARKET_PARAMS_ZERO của market-reader (không lệch hằng số)", () => {
    expect(FATAL_STARTUP_CODES.has(MARKET_PARAMS_ZERO)).toBe(true);
  });
});

describe("startup-retry — hành vi thử lại", () => {
  it("lỗi tạm thời 2 lần rồi thành công ⇒ trả kết quả, chờ đúng lịch", async () => {
    const sleep = vi.fn(async () => {});
    const log = { error: vi.fn() };
    let calls = 0;
    const fn = async () => { calls++; if (calls <= 2) throw transportError(); return "reader-ok"; };

    await expect(retryStartup(fn, { sleep, log })).resolves.toBe("reader-ok");
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(STARTUP_RETRY.delaysMs.slice(0, 2));
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error.mock.calls[0][0]).toContain("1/5");
  });

  it("lỗi config ⇒ ném NGAY, không chờ, không log thử lại", async () => {
    const sleep = vi.fn(async () => {});
    const log = { error: vi.fn() };
    let calls = 0;
    const fn = async () => { calls++; throw configError(); };

    await expect(retryStartup(fn, { sleep, log })).rejects.toMatchObject({ code: MARKET_PARAMS_ZERO });
    expect(calls).toBe(1);          // đúng 1 lần: không retry
    expect(sleep).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("hết lượt ⇒ ném lại lỗi cuối cùng (không nuốt lỗi)", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const err = transportError();
    const fn = async () => { calls++; throw err; };

    await expect(retryStartup(fn, { attempts: 3, sleep, log: { error: vi.fn() } })).rejects.toBe(err);
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2); // lần thử cuối không chờ
  });

  it("thành công ngay ⇒ gọi fn 1 lần, không chờ, không log", async () => {
    const sleep = vi.fn(async () => {});
    const log = { error: vi.fn() };
    const fn = vi.fn(async () => "ok");
    await expect(retryStartup(fn, { sleep, log })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("startup-retry — monitor dùng đúng chỗ", () => {
  const monitorSrc = fs.readFileSync(new URL("../monitor.mjs", import.meta.url), "utf8");

  it("createMarketReader được gọi qua retryStartup", () => {
    expect(monitorSrc).toContain("retryStartup(");
    expect(monitorSrc).toMatch(/retryStartup\(\s*\(\)\s*=>\s*createMarketReader\(/);
  });

  it("loadMarkets chạy TRƯỚC retryStartup ⇒ thiếu/sai MARKETS_FILE không bị retry", () => {
    const loadMarketsAt = monitorSrc.indexOf("loadMarkets(MARKETS_FILE)");
    const retryAt = monitorSrc.indexOf("retryStartup(");
    expect(loadMarketsAt).toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(-1);
    expect(loadMarketsAt).toBeLessThan(retryAt);
  });
});
