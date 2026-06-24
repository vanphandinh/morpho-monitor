import { describe, it, expect } from "vitest";
import {
  env,
  envNum,
  wadToPercent,
  formatTokenAmount,
  formatApy,
  shortenAddress,
  shouldNotify,
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

  const base = {
    liquidity: 5_000_000n, // 5 USDC — above threshold
    lastSeenLiquidity: 0n, // was zero → now positive (transition!)
    hasNotifiedThisCycle: false,
    lastNotificationTime: 0,
    notificationsToday: 0,
    notificationDayStart: Date.now(),
    minLiquidityThreshold: THRESHOLD,
    notificationCooldownMs: COOLDOWN,
    maxNotificationsPerDay: MAX_PER_DAY,
  };

  it("returns shouldNotify=true when all conditions pass", () => {
    const result = shouldNotify(base);
    expect(result.shouldNotify).toBe(true);
    expect(result.reason).toBe("all_checks_passed");
  });

  it("returns false when below threshold", () => {
    const result = shouldNotify({ ...base, liquidity: 500_000n });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("below_threshold");
  });

  it("returns false when no 0-to-positive transition", () => {
    const result = shouldNotify({ ...base, lastSeenLiquidity: 1_000_000n });
    expect(result.shouldNotify).toBe(false);
    expect(result.reason).toBe("no_transition");
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

  it("returns false when liquidity exactly equals threshold (not >=)", () => {
    // threshold check is strict less-than: liquidity < minLiquidityThreshold
    const result = shouldNotify({ ...base, liquidity: THRESHOLD });
    expect(result.shouldNotify).toBe(true); // equal is NOT less than
  });
});
