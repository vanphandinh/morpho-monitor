import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordSuccess,
  recordFailure,
  isCircuitOpen,
  getCircuit,
  circuits,
  createRoundRobinTransport,
} from "../rpc-client.mjs";

// Track which URLs were actually called through the mocked HTTP transport
const rpcCallLog = vi.hoisted(() => []);

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    http: vi.fn((url) => {
      const req = vi.fn(() => {
        rpcCallLog.push(url);
        return Promise.resolve({ id: 1, jsonrpc: "2.0", result: "0x1" });
      });
      return () => ({
        config: { url },
        request: req,
        value: {},
      });
    }),
  };
});

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

    // Advance past the max jittered cooldown (backoff 60s + 20% jitter = max 72s)
    vi.advanceTimersByTime(80_000);

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

    // Advance past max jittered cooldown → HALF-OPEN
    vi.advanceTimersByTime(80_000);
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

    // Advance past max jittered cooldown → HALF-OPEN
    vi.advanceTimersByTime(firstBackoff + 20_000);
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

    // Advance past max jittered cooldown → HALF-OPEN
    vi.advanceTimersByTime(80_000);
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

    // Fail probe 1 — advance past max jittered cooldown (backoff + 20%)
    vi.advanceTimersByTime(backoff + 20_000);
    isCircuitOpen(URL);
    recordFailure(URL);
    backoff = getCircuit(URL).backoffMs;

    // Fail probe 2
    vi.advanceTimersByTime(backoff + 25_000);
    isCircuitOpen(URL);
    recordFailure(URL);
    backoff = getCircuit(URL).backoffMs;
    expect(backoff).toBe(120_000); // capped at max

    // Now URL recovers — succeed probe 3
    vi.advanceTimersByTime(backoff + 25_000);
    isCircuitOpen(URL);
    expect(getCircuit(URL).probing).toBe(true);
    recordSuccess(URL);

    const c = getCircuit(URL);
    expect(c.probing).toBe(false);
    expect(c.failures).toBe(0);
    expect(c.openUntil).toBe(0);
    expect(c.backoffMs).toBe(30_000); // reset
  });

  // ==========================================================
  // Rate limit (HTTP 429) fast-path
  // ==========================================================

  it("opens circuit immediately on rate limit (HTTP 429) — threshold 1 instead of 3", () => {
    // A single rate limit should open the circuit
    recordFailure(URL, { isRateLimit: true });

    const c = getCircuit(URL);
    expect(c.failures).toBe(1);
    expect(c.openUntil).toBeGreaterThan(0); // circuit OPEN after just 1 failure
    expect(c.probing).toBe(false);
    expect(isCircuitOpen(URL)).toBe(true); // blocks requests
  });

  it("rate limit after a non-rate-limit failure still opens immediately", () => {
    // 1 DNS failure (non-rate-limit) — circuit stays CLOSED
    recordFailure(URL, { isRateLimit: false });
    expect(getCircuit(URL).openUntil).toBe(0); // 1 < 3, not open yet

    // Then a rate limit — opens immediately despite only 2 total failures
    recordFailure(URL, { isRateLimit: true });

    const c = getCircuit(URL);
    expect(c.failures).toBe(2);
    expect(c.openUntil).toBeGreaterThan(0); // OPEN after rate limit
  });

  // ==========================================================
  // HALF-OPEN log rate-limiting
  // ==========================================================

  it("HALF-OPEN log is not duplicated within the same cycle", () => {
    // Mock console.log to track calls
    const logSpy = vi.spyOn(console, "log");

    // Open circuit
    recordFailure(URL);
    recordFailure(URL);
    recordFailure(URL);

    // Advance past max jittered cooldown
    vi.advanceTimersByTime(80_000);

    // First call — transitions to HALF-OPEN, should log
    isCircuitOpen(URL);
    const firstHits = logSpy.mock.calls.filter(
      c => String(c[0]).includes("HALF-OPEN")
    ).length;
    expect(firstHits).toBe(1);

    // Second call — already probing, should NOT log again
    isCircuitOpen(URL);
    const secondHits = logSpy.mock.calls.filter(
      c => String(c[0]).includes("HALF-OPEN")
    ).length;
    expect(secondHits).toBe(1); // still 1, no duplicate

    logSpy.mockRestore();
  });
});

// ==========================================================
// ROUND-ROBIN TRANSPORT — load distribution across URLs
// ==========================================================

const RR_URLS = [
  "https://rpc1.example.com",
  "https://rpc2.example.com",
  "https://rpc3.example.com",
];

describe("round-robin transport", () => {
  beforeEach(() => {
    circuits.clear();
    rpcCallLog.length = 0;
    // random() returns 0 → roundRobinIndex starts at 0
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cycles through URLs in round-robin order on successive requests", async () => {
    const factory = createRoundRobinTransport([...RR_URLS]);
    const transport = factory({});

    await transport.request({ method: "eth_blockNumber" });
    await transport.request({ method: "eth_blockNumber" });
    await transport.request({ method: "eth_blockNumber" });

    // URL[0], URL[1], URL[2] in order
    expect(rpcCallLog).toEqual([RR_URLS[0], RR_URLS[1], RR_URLS[2]]);
  });

  it("wraps around to first URL after full rotation", async () => {
    const factory = createRoundRobinTransport([...RR_URLS]);
    const transport = factory({});

    // Cycle through all 3 URLs, then one more
    await transport.request({ method: "eth_blockNumber" });
    await transport.request({ method: "eth_blockNumber" });
    await transport.request({ method: "eth_blockNumber" });
    await transport.request({ method: "eth_blockNumber" });

    expect(rpcCallLog).toEqual([
      RR_URLS[0],
      RR_URLS[1],
      RR_URLS[2],
      RR_URLS[0], // wrapped around
    ]);
  });

  it("skips circuit-open URL and falls through to the next healthy one", async () => {
    // Open circuit for URL[1] with rate-limit fast path (threshold=1)
    recordFailure(RR_URLS[1], { isRateLimit: true });
    expect(isCircuitOpen(RR_URLS[1])).toBe(true);

    const factory = createRoundRobinTransport([...RR_URLS]);
    const transport = factory({});

    // Request 1: starts at index 0 → URL[0] succeeds → roundRobinIndex = 1
    await transport.request({ method: "eth_blockNumber" });
    // Request 2: starts at index 1 → URL[1] is OPEN → skip → URL[2] succeeds → roundRobinIndex = 0
    await transport.request({ method: "eth_blockNumber" });

    // URL[1] should never appear (it was skipped due to circuit OPEN)
    expect(rpcCallLog).toEqual([RR_URLS[0], RR_URLS[2]]);
    expect(rpcCallLog).not.toContain(RR_URLS[1]);
  });

  it("routes all traffic to the single healthy URL when others are open", async () => {
    // Open circuits for URL[0] and URL[2]
    recordFailure(RR_URLS[0], { isRateLimit: true });
    recordFailure(RR_URLS[2], { isRateLimit: true });

    const factory = createRoundRobinTransport([...RR_URLS]);
    const transport = factory({});

    // All 3 requests should go to URL[1] (the only healthy one)
    await transport.request({ method: "eth_blockNumber" });
    await transport.request({ method: "eth_blockNumber" });
    await transport.request({ method: "eth_blockNumber" });

    expect(rpcCallLog).toEqual([RR_URLS[1], RR_URLS[1], RR_URLS[1]]);
  });

  it("retries the full URL rotation when all URLs fail on first pass", async () => {
    // Open all circuits so every URL fails on first attempt
    recordFailure(RR_URLS[0], { isRateLimit: true });
    recordFailure(RR_URLS[1], { isRateLimit: true });
    recordFailure(RR_URLS[2], { isRateLimit: true });

    const factory = createRoundRobinTransport([...RR_URLS]);
    const transport = factory({});

    // Should throw after retryCount + 1 = 2 passes, all failing
    await expect(
      transport.request({ method: "eth_blockNumber" })
    ).rejects.toBeDefined();

    // No URL should have been successfully called (mock request never reached)
    expect(rpcCallLog).toEqual([]);
  });
});
