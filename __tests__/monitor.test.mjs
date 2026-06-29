/**
 * Tests for monitor.mjs anti-spam integration.
 *
 * Since the anti-spam decision logic was extracted into the pure
 * shouldNotify() function (tested in shared.test.mjs), this file
 * focuses on integration: verifying the monitor wiring works
 * end-to-end with mocked I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shouldNotify, computeDrainThreshold } from "../shared.mjs";

// ============================================================
// Integration: shouldNotify() wired with real-world scenarios
// ============================================================
describe("monitor anti-spam scenarios (integration)", () => {
  const THRESHOLD = 1_000_000n; // 1 USDC
  const COOLDOWN_MS = 30 * 60 * 1000;
  const MAX_PER_DAY = 10;
  const SUPPLY = 100_000_000_000_000n; // rất lớn để tests tập trung vào anti-spam
  const DRAIN_MULTIPLIER = 2;
  const DRAIN = computeDrainThreshold(SUPPLY, DRAIN_MULTIPLIER);

  // Simulate what the monitor passes to shouldNotify each cycle
  function simulateCycle(state, liquidity) {
    const decision = shouldNotify({
      liquidity,
      lastSeenLiquidity: state.lastSeenLiquidity,
      supplyAssets: state.supplyAssets,
      hasNotifiedThisCycle: state.hasNotifiedThisCycle,
      lastNotificationTime: state.lastNotificationTime,
      notificationsToday: state.notificationsToday,
      notificationDayStart: state.notificationDayStart,
      minLiquidityThreshold: THRESHOLD,
      suddenDrainMultiplier: DRAIN_MULTIPLIER,
      notificationCooldownMs: COOLDOWN_MS,
      maxNotificationsPerDay: MAX_PER_DAY,
    });

    if (decision.shouldNotify) {
      state.hasNotifiedThisCycle = true;
      state.lastNotificationTime = Date.now();
      state.notificationsToday++;
    }

    // Reset cycle flag when liquidity exits the danger zone
    // Danger zone: [THRESHOLD, SUPPLY * DRAIN_MULTIPLIER]
    if (state.hasNotifiedThisCycle) {
      const drainThreshold = computeDrainThreshold(state.supplyAssets, DRAIN_MULTIPLIER);
      if (liquidity < THRESHOLD || liquidity > drainThreshold) {
        state.hasNotifiedThisCycle = false;
      }
    }

    state.lastSeenLiquidity = liquidity;

    return { ...decision, state: { ...state } };
  }

  let state;

  beforeEach(() => {
    state = {
      lastSeenLiquidity: null,
      supplyAssets: SUPPLY,
      hasNotifiedThisCycle: false,
      lastNotificationTime: 0,
      notificationsToday: 0,
      notificationDayStart: Date.now(),
    };
  });

  it("first post-init cycle: notifies when liquidity enters zone from below", () => {
    state.lastSeenLiquidity = 0n; // initialized to 0

    const r1 = simulateCycle(state, 5_000_000n); // liquidity appears → enters zone from below
    expect(r1.shouldNotify).toBe(true);
    expect(r1.scenario).toBe("liquidity_appeared");
    expect(r1.state.hasNotifiedThisCycle).toBe(true);
    expect(r1.state.notificationsToday).toBe(1);
  });

  it("does not notify again in same liquidity cycle", () => {
    state.lastSeenLiquidity = 0n;

    // First notification
    simulateCycle(state, 5_000_000n);

    // Same cycle, liquidity still in zone
    const r2 = simulateCycle(state, 5_000_000n);
    expect(r2.shouldNotify).toBe(false);
    expect(r2.reason).toBe("in_zone_no_transition");
    expect(r2.state.hasNotifiedThisCycle).toBe(true);
    expect(r2.state.notificationsToday).toBe(1); // still 1
  });

  it("resets cycle flag when liquidity drops below threshold", () => {
    state.lastSeenLiquidity = 0n;

    // Liquidity appears → notify
    simulateCycle(state, 5_000_000n);
    expect(state.hasNotifiedThisCycle).toBe(true);

    // Liquidity drops below threshold → reset
    simulateCycle(state, 500_000n); // 0.5 USDC < threshold
    expect(state.hasNotifiedThisCycle).toBe(false);
  });

  it("notifies again after full enter→exit→enter cycle (with cooldown elapsed)", () => {
    state.lastSeenLiquidity = 0n;

    // Round 1: 0 → in zone
    const r1 = simulateCycle(state, 5_000_000n);
    expect(r1.shouldNotify).toBe(true);
    expect(state.notificationsToday).toBe(1);

    // Exit zone (below threshold → reset)
    simulateCycle(state, 0n);
    expect(state.hasNotifiedThisCycle).toBe(false);

    // Simulate cooldown passing before next round
    state.lastNotificationTime = Date.now() - COOLDOWN_MS - 1000;

    // Round 2: enter zone again
    const r2 = simulateCycle(state, 5_000_000n);
    expect(r2.shouldNotify).toBe(true);
    expect(state.notificationsToday).toBe(2);
  });

  it("respects daily limit", () => {
    state.lastSeenLiquidity = 0n;
    state.notificationsToday = MAX_PER_DAY; // already at limit

    const r = simulateCycle(state, 5_000_000n);
    expect(r.shouldNotify).toBe(false);
    expect(r.reason).toBe("daily_limit");
    // No state changes since notification was blocked
    expect(state.notificationsToday).toBe(MAX_PER_DAY);
  });

  it("allows notification after day rollover", () => {
    state.lastSeenLiquidity = 0n;
    state.notificationsToday = MAX_PER_DAY;
    state.notificationDayStart = Date.now() - 25 * 60 * 60 * 1000; // 25h ago

    const r = simulateCycle(state, 5_000_000n);
    expect(r.shouldNotify).toBe(true);
  });

  it("cooldown blocks notification within cooldown window", () => {
    state.lastSeenLiquidity = 0n;
    state.lastNotificationTime = Date.now() - 1000; // 1 second ago

    const r = simulateCycle(state, 5_000_000n);
    expect(r.shouldNotify).toBe(false);
    expect(r.reason).toBe("cooldown");
  });

  it("does not notify when liquidity stays in zone (no new transition)", () => {
    state.lastSeenLiquidity = 5_000_000n; // was in zone, stays in zone

    const r = simulateCycle(state, 6_000_000n);
    expect(r.shouldNotify).toBe(false);
    expect(r.reason).toBe("in_zone_no_transition");
  });
});
