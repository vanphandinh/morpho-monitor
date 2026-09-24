import crypto from "node:crypto";
import { LENDER_ADDRESS, MORPHO_BLUE_ADDRESS, RPC_URLS, WSS_URLS, WSS_DEBOUNCE_MS, MONITOR_INTERVAL_MS, NOTIFICATION_COOLDOWN_MS, MAX_NOTIFICATIONS_PER_DAY, NTFY_SERVER, NTFY_TOPIC, WEBAPP_URL, PRESIGNED_FILE, MARKETS_FILE, VOIP_SECRET_KEY, shouldNotify, computeDrainThreshold, shouldBroadcastPresigned, formatTokenAmount, wadToPercent } from "./shared.mjs";
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

addGlobalErrorHandlers("monitor");
const markets = loadMarkets(MARKETS_FILE);
const marketIds = markets.map((market) => market.id);
// Audit vòng 2: 2s sticky để các lần đọc liên tiếp trong cùng chu kỳ nhìn CÙNG một
// node — đặc biệt cặp bằng chứng receipt → nonce khi nhả claim (xoay sang node khác
// sẽ trộn hai góc nhìn lệch nhau). Chỉ bật ở monitor để giữ blast radius nhỏ.
const publicClient = createRobustPublicClient(RPC_URLS, { stickyMs: 2_000 });
const topic = NTFY_TOPIC || `morpho-monitor-${crypto.randomBytes(4).toString("hex")}`;
const states = new Map();
let reader, notificationsToday = 0, dayStart = Date.now(), scheduler, wssWatcher;

// R1: claim bị tx khác thay thế / cần đối soát tay / xung đột nonce là những ca
// "bậc thang không thể tiến". Trước đây chúng chỉ nằm trong log mỗi chu kỳ nên
// monitor im lặng dù đã ngừng broadcast. Kênh này KHÔNG tiêu quota thanh khoản.
const lifecycleAlerts = createLifecycleAlerter({
  send: (alert) => postNtfy({ server: NTFY_SERVER, topic, alert }),
});

function stateFor(id) { if (!states.has(id)) states.set(id, { lastSeenLiquidity: null, hasNotifiedThisCycle: false, lastNotificationTime: 0 }); return states.get(id); }
function resetDaily() { if (Date.now() - dayStart >= 86_400_000) { notificationsToday = 0; dayStart = Date.now(); } }

async function sendNtfyNotification(snapshot, scenario) {
  const { market, position, loanToken, collateralToken, id } = snapshot;
  const link = `${WEBAPP_URL}?market=${id}&lender=${LENDER_ADDRESS}`;
  const drained = scenario === "sudden_drain";
  const response = await fetch(`${NTFY_SERVER}/${topic}`, { method: "POST", headers: { Title: drained ? `Morpho: liquidity drain ${loanToken.symbol || ""}` : `Morpho: liquidity available ${loanToken.symbol || ""}`, Tags: drained ? "warning,chart_with_downwards_trend" : "moneybag", Priority: "4", Markdown: "yes", Click: link }, body: [`**${drained ? "Liquidity drain warning" : "Liquidity available"}**`, "", `**Market:** ${collateralToken.symbol || "?"}/${loanToken.symbol || "?"}`, `**Liquidity:** ${formatTokenAmount(market.liquidity, loanToken.decimals, loanToken.symbol)}`, `**Position:** ${formatTokenAmount(position.supplyAssets, loanToken.decimals, loanToken.symbol)}`, `**Utilization:** ${wadToPercent(market.utilization)}`, "", `[Open withdrawal page](${link})`].join("\n") });
  if (!response.ok) throw new Error(`ntfy responded ${response.status}`);
}

async function sendNotification(snapshot, scenario) {
  return dispatchNotifications({
    sendNtfy: () => sendNtfyNotification(snapshot, scenario),
    sendVoip: () => sendVoipNotification(snapshot.market, snapshot.loanToken, snapshot.collateralToken, snapshot.position, scenario),
    voipEnabled: Boolean(VOIP_SECRET_KEY),
  });
}

async function broadcastEligible(snapshots) {
  return runPresignedBroadcast({
    client: publicClient, lenderAddress: LENDER_ADDRESS, filePath: PRESIGNED_FILE, snapshots,
    updateRegistry,
    verifyBundle: (bundle, id) => verifyPresignedBundle(bundle, { morphoBlueAddress: MORPHO_BLUE_ADDRESS, lenderAddress: LENDER_ADDRESS, marketId: id }),
    isEligible: (snapshot) => shouldBroadcastPresigned(snapshot.market.liquidity, computeDrainThreshold(snapshot.position.supplyAssets, snapshot.suddenDrainMultiplier), snapshot.minLiquidityWei),
  });
}

/**
 * Biến kết quả broadcastEligible thành cảnh báo (R1). Chỉ báo khi BẬC THANG KHÔNG
 * TIẾN: claim đã tự nhả vì bị tx khác thay thế (`superseded`), claim cần đối
 * soát tay (`stuck`), hay xung đột nonce (`conflict`). Kết quả thông tin
 * (idle/terminal-only) không báo gì.
 */
/** Kind của `problems` mà broadcastEligible có thể trả (audit D2). */
const LIFECYCLE_PROBLEM_KINDS = new Set(["config", "invalid"]);

async function alertOnLifecycle(result) {
  if (!result) return;
  const marketId = result.marketId ?? result.bundle?.marketId ?? null;
  const nonce = result.nonce ?? result.bundle?.nonce ?? null;
  const tier = result.bundle?.broadcastingTier ?? null;
  if (result.superseded) await lifecycleAlerts.notify("superseded", { id: result.id, marketId, nonce, tier, detail: result.diagnostic });
  else if (result.conflict) await lifecycleAlerts.notify("conflict", { id: result.id, marketId, nonce, tier, detail: result.diagnostic });
  else if (result.stuck) await lifecycleAlerts.notify("stuck", { id: result.id, marketId, nonce, tier, detail: result.diagnostic });

  // D2: vấn đề verify của chu kỳ (không loại trừ claim — một chu kỳ có thể vừa claim
  // một rung vừa phát hiện rung khác hỏng/lệch cấu hình). Kind lạ bị bỏ qua để kênh
  // cảnh báo không bao giờ tự bịa thông báo.
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
    for (const [id, err] of failures) console.warn(`[monitor] ${id}: multicall failed: ${err.message || err}`);
    for (const snapshot of snapshots.values()) {
      const state = stateFor(snapshot.id), liquidity = snapshot.market.liquidity, supplyAssets = snapshot.position.supplyAssets;
      if (state.lastSeenLiquidity === null) { state.lastSeenLiquidity = liquidity; console.log(`[monitor] initialized ${snapshot.id}: ${formatTokenAmount(liquidity, snapshot.loanToken.decimals, snapshot.loanToken.symbol)}`); continue; }
      const multiplier = snapshot.suddenDrainMultiplier;
      const decision = shouldNotify({ liquidity, lastSeenLiquidity: state.lastSeenLiquidity, supplyAssets, hasNotifiedThisCycle: state.hasNotifiedThisCycle, lastNotificationTime: state.lastNotificationTime, notificationsToday, notificationDayStart: dayStart, minLiquidityThreshold: snapshot.minLiquidityWei, suddenDrainMultiplier: multiplier, notificationCooldownMs: NOTIFICATION_COOLDOWN_MS, maxNotificationsPerDay: MAX_NOTIFICATIONS_PER_DAY });
      if (decision.shouldNotify) {
        const delivery = await sendNotification(snapshot, decision.scenario);
        if (delivery.ntfyDelivered) { state.hasNotifiedThisCycle = true; state.lastNotificationTime = Date.now(); notificationsToday++; }
        else console.error(`[monitor] ntfy failed for ${snapshot.id}: ${delivery.ntfyError?.message || "unknown error"}`);
      }
      if (state.hasNotifiedThisCycle && (liquidity < snapshot.minLiquidityWei || liquidity > computeDrainThreshold(supplyAssets, multiplier))) state.hasNotifiedThisCycle = false;
      state.lastSeenLiquidity = liquidity;
    }
    await alertOnLifecycle(await broadcastEligible(snapshots));
  } catch (err) {
    // RPC outage / any cycle failure: log per cycle, keep the loop alive (M5).
    console.error(`[monitor] check cycle failed (loop continues): ${err?.message || err}`);
  } finally { /* scheduler owns serialization */ }
}

function startWss() {
  wssWatcher = createWssWatcher({
    urls: WSS_URLS,
    eventNames: ["Supply", "Withdraw", "Borrow", "Repay", "Liquidate"],
    marketIds,
    onMarkets: (ids) => scheduler.request(ids),
    // close() dùng đúng API viem (getRpcClient/getSocket) — xem wss-connect.mjs.
    connect: createWssConnect({ address: MORPHO_BLUE_ADDRESS }),
  });
  void wssWatcher.start();
}

async function main() {
  reader = await createMarketReader({ client: publicClient, lenderAddress: LENDER_ADDRESS, morphoBlueAddress: MORPHO_BLUE_ADDRESS, markets });
  console.log(`[monitor] ${markets.length} market(s), ${RPC_URLS.length} HTTP RPC endpoint(s), topic=${topic}`);
  scheduler = createCheckScheduler((ids) => checkMarkets(ids ?? marketIds), { debounceMs: WSS_DEBOUNCE_MS });
  startWss(); scheduler.request();
  const interval = setInterval(() => scheduler.request(), MONITOR_INTERVAL_MS);
  const stop = () => { clearInterval(interval); scheduler.close(); wssWatcher?.close(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
main().catch((err) => { console.error("Fatal monitor error:", err); process.exit(1); });
