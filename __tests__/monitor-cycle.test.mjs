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

function makeDeps({ initial = [snap()], broadcastResult = null, delivery = { ntfyDelivered: true }, readError = null, now, drainAlerts = vi.fn(async () => {}) } = {}) {
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
  const monitor = createMonitor({
    markets: [{ id: MARKET_A, minLiquidity: "1", suddenDrainMultiplier: 2 }],
    reader,
    lifecycleAlerts: { notify: vi.fn(async (kind, info) => { alerts.push({ kind, info }); return { sent: true }; }) },
    sendNotification: vi.fn(async (snapshot, scenario) => { notified.push({ id: snapshot.id, scenario }); return delivery; }),
    broadcastEligible: vi.fn(async () => broadcastResult),
    drainAlerts,
    config: { notificationCooldownMs: 0, maxNotificationsPerDay: 10, wssDebounceMs: 1, monitorIntervalMs: 1, wssUrls: [], morphoBlueAddress: MORPHO },
    logger: { log: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    ...(now ? { now } : {}),
  });
  return { monitor, notified, alerts, errors, reader, drainAlerts, setSnapshots: (next) => { snapshots = next; } };
}

describe("createMonitor — chu kỳ check", () => {
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
    expect(drainAlerts).toHaveBeenCalledTimes(4);
    expect(errors.join(" ")).toContain("registry temporarily locked");
  });

  it("drain outbox trước và sau broadcast, kể cả khi registry idle", async () => {
    const order = [];
    const drainAlerts = vi.fn(async () => { order.push("drain"); });
    const { monitor } = makeDeps({ drainAlerts });
    await monitor.checkMarkets();
    expect(order).toEqual(["drain", "drain"]);
  });
});

describe("createMonitor — cảnh báo vòng đời", () => {
  it("stuck được chuyển thành alert tức thời", async () => {
    const { monitor, alerts } = makeDeps({ broadcastResult: { stuck: true, id: "c1", marketId: MARKET_A, nonce: 7, diagnostic: "no rawTx" } });
    await monitor.checkMarkets();
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
      expect(sent).toHaveBeenCalledTimes(2);
      expect(sent.mock.calls.map(([alert]) => alert.title)).toEqual([
        "Morpho: Presigned Nonce Expired", "Morpho: Presigned Nonce Expired",
      ]);
      await monitor.checkMarkets();
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
