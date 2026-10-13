/**
 * createMonitor() — orchestration test được với deps giả (audit P1.5).
 *
 * Trước đây phần này chạy ở module-level (`loadMarkets`, `setInterval`,
 * `process.on`) nên chỉ ghim được source bằng regex. Sau refactor, `checkMarkets`
 * nhận reader/notifier/broadcaster/alerts qua tham số, nên hành vi per-market,
 * dedupe chu kỳ và đường cảnh báo vòng đời được kiểm chứng trực tiếp.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMonitor } from "../monitor.mjs";
import { broadcastEligible } from "../presigned-broadcast.mjs";
import { drainLifecycleAlerts } from "../presigned-alert-queue.mjs";
import { updateRegistry } from "../presigned-store.mjs";

const MARKET_A = "0x" + "a".repeat(64);
const MARKET_B = "0x" + "b".repeat(64);
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const snap = (over = {}) => ({
  id: MARKET_A,
  market: { liquidity: 1_000_000n },
  position: { supplyAssets: 10_000_000n },
  loanToken: { decimals: 6, symbol: "USDC" },
  suddenDrainMultiplier: 2,
  minLiquidityWei: 500_000n,
  ...over,
});

function makeDeps({ initial = [snap()], broadcastResult = null, broadcastImpl, lifecycleNotify, delivery = { ntfyDelivered: true }, sendImpl, readError = null, now, maxNotificationsPerDay = 10, drainAlerts = vi.fn(async () => {}) } = {}) {
  let snapshots = initial;
  const notified = [];
  const alerts = [];
  const errors = [];
  const reader = {
    readSnapshots: vi.fn(async () => {
      if (readError) throw readError;
      return { blockNumber: 1n, snapshots: new Map(snapshots.map((s) => [s.id, s])), failures: new Map() };
    }),
  };
  const broadcast = vi.fn(async (snapshots) => broadcastImpl ? broadcastImpl(snapshots) : broadcastResult);
  const monitor = createMonitor({
    markets: [{ id: MARKET_A, minLiquidity: "1", suddenDrainMultiplier: 2 }],
    reader,
    lifecycleAlerts: { notify: vi.fn(async (kind, info) => { alerts.push({ kind, info }); return lifecycleNotify ? lifecycleNotify(kind, info) : { sent: true }; }) },
    sendNotification: vi.fn(async (snapshot, scenario) => {
      notified.push({ id: snapshot.id, scenario });
      return sendImpl ? sendImpl(snapshot, scenario) : delivery;
    }),
    broadcastEligible: broadcast,
    drainAlerts,
    config: { notificationCooldownMs: 0, maxNotificationsPerDay, wssDebounceMs: 1, monitorIntervalMs: 1, wssUrls: [], morphoBlueAddress: MORPHO },
    logger: { log: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    ...(now ? { now } : {}),
  });
  return { monitor, notified, alerts, errors, reader, drainAlerts, broadcast, setSnapshots: (next) => { snapshots = next; } };
}

describe("createMonitor — chu kỳ check", () => {
  it("broadcast starts before a stalled outbox and is not blocked by it", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const order = [];
    const drainAlerts = vi.fn(async () => { order.push("drain"); await pending; });
    const { monitor, broadcast } = makeDeps({ drainAlerts });
    const check = monitor.checkMarkets();
    try {
      await vi.waitFor(() => expect(broadcast).toHaveBeenCalledOnce());
      expect(order[0]).toBe("drain"); // outbox may run, but never hold broadcast
      await check;
      await monitor.checkMarkets();
      expect(broadcast).toHaveBeenCalledTimes(2);
      expect(drainAlerts).toHaveBeenCalledTimes(1); // a stalled drain coalesces retries
    } finally {
      release();
      await check;
    }
    await monitor.waitForNotifications();
    expect(drainAlerts).toHaveBeenCalledTimes(2);
  });

  it("slow ntfy/VoIP does not delay a later broadcast or send the same alert twice", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const sendImpl = vi.fn(async () => pending);
    const { monitor, broadcast, notified, setSnapshots } = makeDeps({
      initial: [snap({ market: { liquidity: 25_000_000n } })], sendImpl,
    });
    await monitor.checkMarkets();
    setSnapshots([snap({ market: { liquidity: 1_000_000n } })]);
    const check = monitor.checkMarkets();
    try {
      await vi.waitFor(() => expect(sendImpl).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2));
      await check;
      await monitor.checkMarkets();
      expect(broadcast).toHaveBeenCalledTimes(3);
      expect(notified).toHaveLength(1);
    } finally {
      release({ ntfyDelivered: true });
      await check;
    }
    await monitor.waitForNotifications();
    expect(monitor.stateFor(MARKET_A).hasNotifiedThisCycle).toBe(true);
  });

  it("a stalled lifecycle alert does not delay the next broadcast", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { monitor, broadcast, alerts } = makeDeps({
      broadcastResult: { stuck: true, id: "c1", marketId: MARKET_A, nonce: 7 },
      lifecycleNotify: () => pending,
    });
    try {
      await monitor.checkMarkets();
      await vi.waitFor(() => expect(alerts).toHaveLength(1));
      await monitor.checkMarkets();
      expect(broadcast).toHaveBeenCalledTimes(2);
    } finally { release({ sent: true }); }
    await monitor.waitForNotifications();
  });

  it("broadcast errors are logged but liquidity notifications still run", async () => {
    const { monitor, errors, notified, setSnapshots } = makeDeps({
      initial: [snap({ market: { liquidity: 25_000_000n } })],
      broadcastImpl: async () => { throw new Error("broadcast rpc down"); },
    });
    await monitor.checkMarkets();
    setSnapshots([snap({ market: { liquidity: 1_000_000n } })]);
    await monitor.checkMarkets();
    await monitor.waitForNotifications();
    expect(errors.join(" ")).toContain("broadcast failed (loop continues): broadcast rpc down");
    expect(notified.map((n) => n.scenario)).toEqual(["sudden_drain"]);
  });

  it("a late notification from an old danger-zone entry does not suppress the next entry", async () => {
    const releases = [];
    const sendImpl = vi.fn(() => new Promise((resolve) => { releases.push(resolve); }));
    const { monitor, setSnapshots } = makeDeps({
      initial: [snap({ market: { liquidity: 25_000_000n } })], sendImpl,
    });
    try {
      await monitor.checkMarkets();
      setSnapshots([snap({ market: { liquidity: 1_000_000n } })]);
      await monitor.checkMarkets();
      await vi.waitFor(() => expect(sendImpl).toHaveBeenCalledTimes(1));
      setSnapshots([snap({ market: { liquidity: 25_000_000n } })]);
      await monitor.checkMarkets();
      setSnapshots([snap({ market: { liquidity: 1_000_000n } })]);
      await monitor.checkMarkets();
      await vi.waitFor(() => expect(sendImpl).toHaveBeenCalledTimes(2));
      releases[0]({ ntfyDelivered: true });
      await vi.waitFor(() => expect(monitor.stateFor(MARKET_A).pendingGeneration).toBe(1));
      expect(monitor.stateFor(MARKET_A).hasNotifiedThisCycle).toBe(false);
      releases[1]({ ntfyDelivered: true });
      await monitor.waitForNotifications();
      expect(monitor.stateFor(MARKET_A).hasNotifiedThisCycle).toBe(true);
    } finally { releases.forEach((resolve) => resolve({ ntfyDelivered: true })); }
  });

  it("pending notifications reserve the daily quota across markets", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const sendImpl = vi.fn(() => pending);
    const high = { market: { liquidity: 25_000_000n } };
    const low = { market: { liquidity: 1_000_000n } };
    const { monitor, notified, setSnapshots } = makeDeps({
      initial: [snap(high), snap({ ...high, id: MARKET_B })],
      maxNotificationsPerDay: 1, sendImpl,
    });
    try {
      await monitor.checkMarkets();
      setSnapshots([snap(low), snap({ ...low, id: MARKET_B })]);
      await monitor.checkMarkets();
      expect(notified).toHaveLength(1);
      expect(sendImpl).toHaveBeenCalledTimes(1);
    } finally { release({ ntfyDelivered: true }); }
    await monitor.waitForNotifications();
  });
  it("chu kỳ đầu chỉ khởi tạo state, KHÔNG thông báo", async () => {
    const { monitor, notified } = makeDeps();
    await monitor.checkMarkets();
    expect(notified).toHaveLength(0);
    expect(monitor.stateFor(MARKET_A).lastSeenLiquidity).toBe(1_000_000n);
  });

  it("tụt vào vùng nguy hiểm ⇒ thông báo sudden_drain; chu kỳ lặp lại KHÔNG báo lần nữa", async () => {
    const { monitor, notified, setSnapshots } = makeDeps({ initial: [snap({ market: { liquidity: 25_000_000n } })] });
    await monitor.checkMarkets();            // init ở ngoài vùng (25M > drain 20M)
    setSnapshots([snap({ market: { liquidity: 1_000_000n } })]); // tụt xuống trong vùng
    await monitor.checkMarkets();
    await monitor.checkMarkets();            // giữ nguyên trong vùng → không transition mới
    expect(notified.map((n) => n.scenario)).toEqual(["sudden_drain"]);
  });

  it("ntfy fail ⇒ không tiêu quota và có log lỗi", async () => {
    const { monitor, errors, setSnapshots } = makeDeps({
      initial: [snap({ market: { liquidity: 25_000_000n } })],
      delivery: { ntfyDelivered: false, ntfyError: new Error("ntfy down") },
    });
    await monitor.checkMarkets();
    setSnapshots([snap({ market: { liquidity: 1_000_000n } })]);
    await monitor.checkMarkets();
    await monitor.waitForNotifications();
    expect(monitor.stateFor(MARKET_A).hasNotifiedThisCycle).toBe(false);
    expect(errors.join(" ")).toMatch(/ntfy failed/);
  });

  it("reader lỗi ⇒ chu kỳ không ném ra ngoài, chỉ log (loop sống tiếp)", async () => {
    const { monitor, errors } = makeDeps({ readError: new Error("rpc down") });
    await expect(monitor.checkMarkets()).resolves.toBeUndefined();
    expect(errors.join(" ")).toMatch(/check cycle failed.*rpc down/);
  });

  it("outbox vẫn drain khi reader thất bại và không chặn chu kỳ nếu drain lỗi", async () => {
    const drainAlerts = vi.fn().mockRejectedValueOnce(new Error("registry temporarily locked")).mockResolvedValue({ sent: 0 });
    const { monitor, errors } = makeDeps({ readError: new Error("rpc down"), drainAlerts });
    await monitor.checkMarkets();
    await monitor.checkMarkets();
    await monitor.waitForNotifications();
    expect(drainAlerts).toHaveBeenCalledTimes(2);
    expect(errors.join(" ")).toContain("registry temporarily locked");
  });

  it("drain outbox asynchronously after broadcast, even when registry idle", async () => {
    const order = [];
    const { monitor, broadcast } = makeDeps({
      drainAlerts: vi.fn(async () => { order.push("drain"); }),
      broadcastImpl: async () => { order.push("broadcast"); return null; },
    });
    await monitor.checkMarkets();
    await monitor.waitForNotifications();
    expect(order).toEqual(["broadcast", "drain"]);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});

describe("createMonitor — cảnh báo vòng đời", () => {
  it("stuck được chuyển thành alert tức thời", async () => {
    const { monitor, alerts } = makeDeps({ broadcastResult: { stuck: true, id: "c1", marketId: MARKET_A, nonce: 7, diagnostic: "no rawTx" } });
    await monitor.checkMarkets();
    await monitor.waitForNotifications();
    expect(alerts.map((a) => a.kind)).toEqual(["stuck"]);
  });

  it("config được báo tức thời; invalid đi qua outbox, kind lạ bị bỏ qua", async () => {
    const { monitor, alerts } = makeDeps({
      broadcastResult: {
        problems: [
          { kind: "invalid", id: "b1", marketId: MARKET_A, nonce: 7, error: "bad calldata" },
          { kind: "config", id: "b3", marketId: MARKET_A, nonce: 7, error: "wrong lender" },
          { kind: "unknown", id: "b2", marketId: MARKET_A, nonce: 8, error: "?" },
        ],
      },
    });
    await monitor.checkMarkets();
    await monitor.waitForNotifications();
    expect(alerts.map((a) => a.kind)).toEqual(["config"]);
  });

  it("superseded đi qua outbox, không gửi trùng cảnh báo tức thời", async () => {
    const { monitor, alerts } = makeDeps({ broadcastResult: { superseded: true, id: "b1", nonce: 7 } });
    await monitor.checkMarkets();
    expect(alerts).toHaveLength(0);
  });

  it("kết quả idle/terminal-only (không có cờ) không báo gì", async () => {
    const { monitor, alerts } = makeDeps({ broadcastResult: { idle: true, diagnostic: "registry idle" } });
    await monitor.checkMarkets();
    expect(alerts).toHaveLength(0);
  });
});

describe("monitor + durable presigned lifecycle integration", () => {
  it("gửi riêng từng nonce expired và drain tiếp ngay cả khi broadcaster idle", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-monitor-alert-"));
    try {
      const filePath = path.join(dir, "presigned.json");
      fs.writeFileSync(filePath, JSON.stringify({ version: 3, bundles: {
        a: { nonce: 2, status: "pending", withdrawals: [] },
        b: { nonce: 3, status: "pending", withdrawals: [] },
      } }));
      const sent = vi.fn(async () => {});
      const drainAlerts = () => drainLifecycleAlerts({ filePath, updateRegistry, send: sent, logger: { error() {} } });
      const broadcast = vi.fn(async (snapshots) => broadcastEligible({
        filePath, updateRegistry, snapshots,
        client: { getTransactionCount: async () => 4 }, lenderAddress: "0x111",
        verifyBundle: async () => ({ ok: true }), isEligible: () => false,
        logger: { log() {}, warn() {}, error() {} },
      }));
      const monitor = createMonitor({
        markets: [], reader: { readSnapshots: async () => ({ snapshots: new Map(), failures: new Map() }) },
        lifecycleAlerts: { notify: vi.fn() }, sendNotification: vi.fn(),
        broadcastEligible: broadcast, drainAlerts,
        config: { notificationCooldownMs: 0, maxNotificationsPerDay: 0 },
      });
      await monitor.checkMarkets();
      await monitor.waitForNotifications();
      expect(sent).toHaveBeenCalledTimes(2);
      expect(sent.mock.calls.map(([alert]) => alert.title)).toEqual([
        "Morpho: Presigned Nonce Expired", "Morpho: Presigned Nonce Expired",
      ]);
      await monitor.checkMarkets();
      await monitor.waitForNotifications();
      expect(sent).toHaveBeenCalledTimes(2);
      expect(broadcast).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("createMonitor — state cô lập", () => {
  it("hai monitor không chia sẻ state (không còn module-level Map)", async () => {
    const a = makeDeps();
    const b = makeDeps();
    await a.monitor.checkMarkets();
    expect(a.monitor.stateFor(MARKET_A).lastSeenLiquidity).toBe(1_000_000n);
    expect(b.monitor.stateFor(MARKET_A).lastSeenLiquidity).toBeNull();
  });
});
