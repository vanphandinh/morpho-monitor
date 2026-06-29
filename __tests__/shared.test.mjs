import { describe, it, expect, vi } from "vitest";
import {
  env,
  envNum,
  wadToPercent,
  formatTokenAmount,
  formatApy,
  shortenAddress,
  shouldNotify,
  computeDrainThreshold,
  createSessionToken,
  verifySessionToken,
} from "../shared.mjs";

// ============================================================
// env() — nullish coalescing
// ============================================================
describe("env()", () => {
  it("returns the env var value when set", () => {
    process.env.TEST_KEY = "hello";
    expect(env("TEST_KEY", "fallback")).toBe("hello");
    delete process.env.TEST_KEY;
  });

  it('returns "0" (not fallback) when env var is "0"', () => {
    process.env.TEST_KEY = "0";
    expect(env("TEST_KEY", "fallback")).toBe("0");
    delete process.env.TEST_KEY;
  });

  it('returns "false" (not fallback) when env var is "false"', () => {
    process.env.TEST_KEY = "false";
    expect(env("TEST_KEY", "fallback")).toBe("false");
    delete process.env.TEST_KEY;
  });

  it("returns empty string (not fallback) when env var is empty", () => {
    process.env.TEST_KEY = "";
    expect(env("TEST_KEY", "fallback")).toBe("");
    delete process.env.TEST_KEY;
  });

  it("returns fallback when env var is undefined", () => {
    delete process.env.TEST_KEY;
    expect(env("TEST_KEY", "fallback")).toBe("fallback");
  });
});

// ============================================================
// envNum()
// ============================================================
describe("envNum()", () => {
  it("parses a numeric string", () => {
    process.env.TEST_NUM = "42";
    expect(envNum("TEST_NUM", 0)).toBe(42);
    delete process.env.TEST_NUM;
  });

  it("returns fallback when env var is undefined", () => {
    delete process.env.TEST_NUM;
    expect(envNum("TEST_NUM", 99)).toBe(99);
  });

  it("returns fallback when env var is empty string", () => {
    process.env.TEST_NUM = "";
    expect(envNum("TEST_NUM", 99)).toBe(99);
    delete process.env.TEST_NUM;
  });
});

// ============================================================
// wadToPercent()
// ============================================================
describe("wadToPercent()", () => {
  it("formats 1e18 as 100.00%", () => {
    expect(wadToPercent(1_000_000_000_000_000_000n)).toBe("100.00%");
  });

  it("formats 0.5e18 as 50.00%", () => {
    expect(wadToPercent(500_000_000_000_000_000n)).toBe("50.00%");
  });

  it("formats 0 as 0.00%", () => {
    expect(wadToPercent(0n)).toBe("0.00%");
  });

  it("rounds correctly", () => {
    // 12.3456789... WAD = 12.35% after rounding
    expect(wadToPercent(123_456_789_012_345_678n)).toBe("12.35%");
  });
});

// ============================================================
// formatTokenAmount()
// ============================================================
describe("formatTokenAmount()", () => {
  it("formats 1 USDC (6 decimals)", () => {
    expect(formatTokenAmount(1_000_000n, 6, "USDC")).toBe("1 USDC");
  });

  it("formats fractional USDC", () => {
    expect(formatTokenAmount(1n, 6, "USDC")).toBe("0.000001 USDC");
  });

  it("formats 0 USDC", () => {
    expect(formatTokenAmount(0n, 6, "USDC")).toBe("0 USDC");
  });

  it("formats ETH (18 decimals)", () => {
    expect(formatTokenAmount(1_000_000_000_000_000_000n, 18, "ETH")).toBe("1 ETH");
  });

  it("returns raw string when decimals is null", () => {
    expect(formatTokenAmount(123456789n, null, "USDC")).toBe("123456789 (raw)");
  });

  it('defaults symbol to "tokens" when null', () => {
    expect(formatTokenAmount(1_000_000n, 6, null)).toBe("1 tokens");
  });
});

// ============================================================
// formatApy()
// ============================================================
describe("formatApy()", () => {
  it("formats 0.05 as 5.0000%", () => {
    expect(formatApy(0.05)).toBe("5.0000%");
  });

  it("formats 0 as 0.0000%", () => {
    expect(formatApy(0)).toBe("0.0000%");
  });

  it("returns N/A for null", () => {
    expect(formatApy(null)).toBe("N/A");
  });

  it("returns N/A for undefined", () => {
    expect(formatApy(undefined)).toBe("N/A");
  });

  it("rounds to 4 decimal places", () => {
    expect(formatApy(0.123456789)).toBe("12.3457%");
  });
});

// ============================================================
// shortenAddress()
// ============================================================
describe("shortenAddress()", () => {
  it("shortens a full Ethereum address", () => {
    const addr = "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3";
    expect(shortenAddress(addr)).toBe("0x0A5e...66c3");
  });

  it("returns N/A for null", () => {
    expect(shortenAddress(null)).toBe("N/A");
  });

  it("returns N/A for undefined", () => {
    expect(shortenAddress(undefined)).toBe("N/A");
  });

  it("returns N/A for empty string", () => {
    expect(shortenAddress("")).toBe("N/A");
  });
});

// ============================================================
// shouldNotify() — pure anti-spam decision logic
// ============================================================
describe("shouldNotify()", () => {
  const THRESHOLD = 1_000_000n; // 1 USDC
  const COOLDOWN = 30 * 60 * 1000; // 30 min
  const MAX_PER_DAY = 10;

  const HUGE_SUPPLY = 100_000_000_000_000n; // rất lớn để tests cũ vẫn pass (luôn trong zone)
  const base = {
    liquidity: 5_000_000n, // 5 USDC — above threshold
    lastSeenLiquidity: 0n, // was zero → now positive (transition!)
    supplyAssets: HUGE_SUPPLY,
    hasNotifiedThisCycle: false,
    lastNotificationTime: 0,
    notificationsToday: 0,
    notificationDayStart: Date.now(),
    minLiquidityThreshold: THRESHOLD,
    suddenDrainMultiplier: 2,
    notificationCooldownMs: COOLDOWN,
    maxNotificationsPerDay: MAX_PER_DAY,
  };

  it("returns shouldNotify=true when all conditions pass", () => {
    const result = shouldNotify(base);
    expect(result.shouldNotify).toBe(true);
    expect(result.reason).toBe("all_checks_passed");
    expect(result.scenario).toBe("liquidity_appeared");
  });

  it("returns false when below threshold", () => {
    const result = shouldNotify({ ...base, liquidity: 500_000n });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("below_threshold");
    expect(result.scenario).toBeNull();
  });

  it("returns false when last liquidity was already in zone (no new transition)", () => {
    const result = shouldNotify({ ...base, lastSeenLiquidity: 2_000_000n }); // in zone
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("in_zone_no_transition");
  });

  it("returns true when last liquidity was below threshold (crosses into zone)", () => {
    const result = shouldNotify({ ...base, lastSeenLiquidity: 500_000n }); // below threshold
    expect(result.shouldNotify).toBe(true);
    expect(result.reason).toBe("all_checks_passed");
    expect(result.scenario).toBe("liquidity_appeared");
  });

  it("returns true when last liquidity was 0 (0-to-positive transition into zone)", () => {
    const result = shouldNotify({ ...base, lastSeenLiquidity: 0n }); // was zero
    expect(result.shouldNotify).toBe(true);
    expect(result.reason).toBe("all_checks_passed");
    expect(result.scenario).toBe("liquidity_appeared");
  });

  it("returns false when already notified this cycle", () => {
    const result = shouldNotify({ ...base, hasNotifiedThisCycle: true });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("already_notified_this_cycle");
  });

  it("returns false when in cooldown period", () => {
    const result = shouldNotify({
      ...base,
      lastNotificationTime: Date.now() - 1000, // 1 second ago
    });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("cooldown");
  });

  it("returns false when daily limit reached", () => {
    const result = shouldNotify({
      ...base,
      notificationsToday: MAX_PER_DAY,
    });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("daily_limit");
  });

  it("returns true when day has rolled over (even with max notifications)", () => {
    const result = shouldNotify({
      ...base,
      notificationsToday: MAX_PER_DAY,
      notificationDayStart: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    });
    expect(result.shouldNotify).toBe(true);
    expect(result.reason).toBe("all_checks_passed");
  });

  it("returns true when cooldown has passed", () => {
    const result = shouldNotify({
      ...base,
      lastNotificationTime: Date.now() - COOLDOWN - 1000, // just past cooldown
    });
    expect(result.shouldNotify).toBe(true);
  });

  it("returns true when liquidity equals threshold (>= means in zone)", () => {
    const result = shouldNotify({ ...base, liquidity: THRESHOLD });
    expect(result.shouldNotify).toBe(true); // equal to threshold → in zone
  });
});

// ============================================================
// shouldNotify() — Sudden drain (downward into danger zone)
// ============================================================
describe("shouldNotify() — sudden drain", () => {
  const THRESHOLD = 1_000_000n; // 1 USDC
  const COOLDOWN = 30 * 60 * 1000;
  const SUPPLY = 10_000_000n;   // 10 USDC supply
  const MULTIPLIER = 2;
  const DRAIN = computeDrainThreshold(SUPPLY, MULTIPLIER); // 20 USDC với MULTIPLIER=2

  const base = {
    supplyAssets: SUPPLY,
    hasNotifiedThisCycle: false,
    lastNotificationTime: 0,
    notificationsToday: 0,
    notificationDayStart: Date.now(),
    minLiquidityThreshold: THRESHOLD,
    suddenDrainMultiplier: MULTIPLIER,
    notificationCooldownMs: COOLDOWN,
    maxNotificationsPerDay: 10,
  };

  it("triggers sudden_drain when liquidity drops from > drainThreshold to ≤ drainThreshold", () => {
    const result = shouldNotify({
      ...base,
      liquidity: 15_000_000n,       // 15 USDC — in zone
      lastSeenLiquidity: 25_000_000n, // 25 USDC — was above drain
    });
    expect(result.shouldNotify).toBe(true);
    expect(result.scenario).toBe("sudden_drain");
  });

  it("does not trigger when still above drainThreshold", () => {
    const result = shouldNotify({
      ...base,
      liquidity: 25_000_000n,
      lastSeenLiquidity: 30_000_000n,
    });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("above_drain_threshold");
  });

  it("does not trigger when already in zone last cycle (no downward crossing)", () => {
    const result = shouldNotify({
      ...base,
      liquidity: 15_000_000n,
      lastSeenLiquidity: 18_000_000n, // was also in zone
    });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("in_zone_no_transition");
  });

  it("triggers liquidity_appeared when entering zone from below threshold", () => {
    const result = shouldNotify({
      ...base,
      liquidity: 8_000_000n,
      lastSeenLiquidity: 500_000n, // was below threshold
    });
    expect(result.shouldNotify).toBe(true);
    expect(result.scenario).toBe("liquidity_appeared");
  });

  it("applies anti-spam cooldown for sudden_drain", () => {
    const result = shouldNotify({
      ...base,
      liquidity: 15_000_000n,
      lastSeenLiquidity: 25_000_000n,
      lastNotificationTime: Date.now() - 1000,
    });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("cooldown");
  });

  it("applies daily limit for sudden_drain", () => {
    const result = shouldNotify({
      ...base,
      liquidity: 15_000_000n,
      lastSeenLiquidity: 25_000_000n,
      notificationsToday: 10,
    });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("daily_limit");
  });

  it("applies cycle dedup for sudden_drain", () => {
    const result = shouldNotify({
      ...base,
      liquidity: 15_000_000n,
      lastSeenLiquidity: 25_000_000n,
      hasNotifiedThisCycle: true,
    });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("already_notified_this_cycle");
  });
});

// ============================================================
// shouldNotify() — Edge cases
// ============================================================
describe("shouldNotify() — edge cases", () => {
  const THRESHOLD = 1_000_000n;
  const COOLDOWN = 30 * 60 * 1000;
  const base = {
    hasNotifiedThisCycle: false,
    lastNotificationTime: 0,
    notificationsToday: 0,
    notificationDayStart: Date.now(),
    minLiquidityThreshold: THRESHOLD,
    suddenDrainMultiplier: 2,
    notificationCooldownMs: COOLDOWN,
    maxNotificationsPerDay: 10,
  };

  it("returns no_position when supplyAssets is 0", () => {
    const result = shouldNotify({
      ...base,
      supplyAssets: 0n,
      liquidity: 5_000_000n,
      lastSeenLiquidity: 0n,
    });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("no_position");
    expect(result.scenario).toBeNull();
  });

  it("returns no_position when supplyAssets is null/undefined", () => {
    const result = shouldNotify({
      ...base,
      supplyAssets: null,
      liquidity: 5_000_000n,
      lastSeenLiquidity: 0n,
    });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("no_position");
  });

  it("skips straight to healthy when liquidity jumps above drainThreshold", () => {
    const result = shouldNotify({
      ...base,
      supplyAssets: 10_000_000n,
      liquidity: 25_000_000n,     // > 2× supply
      lastSeenLiquidity: 0n,      // was zero
    });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("above_drain_threshold");
  });

  it("sudden_drain takes priority over liquidity_appeared", () => {
    // Both could trigger: last > drain AND last < threshold cannot both be true
    // But if multiplier=1, drainThreshold = supplyAssets
    // Test that downward is checked before upward
    const result = shouldNotify({
      ...base,
      supplyAssets: 10_000_000n,
      suddenDrainMultiplier: 1,
      liquidity: 10_000_000n,      // = drainThreshold (in zone)
      lastSeenLiquidity: 15_000_000n, // > drainThreshold → sudden_drain
    });
    expect(result.shouldNotify).toBe(true);
    expect(result.scenario).toBe("sudden_drain");
  });
});

// ============================================================
// computeDrainThreshold()
// ============================================================
describe("computeDrainThreshold()", () => {
  it("computes with integer multiplier", () => {
    const result = computeDrainThreshold(10_000_000n, 2);
    expect(result).toBe(20_000_000n);
  });

  it("computes with fractional multiplier (1 decimal)", () => {
    const result = computeDrainThreshold(10_000_000n, 1.5);
    expect(result).toBe(15_000_000n); // (10M × 15) / 10
  });

  it("computes with fractional multiplier (2 decimals)", () => {
    const result = computeDrainThreshold(10_000_000n, 2.25);
    expect(result).toBe(22_500_000n); // (10M × 225) / 100
  });

  it("computes with fractional multiplier (3 decimals)", () => {
    const result = computeDrainThreshold(1_000_000_000n, 1.333);
    expect(result).toBe(1_333_000_000n); // (1B × 1333) / 1000
  });

  it("returns 0n when supplyAssets is 0n", () => {
    const result = computeDrainThreshold(0n, 2);
    expect(result).toBe(0n);
  });

  it("returns 0n when supplyAssets is null", () => {
    const result = computeDrainThreshold(null, 2);
    expect(result).toBe(0n);
  });

  it("handles multiplier = 1 (exactly at supply)", () => {
    const result = computeDrainThreshold(10_000_000n, 1);
    expect(result).toBe(10_000_000n);
  });

  it("handles multiplier as string from env (e.g., '1.5')", () => {
    // envNum returns number, but this tests robustness for manual calls
    const result = computeDrainThreshold(10_000_000n, "1.5");
    expect(result).toBe(15_000_000n);
  });
});

// ============================================================
// createSessionToken() & verifySessionToken() — HMAC-based
// ============================================================
describe("createSessionToken() & verifySessionToken()", () => {
  it("tạo token và verify thành công", () => {
    const token = createSessionToken("0x1234567890abcdef", 3600000); // 1 hour
    expect(token).toBeTruthy();
    expect(token).toContain(".");

    const result = verifySessionToken(token);
    expect(result).not.toBeNull();
    expect(result.address).toBe("0x1234567890abcdef");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("verify trả về null với token null/undefined/rỗng", () => {
    expect(verifySessionToken(null)).toBeNull();
    expect(verifySessionToken(undefined)).toBeNull();
    expect(verifySessionToken("")).toBeNull();
  });

  it("verify trả về null với token sai format (không có dấu chấm)", () => {
    expect(verifySessionToken("invalidtoken")).toBeNull();
  });

  it("verify trả về null với token bị chỉnh sửa payload", () => {
    const token = createSessionToken("0xabc", 3600000);
    const [payload, hmac] = token.split(".");
    const tamperedToken = "tampered." + hmac;
    expect(verifySessionToken(tamperedToken)).toBeNull();
  });

  it("verify trả về null với token bị chỉnh sửa HMAC", () => {
    const token = createSessionToken("0xabc", 3600000);
    const [payload] = token.split(".");
    const tamperedToken = payload + ".deadbeef";
    expect(verifySessionToken(tamperedToken)).toBeNull();
  });

  it("verify trả về null với token đã hết hạn", async () => {
    const token = createSessionToken("0xabc", 1); // 1ms expiry
    await new Promise(r => setTimeout(r, 10));
    expect(verifySessionToken(token)).toBeNull();
  });

  it("token của các address khác nhau là khác nhau", () => {
    const token1 = createSessionToken("0xaaa", 3600000);
    const token2 = createSessionToken("0xbbb", 3600000);
    expect(token1).not.toBe(token2);
    expect(verifySessionToken(token1).address).toBe("0xaaa");
    expect(verifySessionToken(token2).address).toBe("0xbbb");
  });

  it("token còn hạn thì verify thành công", () => {
    const token = createSessionToken("0xlender", 60000); // 1 minute
    const result = verifySessionToken(token);
    expect(result).not.toBeNull();
    expect(result.address).toBe("0xlender");
  });
});
