import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordSuccess,
  recordFailure,
  isCircuitOpen,
  getCircuit,
  circuits,
} from "../rpc-client.mjs";

const URL = "https://ethereum-rpc.publicnode.com";

describe("circuit breaker — HALF-OPEN state tracking", () => {
  beforeEach(() => {
    circuits.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================
  // CLOSED → OPEN → HALF-OPEN → CLOSED lifecycle
  // ==========================================================

  it("opens after 3 consecutive failures", () => {
    recordFailure(URL);
    recordFailure(URL);
    recordFailure(URL);

    const c = getCircuit(URL);
    expect(c.failures).toBe(3);
    expect(c.openUntil).toBeGreaterThan(0);
    expect(c.probing).toBe(false);
  });

  it("stays CLOSED with fewer than 3 failures", () => {
    recordFailure(URL);
    recordFailure(URL);

    const c = getCircuit(URL);
    expect(c.failures).toBe(2);
    expect(c.openUntil).toBe(0);
    expect(isCircuitOpen(URL)).toBe(false);
  });

  it("decrements failures on success in CLOSED state (no probing)", () => {
    recordFailure(URL);
    recordFailure(URL); // failures = 2
    recordSuccess(URL); // successes decrement

    const c = getCircuit(URL);
    expect(c.failures).toBe(1); // decremented, not reset
  });

  it("does NOT close circuit on stale success while OPEN", () => {
    // Simulate: 3 failures open the circuit, then a stale in-flight success arrives
    recordFailure(URL);
    recordFailure(URL);
    recordFailure(URL); // circuit OPENS

    const afterOpen = getCircuit(URL);
    expect(afterOpen.openUntil).toBeGreaterThan(0);
    expect(afterOpen.failures).toBe(3);

    // Stale in-flight success arrives (probing=false — this request started before circuit opened)
    recordSuccess(URL);

    const afterStale = getCircuit(URL);
    // failures decremented from 3 → 2, but circuit stays OPEN via openUntil
    expect(afterStale.failures).toBe(2);
    expect(afterStale.openUntil).toBeGreaterThan(0); // still open!
    expect(afterStale.probing).toBe(false);
    // isCircuitOpen still blocks requests
    expect(isCircuitOpen(URL)).toBe(true);
  });

  // ==========================================================
  // HALF-OPEN probe success → CLOSED
  // ==========================================================

  it("transitions to HALF-OPEN after cooldown expires", () => {
    // Open the circuit
    recordFailure(URL);
    recordFailure(URL);
    recordFailure(URL);

    // Advance past the 30s cooldown
    vi.advanceTimersByTime(31_000);

    // Now isCircuitOpen should transition to HALF-OPEN (probing=true)
    expect(isCircuitOpen(URL)).toBe(false); // not blocking
    const c = getCircuit(URL);
    expect(c.probing).toBe(true);
    expect(c.openUntil).toBe(0); // cooldown cleared
  });

  it("closes circuit on successful HALF-OPEN probe", () => {
    // Open the circuit
    recordFailure(URL);
    recordFailure(URL);
    recordFailure(URL);

    // Advance past cooldown → HALF-OPEN
    vi.advanceTimersByTime(31_000);
    isCircuitOpen(URL); // transitions to HALF-OPEN, probing=true

    // Probe succeeds
    recordSuccess(URL);

    const c = getCircuit(URL);
    expect(c.probing).toBe(false);
    expect(c.failures).toBe(0);
    expect(c.openUntil).toBe(0);
    expect(c.backoffMs).toBe(30_000); // reset to base
  });

  // ==========================================================
  // HALF-OPEN probe failure → re-OPEN
  // ==========================================================

  it("re-opens circuit on failed HALF-OPEN probe with doubled backoff", () => {
    // Open the circuit
    recordFailure(URL);
    recordFailure(URL);
    recordFailure(URL);
    const afterOpen = getCircuit(URL);
    const firstBackoff = afterOpen.backoffMs; // 60_000 (already doubled from 30_000)

    // Advance past cooldown → HALF-OPEN
    vi.advanceTimersByTime(firstBackoff + 1);
    isCircuitOpen(URL);
    expect(getCircuit(URL).probing).toBe(true);

    // Probe fails
    recordFailure(URL);

    const c = getCircuit(URL);
    expect(c.probing).toBe(false);
    expect(c.openUntil).toBeGreaterThan(0); // re-opened
    expect(c.backoffMs).toBe(Math.min(firstBackoff * 2, 120_000)); // doubled again
    expect(isCircuitOpen(URL)).toBe(true); // blocks requests
  });

  // ==========================================================
  // Guards against concurrent failures
  // ==========================================================

  it("does NOT re-open or re-double backoff on concurrent failures after circuit is already OPEN", () => {
    // Open the circuit
    recordFailure(URL);
    recordFailure(URL);
    recordFailure(URL);

    const afterOpen = getCircuit(URL);
    const openUntilAfterFirst = afterOpen.openUntil;
    const backoffAfterFirst = afterOpen.backoffMs;

    // Concurrent failures arrive (they were already in-flight)
    recordFailure(URL);
    recordFailure(URL);

    const afterConcurrent = getCircuit(URL);
    // openUntil should NOT have been reset (no re-log, no re-double)
    expect(afterConcurrent.openUntil).toBe(openUntilAfterFirst);
    expect(afterConcurrent.backoffMs).toBe(backoffAfterFirst);
    expect(afterConcurrent.failures).toBe(5); // 3 initial + 2 concurrent
  });

  // ==========================================================
  // Recovery after multiple OPEN cycles
  // ==========================================================

  it("fully recovers after a complete OPEN → HALF-OPEN → CLOSED cycle", () => {
    // First open
    recordFailure(URL);
    recordFailure(URL);
    recordFailure(URL);

    // Cooldown expires → HALF-OPEN
    vi.advanceTimersByTime(31_000);
    isCircuitOpen(URL);

    // Probe succeeds → CLOSED
    recordSuccess(URL);

    const c = getCircuit(URL);
    expect(c.failures).toBe(0);
    expect(c.openUntil).toBe(0);
    expect(c.probing).toBe(false);
    expect(c.backoffMs).toBe(30_000);

    // New request passes through
    expect(isCircuitOpen(URL)).toBe(false);
  });

  it("eventually recovers after multiple failed probes if URL becomes healthy", () => {
    // Open circuit
    recordFailure(URL);
    recordFailure(URL);
    recordFailure(URL);
    let backoff = getCircuit(URL).backoffMs; // 60_000

    // Fail probe 1
    vi.advanceTimersByTime(backoff + 1);
    isCircuitOpen(URL);
    recordFailure(URL);
    backoff = getCircuit(URL).backoffMs;

    // Fail probe 2
    vi.advanceTimersByTime(backoff + 1);
    isCircuitOpen(URL);
    recordFailure(URL);
    backoff = getCircuit(URL).backoffMs;
    expect(backoff).toBe(120_000); // capped at max

    // Now URL recovers — succeed probe 3
    vi.advanceTimersByTime(backoff + 1);
    isCircuitOpen(URL);
    expect(getCircuit(URL).probing).toBe(true);
    recordSuccess(URL);

    const c = getCircuit(URL);
    expect(c.probing).toBe(false);
    expect(c.failures).toBe(0);
    expect(c.openUntil).toBe(0);
    expect(c.backoffMs).toBe(30_000); // reset
  });
});
