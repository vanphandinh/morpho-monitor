import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { LENDER_ADDRESS, MORPHO_BLUE_ADDRESS, RPC_URLS, WSS_URLS, WSS_DEBOUNCE_MS, MONITOR_INTERVAL_MS, NOTIFICATION_COOLDOWN_MS, MAX_NOTIFICATIONS_PER_DAY, NTFY_SERVER, NTFY_TOPIC, WEBAPP_URL, PRESIGNED_FILE, MARKETS_FILE, VOIP_SECRET_KEY, formatTokenAmount, wadToPercent } from "./shared.mjs";
import { shouldNotify, computeDrainThreshold, shouldBroadcastPresigned } from "./monitor-rules.mjs";
import { createRobustPublicClient, addGlobalErrorHandlers } from "./rpc-client.mjs";
import { loadMarkets } from "./market-config.mjs";
import { createMarketReader } from "./market-reader.mjs";
import { updateRegistry } from "./presigned-store.mjs";
import { verifyPresignedBundle } from "./presign-verify.mjs";
import { createCheckScheduler, createWssWatcher } from "./monitor-triggers.mjs";
import { createWssConnect } from "./wss-connect.mjs";
import { broadcastEligible as runPresignedBroadcast } from "./presigned-broadcast.mjs";
import { dispatchNotifications } from "./notification-dispatch.mjs";
import { createLifecycleAlerter, postNtfy } from "./lifecycle-alert.mjs";
import { sendVoipNotification } from "./voip.mjs";

/**
 * Kind của `problems` mà broadcastEligible có thể trả (audit D2).
 *
 * Audit P1.5: hằng số + vòng đời chu kỳ nằm ở đây thay vì module-level, để
 * `createMonitor` import được trong vitest mà không bật timer/handler toàn cục.
 */
const LIFECYCLE_PROBLEM_KINDS = new Set(["config", "invalid"]);

/**
 * Payload ntfy cho một chu kỳ cảnh báo (audit vòng 5, O4).
 *
 * Trước đây khối này nằm inline trong `main()` nên `__tests__/ntfy.test.mjs` phải **nhân bản**
 * nó để test — và bản sao đó đã lệch khỏi production từ lâu (test vẫn xanh trong khi payload
 * thật khác). Nay payload là hàm thuần được export: test import đúng thứ production chạy.
 *
 * Bất biến quan trọng nhất: **mọi giá trị header phải là Latin-1 (≤ U+00FF)**, vì undici ném
 * `ByteString` error nếu header có ký tự cao hơn — tên token và Title đều đi vào header.
 * Tiếng Việt có dấu chỉ được nằm trong BODY (UTF-8).
 *
 * @returns {{ headers: Record<string,string>, body: string }}
 */
export function buildNtfyPayload({ scenario, id, loanToken, collateralToken, market, position, webappUrl, lenderAddress }) {
  const link = `${webappUrl}?market=${id}&lender=${lenderAddress}`;
  const drained = scenario === "sudden_drain";
  return {
    headers: {
      Title: drained ? `Morpho: liquidity drain ${loanToken.symbol || ""}` : `Morpho: liquidity available ${loanToken.symbol || ""}`,
      Tags: drained ? "warning,chart_with_downwards_trend" : "moneybag",
      Priority: "4",
      Markdown: "yes",
      Click: link,
    },
    body: [
      `**${drained ? "Liquidity drain warning" : "Liquidity available"}**`,
      "",
      `**Market:** ${collateralToken.symbol || "?"}/${loanToken.symbol || "?"}`,
      `**Liquidity:** ${formatTokenAmount(market.liquidity, loanToken.decimals, loanToken.symbol)}`,
      `**Position:** ${formatTokenAmount(position.supplyAssets, loanToken.decimals, loanToken.symbol)}`,
      `**Utilization:** ${wadToPercent(market.utilization)}`,
      "",
      `[Open withdrawal page](${link})`,
    ].join("\n"),
  };
}

/**
 * Orchestration của monitor — mọi I/O đi qua tham số (audit P1.5).
 *
 * Trước đây phần này chạy ngay ở module-level (`loadMarkets`, `setInterval`,
 * `process.on`) nên không thể import trong test: cùng lắm chỉ `node --check` hoặc
 * ghim source bằng regex. Tách thành factory giữ nguyên hành vi nhưng cho phép
 * test `checkMarkets` với reader/notifier/broadcaster giả.
 *
 * @param {object} deps
 * @param {Array<{id:string, minLiquidity:string, suddenDrainMultiplier:number}>} deps.markets
 * @param {string[]} [deps.marketIds]
 * @param {{ readSnapshots: (ids?: string[]) => Promise<object> }} deps.reader
 * @param {object} deps.lifecycleAlerts - `createLifecycleAlerter(...)` (hoặc fake có `.notify`)
 * @param {(snapshot:object, scenario:string) => Promise<object>} deps.sendNotification
 * @param {(snapshots:Map<string,object>) => Promise<object>} deps.broadcastEligible
 * @param {object} deps.config - ngưỡng/chu kỳ (xem bootstrap)
 * @param {Function} [deps.createScheduler]
 * @param {Function} [deps.createWatcher]
 * @param {Function} [deps.connect]
 * @param {object} [deps.logger]
 * @param {() => number} [deps.now]
 */
export function createMonitor({
  markets,
  marketIds = markets.map((market) => market.id),
  reader,
  lifecycleAlerts,
  sendNotification,
  broadcastEligible,
  config,
  createScheduler = createCheckScheduler,
  createWatcher = createWssWatcher,
  connect = createWssConnect({ address: config.morphoBlueAddress }),
  logger = console,
  now = () => Date.now(),
} = {}) {
  const states = new Map();
  let notificationsToday = 0;
  let dayStart = now();
  let scheduler;
  let wssWatcher;

  function stateFor(id) { if (!states.has(id)) states.set(id, { lastSeenLiquidity: null, hasNotifiedThisCycle: false, lastNotificationTime: 0 }); return states.get(id); }
  function resetDaily() { if (now() - dayStart >= 86_400_000) { notificationsToday = 0; dayStart = now(); } }

  /**
   * Biến kết quả broadcastEligible thành cảnh báo (R1). Chỉ báo khi BẬC THANG KHÔNG
   * TIẾN: claim đã tự nhả vì bị tx khác thay thế (`superseded`), claim cần đối
   * soát tay (`stuck`), hay xung đột nonce (`conflict`). Kết quả thông tin
   * (idle/terminal-only) không báo gì. Kind lạ bị bỏ qua để kênh cảnh báo không
   * bao giờ tự bịa thông báo.
   */
  async function alertOnLifecycle(result) {
    if (!result) return;
    const marketId = result.marketId ?? result.bundle?.marketId ?? null;
    const nonce = result.nonce ?? result.bundle?.nonce ?? null;
    const tier = result.bundle?.broadcastingTier ?? null;
    if (result.superseded) await lifecycleAlerts.notify("superseded", { id: result.id, marketId, nonce, tier, detail: result.diagnostic });
    else if (result.conflict) await lifecycleAlerts.notify("conflict", { id: result.id, marketId, nonce, tier, detail: result.diagnostic });
    else if (result.stuck) await lifecycleAlerts.notify("stuck", { id: result.id, marketId, nonce, tier, detail: result.diagnostic });

    // D2: vấn đề verify của chu kỳ (không loại trừ claim — một chu kỳ có thể vừa claim
    // một rung vừa phát hiện rung khác hỏng/lệch cấu hình).
    for (const problem of result.problems ?? []) {
      if (!LIFECYCLE_PROBLEM_KINDS.has(problem?.kind)) continue;
      await lifecycleAlerts.notify(problem.kind, {
        id: problem.id,
        marketId: problem.marketId,
        nonce: problem.nonce,
        detail: problem.error,
      });
    }
  }

  async function checkMarkets(ids = marketIds) {
    try {
      resetDaily();
      const { snapshots, failures } = await reader.readSnapshots(ids);
      for (const [id, err] of failures) logger.warn(`[monitor] ${id}: multicall failed: ${err.message || err}`);
      for (const snapshot of snapshots.values()) {
        const state = stateFor(snapshot.id), liquidity = snapshot.market.liquidity, supplyAssets = snapshot.position.supplyAssets;
        if (state.lastSeenLiquidity === null) { state.lastSeenLiquidity = liquidity; logger.log(`[monitor] initialized ${snapshot.id}: ${formatTokenAmount(liquidity, snapshot.loanToken.decimals, snapshot.loanToken.symbol)}`); continue; }
        const multiplier = snapshot.suddenDrainMultiplier;
        const decision = shouldNotify({ liquidity, lastSeenLiquidity: state.lastSeenLiquidity, supplyAssets, hasNotifiedThisCycle: state.hasNotifiedThisCycle, lastNotificationTime: state.lastNotificationTime, notificationsToday, notificationDayStart: dayStart, minLiquidityThreshold: snapshot.minLiquidityWei, suddenDrainMultiplier: multiplier, notificationCooldownMs: config.notificationCooldownMs, maxNotificationsPerDay: config.maxNotificationsPerDay });
        if (decision.shouldNotify) {
          const delivery = await sendNotification(snapshot, decision.scenario);
          if (delivery.ntfyDelivered) { state.hasNotifiedThisCycle = true; state.lastNotificationTime = now(); notificationsToday++; }
          else logger.error(`[monitor] ntfy failed for ${snapshot.id}: ${delivery.ntfyError?.message || "unknown error"}`);
        }
        if (state.hasNotifiedThisCycle && (liquidity < snapshot.minLiquidityWei || liquidity > computeDrainThreshold(supplyAssets, multiplier))) state.hasNotifiedThisCycle = false;
        state.lastSeenLiquidity = liquidity;
      }
      await alertOnLifecycle(await broadcastEligible(snapshots));
    } catch (err) {
      // RPC outage / any cycle failure: log per cycle, keep the loop alive (M5).
      logger.error(`[monitor] check cycle failed (loop continues): ${err?.message || err}`);
    }
  }

  /**
   * Start polling + WSS; returns a `stop()` that owns every timer/socket this
   * monitor created. Caller (bootstrap) wires process signals.
   */
  function start() {
    scheduler = createScheduler((ids) => checkMarkets(ids ?? marketIds), { debounceMs: config.wssDebounceMs });
    wssWatcher = createWatcher({
      urls: config.wssUrls,
      eventNames: ["Supply", "Withdraw", "Borrow", "Repay", "Liquidate"],
      marketIds,
      onMarkets: (ids) => scheduler.request(ids),
      connect,
    });
    void wssWatcher.start();
    scheduler.request();
    const interval = setInterval(() => scheduler.request(), config.monitorIntervalMs);
    return () => { clearInterval(interval); scheduler.close(); wssWatcher?.close(); };
  }

  return { checkMarkets, start, stateFor };
}

async function main() {
  addGlobalErrorHandlers("monitor");
  const markets = loadMarkets(MARKETS_FILE);
  const marketIds = markets.map((market) => market.id);
  // Audit vòng 2: 2s sticky để các lần đọc liên tiếp trong cùng chu kỳ nhìn CÙNG một
  // node — đặc biệt cặp bằng chứng receipt → nonce khi nhả claim (xoay sang node khác
  // sẽ trộn hai góc nhìn lệch nhau). Chỉ bật ở monitor để giữ blast radius nhỏ.
  const publicClient = createRobustPublicClient(RPC_URLS, { stickyMs: 2_000 });
  const topic = NTFY_TOPIC || `morpho-monitor-${crypto.randomBytes(4).toString("hex")}`;

  // R1: claim bị tx khác thay thế / cần đối soát tay / xung đột nonce là những ca
  // "bậc thang không thể tiến". Kênh này KHÔNG tiêu quota thanh khoản.
  const lifecycleAlerts = createLifecycleAlerter({
    send: (alert) => postNtfy({ server: NTFY_SERVER, topic, alert }),
  });

  const reader = await createMarketReader({ client: publicClient, lenderAddress: LENDER_ADDRESS, morphoBlueAddress: MORPHO_BLUE_ADDRESS, markets });
  console.log(`[monitor] ${markets.length} market(s), ${RPC_URLS.length} HTTP RPC endpoint(s), topic=${topic}`);

  const sendNtfyNotification = async (snapshot, scenario) => {
    const { market, position, loanToken, collateralToken, id } = snapshot;
    const { headers, body } = buildNtfyPayload({
      scenario, id, loanToken, collateralToken, market, position,
      webappUrl: WEBAPP_URL, lenderAddress: LENDER_ADDRESS,
    });
    const response = await fetch(`${NTFY_SERVER}/${topic}`, { method: "POST", headers, body });
    if (!response.ok) throw new Error(`ntfy responded ${response.status}`);
  };

  const monitor = createMonitor({
    markets,
    marketIds,
    reader,
    lifecycleAlerts,
    sendNotification: (snapshot, scenario) => dispatchNotifications({
      sendNtfy: () => sendNtfyNotification(snapshot, scenario),
      sendVoip: () => sendVoipNotification(snapshot.market, snapshot.loanToken, snapshot.collateralToken, snapshot.position, scenario),
      voipEnabled: Boolean(VOIP_SECRET_KEY),
    }),
    broadcastEligible: (snapshots) => runPresignedBroadcast({
      client: publicClient, lenderAddress: LENDER_ADDRESS, filePath: PRESIGNED_FILE, snapshots,
      updateRegistry,
      verifyBundle: (bundle, id) => verifyPresignedBundle(bundle, { morphoBlueAddress: MORPHO_BLUE_ADDRESS, lenderAddress: LENDER_ADDRESS, marketId: id }),
      isEligible: (snapshot) => shouldBroadcastPresigned(snapshot.market.liquidity, computeDrainThreshold(snapshot.position.supplyAssets, snapshot.suddenDrainMultiplier), snapshot.minLiquidityWei),
    }),
    config: {
      monitorIntervalMs: MONITOR_INTERVAL_MS,
      notificationCooldownMs: NOTIFICATION_COOLDOWN_MS,
      maxNotificationsPerDay: MAX_NOTIFICATIONS_PER_DAY,
      wssUrls: WSS_URLS,
      wssDebounceMs: WSS_DEBOUNCE_MS,
      morphoBlueAddress: MORPHO_BLUE_ADDRESS,
    },
  });

  const stop = monitor.start();
  process.once("SIGINT", () => { stop(); process.exit(0); });
  process.once("SIGTERM", () => { stop(); process.exit(0); });
}

// Chỉ chạy bootstrap khi được gọi trực tiếp (`node monitor.mjs`), không phải khi
// import trong test. Node >=20 chưa có `import.meta.main` nên so bằng argv[1].
const isDirectRun = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) main().catch((err) => { console.error("Fatal monitor error:", err); process.exit(1); });
