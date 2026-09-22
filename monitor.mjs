import { createPublicClient, webSocket } from "viem";
import { blueAbi } from "@morpho-org/blue-sdk-viem";
import crypto from "node:crypto";
import { LENDER_ADDRESS, MORPHO_BLUE_ADDRESS, RPC_URLS, WSS_URLS, WSS_DEBOUNCE_MS, MONITOR_INTERVAL_MS, SUDDEN_DRAIN_MULTIPLIER, NOTIFICATION_COOLDOWN_MS, MAX_NOTIFICATIONS_PER_DAY, NTFY_SERVER, NTFY_TOPIC, WEBAPP_URL, PRESIGNED_FILE, MARKETS_FILE, shouldNotify, computeDrainThreshold, shouldBroadcastPresigned, formatTokenAmount, wadToPercent } from "./shared.mjs";
import { createRobustPublicClient, addGlobalErrorHandlers } from "./rpc-client.mjs";
import { loadMarkets } from "./market-config.mjs";
import { createMarketReader } from "./market-reader.mjs";
import { updateRegistry } from "./presigned-store.mjs";
import { verifyPresignedBundle } from "./presign-verify.mjs";

addGlobalErrorHandlers("monitor");
const markets = loadMarkets(MARKETS_FILE);
const marketIds = markets.map((market) => market.id);
const publicClient = createRobustPublicClient(RPC_URLS);
const topic = NTFY_TOPIC || `morpho-monitor-${crypto.randomBytes(4).toString("hex")}`;
const states = new Map();
let reader, checking = false, notificationsToday = 0, dayStart = Date.now(), debounceTimer;
const unwatchers = [];

function stateFor(id) { if (!states.has(id)) states.set(id, { lastSeenLiquidity: null, hasNotifiedThisCycle: false, lastNotificationTime: 0 }); return states.get(id); }
function resetDaily() { if (Date.now() - dayStart >= 86_400_000) { notificationsToday = 0; dayStart = Date.now(); } }
function notifyCheck(ids) { clearTimeout(debounceTimer); debounceTimer = setTimeout(() => checkMarkets(ids).catch((err) => console.error(`[monitor] WSS check failed: ${err.message}`)), WSS_DEBOUNCE_MS); }

async function sendNotification(snapshot, scenario) {
  const { market, position, loanToken, collateralToken, id } = snapshot;
  const link = `${WEBAPP_URL}?market=${id}&lender=${LENDER_ADDRESS}`;
  const drained = scenario === "sudden_drain";
  const response = await fetch(`${NTFY_SERVER}/${topic}`, { method: "POST", headers: { Title: drained ? `Morpho: liquidity drain ${loanToken.symbol || ""}` : `Morpho: liquidity available ${loanToken.symbol || ""}`, Tags: drained ? "warning,chart_with_downwards_trend" : "moneybag", Priority: "4", Markdown: "yes", Click: link }, body: [`**${drained ? "Liquidity drain warning" : "Liquidity available"}**`, "", `**Market:** ${collateralToken.symbol || "?"}/${loanToken.symbol || "?"}`, `**Liquidity:** ${formatTokenAmount(market.liquidity, loanToken.decimals, loanToken.symbol)}`, `**Position:** ${formatTokenAmount(position.supplyAssets, loanToken.decimals, loanToken.symbol)}`, `**Utilization:** ${wadToPercent(market.utilization)}`, "", `[Open withdrawal page](${link})`].join("\n") });
  if (!response.ok) throw new Error(`ntfy responded ${response.status}`);
}

/** Claim under the registry lock: exactly one same-nonce bundle can be submitted. */
async function broadcastEligible(snapshots) {
  const nonce = await publicClient.getTransactionCount({ address: LENDER_ADDRESS, blockTag: "pending" });
  const claimed = await updateRegistry(PRESIGNED_FILE, async (registry) => {
    for (const bundle of Object.values(registry.bundles)) if ((bundle.status === "pending" || bundle.status === "broadcasting") && Number(bundle.nonce) !== Number(nonce)) { bundle.status = "expired"; bundle.expiredAt = new Date().toISOString(); bundle.error = `Lender nonce advanced to ${nonce}`; }
    for (const snapshot of snapshots.values()) {
      const bundle = registry.bundles[snapshot.id];
      const drain = computeDrainThreshold(snapshot.position.supplyAssets, snapshot.suddenDrainMultiplier ?? SUDDEN_DRAIN_MULTIPLIER);
      if (!bundle || bundle.status !== "pending" || Number(bundle.nonce) !== Number(nonce) || !shouldBroadcastPresigned(snapshot.market.liquidity, drain, snapshot.minLiquidityWei)) continue;
      const verified = await verifyPresignedBundle(bundle, { morphoBlueAddress: MORPHO_BLUE_ADDRESS, lenderAddress: LENDER_ADDRESS, marketId: snapshot.id });
      if (!verified.ok) { bundle.status = "invalid"; bundle.error = verified.error; continue; }
      const withdrawal = bundle.withdrawals.filter((w) => BigInt(w.amountWei || "0") <= snapshot.market.liquidity).sort((a, b) => BigInt(b.amountWei || "0") > BigInt(a.amountWei || "0") ? 1 : -1)[0];
      if (!withdrawal) continue;
      bundle.status = "broadcasting"; bundle.broadcastingAt = new Date().toISOString(); bundle.broadcastingTier = withdrawal.label;
      return { id: snapshot.id, signedTx: withdrawal.signedTx, label: withdrawal.label };
    }
    return null;
  });
  if (!claimed) return;
  try {
    const hash = await publicClient.sendRawTransaction({ serializedTransaction: claimed.signedTx });
    await updateRegistry(PRESIGNED_FILE, (registry) => { const bundle = registry.bundles[claimed.id]; if (bundle?.status === "broadcasting") { bundle.status = "submitted"; bundle.txHash = hash; bundle.submittedAt = new Date().toISOString(); } });
    console.log(`[presign] submitted ${claimed.label} for ${claimed.id}: ${hash}`);
  } catch (err) {
    await updateRegistry(PRESIGNED_FILE, (registry) => { const bundle = registry.bundles[claimed.id]; if (bundle?.status === "broadcasting") { bundle.status = "pending"; delete bundle.broadcastingAt; delete bundle.broadcastingTier; bundle.error = err.message; } });
    console.error(`[presign] broadcast failed: ${err.message}`);
  }
}

async function checkMarkets(ids = marketIds) {
  if (checking) return;
  checking = true;
  try {
    resetDaily();
    const { snapshots, failures } = await reader.readSnapshots(ids);
    for (const [id, err] of failures) console.warn(`[monitor] ${id}: multicall failed: ${err.message || err}`);
    for (const snapshot of snapshots.values()) {
      const state = stateFor(snapshot.id), liquidity = snapshot.market.liquidity, supplyAssets = snapshot.position.supplyAssets;
      if (state.lastSeenLiquidity === null) { state.lastSeenLiquidity = liquidity; console.log(`[monitor] initialized ${snapshot.id}: ${formatTokenAmount(liquidity, snapshot.loanToken.decimals, snapshot.loanToken.symbol)}`); continue; }
      const multiplier = snapshot.suddenDrainMultiplier ?? SUDDEN_DRAIN_MULTIPLIER;
      const decision = shouldNotify({ liquidity, lastSeenLiquidity: state.lastSeenLiquidity, supplyAssets, hasNotifiedThisCycle: state.hasNotifiedThisCycle, lastNotificationTime: state.lastNotificationTime, notificationsToday, notificationDayStart: dayStart, minLiquidityThreshold: snapshot.minLiquidityWei, suddenDrainMultiplier: multiplier, notificationCooldownMs: NOTIFICATION_COOLDOWN_MS, maxNotificationsPerDay: MAX_NOTIFICATIONS_PER_DAY });
      if (decision.shouldNotify) { try { await sendNotification(snapshot, decision.scenario); state.hasNotifiedThisCycle = true; state.lastNotificationTime = Date.now(); notificationsToday++; } catch (err) { console.error(`[monitor] ntfy failed for ${snapshot.id}: ${err.message}`); continue; } }
      if (state.hasNotifiedThisCycle && (liquidity < snapshot.minLiquidityWei || liquidity > computeDrainThreshold(supplyAssets, multiplier))) state.hasNotifiedThisCycle = false;
      state.lastSeenLiquidity = liquidity;
    }
    await broadcastEligible(snapshots);
  } finally { checking = false; }
}

function startWss() { for (const url of WSS_URLS) { const client = createPublicClient({ transport: webSocket(url) }); for (const eventName of ["Supply", "Withdraw", "Borrow", "Repay", "Liquidate"]) unwatchers.push(client.watchContractEvent({ address: MORPHO_BLUE_ADDRESS, abi: blueAbi, eventName, args: { id: marketIds }, onLogs: (logs) => notifyCheck([...new Set(logs.map((log) => log.args?.id).filter(Boolean))]), onError: (err) => console.warn(`[WSS] ${url}: ${err.message}`) })); } }

async function main() {
  reader = await createMarketReader({ client: publicClient, lenderAddress: LENDER_ADDRESS, morphoBlueAddress: MORPHO_BLUE_ADDRESS, markets });
  console.log(`[monitor] ${markets.length} market(s), ${RPC_URLS.length} HTTP RPC endpoint(s), topic=${topic}`);
  startWss(); await checkMarkets();
  const interval = setInterval(() => checkMarkets(), MONITOR_INTERVAL_MS);
  const stop = () => { clearInterval(interval); clearTimeout(debounceTimer); for (const unwatch of unwatchers) unwatch(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
main().catch((err) => { console.error("Fatal monitor error:", err); process.exit(1); });
