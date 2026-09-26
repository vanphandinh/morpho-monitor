/**
 * createMonitor() — orchestration test được với deps giả (audit P1.5).
 *
 * Trước đây phần này chạy ở module-level (`loadMarkets`, `setInterval`,
 * `process.on`) nên chỉ ghim được source bằng regex. Sau refactor, `checkMarkets`
 * nhận reader/notifier/broadcaster/alerts qua tham số, nên hành vi per-market,
 * dedupe chu kỳ và đường cảnh báo vòng đời được kiểm chứng trực tiếp.
 */
import { describe, it, expect, vi } from "vitest";
import { createMonitor } from "../monitor.mjs";

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

function makeDeps({ initial = [snap()], broadcastResult = null, delivery = { ntfyDelivered: true }, readError = null, now } = {}) {
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
    config: { notificationCooldownMs: 0, maxNotificationsPerDay: 10, wssDebounceMs: 1, monitorIntervalMs: 1, wssUrls: [], morphoBlueAddress: MORPHO },
    logger: { log: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    ...(now ? { now } : {}),
  });
  return { monitor, notified, alerts, errors, reader, setSnapshots: (next) => { snapshots = next; } };
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
});

describe("createMonitor — cảnh báo vòng đời", () => {
  it("stuck/superseded/conflict được chuyển thành alert", async () => {
    const { monitor, alerts } = makeDeps({ broadcastResult: { stuck: true, id: "c1", marketId: MARKET_A, nonce: 7, diagnostic: "no rawTx" } });
    await monitor.checkMarkets();
    expect(alerts.map((a) => a.kind)).toEqual(["stuck"]);
  });

  it("problems: chỉ kind đã biết được báo; kind lạ bị bỏ qua", async () => {
    const { monitor, alerts } = makeDeps({
      broadcastResult: {
        problems: [
          { kind: "invalid", id: "b1", marketId: MARKET_A, nonce: 7, error: "bad calldata" },
          { kind: "unknown", id: "b2", marketId: MARKET_A, nonce: 8, error: "?" },
        ],
      },
    });
    await monitor.checkMarkets();
    expect(alerts.map((a) => a.kind)).toEqual(["invalid"]);
  });

  it("kết quả idle/terminal-only (không có cờ) không báo gì", async () => {
    const { monitor, alerts } = makeDeps({ broadcastResult: { idle: true, diagnostic: "registry idle" } });
    await monitor.checkMarkets();
    expect(alerts).toHaveLength(0);
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
