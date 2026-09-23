/**
 * Tests for the production scheduler and WSS watcher (monitor-triggers.mjs).
 * Mọi scenario đều import implementation thật — không có bản copy logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCheckScheduler, createWssWatcher } from "../monitor-triggers.mjs";
import { closeTransport } from "../wss-connect.mjs";

/**
 * Connection với ĐÚNG shape viem: close() đi qua closeTransport() →
 * getRpcClient() (Promise<SocketRpcClient>) → .close(). Đây là đường close
 * thật của production, nên test khẳng định nó được gọi ở mọi nhánh cleanup.
 */
function viemShapedConnection(url, watch) {
  const closeSpy = vi.fn();
  const client = { transport: { value: { getRpcClient: () => Promise.resolve({ close: closeSpy }) } } };
  return {
    closeSpy,
    connection: { url, close: () => closeTransport(client), watch: watch ?? vi.fn(() => vi.fn()) },
  };
}

describe("production scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("unions events, lets all dominate, and runs trailing work", async () => {
    const calls = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const scheduler = createCheckScheduler(async (ids) => { calls.push(ids); if (calls.length === 1) await gate; }, { debounceMs: 10 });
    scheduler.request(["a"]); scheduler.request(["b"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([["a", "b"]]);
    scheduler.request(); release();
    await vi.runAllTimersAsync();
    expect(calls).toEqual([["a", "b"], undefined]);
  });

  it("deduplicates repeated ids without concurrent runs", async () => {
    const calls = [];
    const scheduler = createCheckScheduler(async (ids) => { calls.push(ids); }, { debounceMs: 10 });
    scheduler.request(["a"]); scheduler.request(["a", "b"]); scheduler.request(["b"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([["a", "b"]]);
  });

  it("close() cancels pending timers and ignores later requests", async () => {
    const checkFn = vi.fn();
    const scheduler = createCheckScheduler(checkFn, { debounceMs: 10 });
    scheduler.request(["a"]);
    scheduler.close();
    scheduler.request(["b"]);
    await vi.runAllTimersAsync();
    expect(checkFn).not.toHaveBeenCalled();
  });
});

describe("production WSS watcher", () => {
  const eventNames = ["Supply", "Withdraw", "Borrow", "Repay", "Liquidate"];
  const baseArgs = { eventNames, marketIds: ["a", "b"], onMarkets: vi.fn(), logger: { warn: vi.fn(), log: vi.fn() }, retryDelayMs: 1000 };

  afterEach(() => vi.useRealTimers());

  it("uses one endpoint, five OR-filtered subscriptions, and cleanup on close", async () => {
    const watch = vi.fn(() => vi.fn()); const close = vi.fn();
    const watcher = createWssWatcher({ ...baseArgs, urls: ["bad", "good"], connect: async (url) => { if (url === "bad") throw new Error("no"); return { url, watch, close }; } });
    await watcher.start();
    expect(watcher.activeUrl).toBe("good");
    expect(watch).toHaveBeenCalledTimes(5);
    expect(watch.mock.calls[0][1]).toEqual({ id: ["a", "b"] });
    watcher.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes partial subscriptions and the connection when a later watch throws", async () => {
    const unwatchers = [vi.fn(), vi.fn()];
    let calls = 0;
    const { connection, closeSpy } = viemShapedConnection("only", vi.fn(() => (calls < 2 ? unwatchers[calls++] : (() => { throw new Error("watch failed"); })())));
    const watcher = createWssWatcher({ ...baseArgs, urls: ["only"], connect: async () => connection });
    const ok = await watcher.start();
    expect(ok).toBe(false);
    expect(unwatchers[0]).toHaveBeenCalled();
    expect(unwatchers[1]).toHaveBeenCalled();
    // Orphan cleanup đi đúng đường viem (H1) — trước đây là no-op.
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1));
    expect(watcher.activeUrl).toBeNull();
  });

  it("rotates to the next url on runtime error instead of restarting the list", async () => {
    let errCallback;
    const unwatch = vi.fn();
    const created = [];
    const urls = [];
    const watcher = createWssWatcher({
      ...baseArgs, urls: ["first", "second"],
      connect: async (url) => {
        urls.push(url);
        const watch = vi.fn((_name, _args, onLogs, onError) => { errCallback = onError; return unwatch; });
        const entry = viemShapedConnection(url, watch);
        created.push(entry);
        return entry.connection;
      },
    });
    await watcher.start();
    expect(watcher.activeUrl).toBe("first");
    errCallback(); // runtime failure on the active endpoint
    await vi.waitFor(() => expect(created.length).toBe(2));
    // Rotation attempted the NEXT url, và endpoint cũ được đóng thật.
    expect(urls).toEqual(["first", "second"]);
    await vi.waitFor(() => expect(created[0].closeSpy).toHaveBeenCalledTimes(1));
    watcher.close();
    await vi.waitFor(() => expect(created[1].closeSpy).toHaveBeenCalledTimes(1));
  });

  it("H1: log từ endpoint cũ không kích scheduler, log generation hiện tại thì có", async () => {
    const onMarkets = vi.fn();
    const logCallbacks = [];
    const errorCallbacks = [];
    const watcher = createWssWatcher({
      ...baseArgs, onMarkets, urls: ["first", "second"],
      connect: async (url) => viemShapedConnection(url, vi.fn((_name, _args, onLogs, onError) => {
        logCallbacks.push({ url, onLogs });
        errorCallbacks.push(onError);
        return vi.fn();
      })).connection,
    });
    await watcher.start();
    expect(watcher.activeUrl).toBe("first");
    logCallbacks[0].onLogs([{ args: { id: "a" } }]); // generation hiện tại → có kích
    expect(onMarkets).toHaveBeenCalledTimes(1);

    errorCallbacks[0](); // runtime failure → rotate sang "second"
    await vi.waitFor(() => expect(watcher.activeUrl).toBe("second"));

    logCallbacks[0].onLogs([{ args: { id: "a" } }]); // log endpoint cũ → bị fence
    expect(onMarkets).toHaveBeenCalledTimes(1);
    logCallbacks.at(-1).onLogs([{ args: { id: "a" } }, { args: { id: "b" } }, { args: { id: "a" } }, { args: {} }]);
    expect(onMarkets).toHaveBeenCalledTimes(2);
    expect(onMarkets).toHaveBeenLastCalledWith(["a", "b"]);
    watcher.close();
  });

  it("retries with bounded backoff after all endpoints fail and stops on close", async () => {
    vi.useFakeTimers();
    const connect = vi.fn(async () => { throw new Error("down"); });
    const logger = { warn: vi.fn(), log: vi.fn() };
    const watcher = createWssWatcher({ urls: ["a", "b"], eventNames, marketIds: ["a"], onMarkets: vi.fn(), logger, connect, retryDelayMs: 1000 });
    await watcher.start();
    expect(connect).toHaveBeenCalledTimes(2); // no infinite loop
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(4); // one bounded retry of both urls
    watcher.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(connect).toHaveBeenCalledTimes(4); // retry timer cancelled by close
  });

  it("M5: check throw không giết loop — chu kỳ sau vẫn chạy và có log chẩn đoán", async () => {
    vi.useFakeTimers();
    const calls = [];
    const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
    const scheduler = createCheckScheduler(async (ids) => {
      calls.push(ids);
      if (calls.length === 1) throw new Error("RPC outage");
    }, { debounceMs: 10, logger });
    scheduler.request(["a"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([["a"]]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("RPC outage"));
    scheduler.request(["b"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([["a"], ["b"]]);
  });

  it("ignores stale error callbacks from a replaced generation", async () => {
    let errCallback;
    const close = vi.fn();
    const watch = vi.fn((_name, _args, _onLogs, onError) => { errCallback = onError; return vi.fn(); });
    const watcher = createWssWatcher({ ...baseArgs, urls: ["only"], connect: async () => ({ url: "only", watch, close }) });
    await watcher.start();
    const staleCallback = errCallback;
    watcher.close(); // generation dead
    // Stale callback after close must not schedule anything or throw.
    expect(() => staleCallback()).not.toThrow();
    expect(watcher.activeUrl).toBeNull();
  });
});
