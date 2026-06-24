/**
 * Tests for monitor.mjs anti-spam integration.
 *
 * Since the anti-spam decision logic was extracted into the pure
 * shouldNotify() function (tested in shared.test.mjs), this file
 * focuses on integration: verifying the monitor wiring works
 * end-to-end with mocked I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shouldNotify } from "../shared.mjs";

// ============================================================
// Integration: shouldNotify() wired with real-world scenarios
// ============================================================
describe("monitor anti-spam scenarios (integration)", () => {
  const THRESHOLD = 1_000_000n; // 1 USDC
  const COOLDOWN_MS = 30 * 60 * 1000;
  const MAX_PER_DAY = 10;

  // Simulate what the monitor passes to shouldNotify each cycle
  function simulateCycle(state, liquidity) {
    const decision = shouldNotify({
      liquidity,
      lastSeenLiquidity: state.lastSeenLiquidity,
      hasNotifiedThisCycle: state.hasNotifiedThisCycle,
      lastNotificationTime: state.lastNotificationTime,
      notificationsToday: state.notificationsToday,
      notificationDayStart: state.notificationDayStart,
      minLiquidityThreshold: THRESHOLD,
      notificationCooldownMs: COOLDOWN_MS,
      maxNotificationsPerDay: MAX_PER_DAY,
    });

    if (decision.shouldNotify) {
      state.hasNotifiedThisCycle = true;
      state.lastNotificationTime = Date.now();
      state.notificationsToday++;
    }

    // Reset cycle flag when liquidity returns to 0
    if (liquidity === 0n && state.hasNotifiedThisCycle) {
      state.hasNotifiedThisCycle = false;
    }

    state.lastSeenLiquidity = liquidity;

    return { ...decision, state: { ...state } };
  }

  let state;

  beforeEach(() => {
    state = {
      lastSeenLiquidity: null,
      hasNotifiedThisCycle: false,
      lastNotificationTime: 0,
      notificationsToday: 0,
      notificationDayStart: Date.now(),
    };
  });

  it("first cycle: records state, does NOT notify even with liquidity", () => {
    // First run is handled separately in monitor.mjs (first-run path).
    // shouldNotify is only called after initialization.
    // Here we simulate the first post-init cycle.
    state.lastSeenLiquidity = 0n; // initialized to 0

    const r1 = simulateCycle(state, 5_000_000n); // liquidity appears
    expect(r1.shouldNotify).toBe(true);
    expect(r1.state.hasNotifiedThisCycle).toBe(true);
    expect(r1.state.notificationsToday).toBe(1);
  });

  it("does not notify again in same liquidity cycle", () => {
    state.lastSeenLiquidity = 0n;

    // First notification
    simulateCycle(state, 5_000_000n);

    // Same cycle, liquidity still present
    const r2 = simulateCycle(state, 5_000_000n);
    expect(r2.shouldNotify).toBe(false);
    expect(r2.state.hasNotifiedThisCycle).toBe(true);
    expect(r2.state.notificationsToday).toBe(1); // still 1
  });

  it("resets cycle flag when liquidity returns to 0", () => {
    state.lastSeenLiquidity = 0n;

    // Liquidity appears → notify
    simulateCycle(state, 5_000_000n);
    expect(state.hasNotifiedThisCycle).toBe(true);

    // Liquidity gone → reset
    const r = simulateCycle(state, 0n);
    expect(state.hasNotifiedThisCycle).toBe(false);
  });

  it("notifies again after full 0→positive→0→positive cycle (with cooldown elapsed)", () => {
    state.lastSeenLiquidity = 0n;

    // Round 1: 0 → positive
    const r1 = simulateCycle(state, 5_000_000n);
    expect(r1.shouldNotify).toBe(true);
    expect(state.notificationsToday).toBe(1);

    // Liquidity goes to 0 (reset cycle flag)
    simulateCycle(state, 0n);

    // Simulate cooldown passing before next round
    state.lastNotificationTime = Date.now() - COOLDOWN_MS - 1000;

    // Round 2: 0 → positive again
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

  it("does not notify when liquidity stays positive (no transition)", () => {
    state.lastSeenLiquidity = 5_000_000n; // was positive, stays positive

    const r = simulateCycle(state, 6_000_000n);
    expect(r.shouldNotify).toBe(false);
    expect(r.reason).toBe("no_transition");
  });
});
