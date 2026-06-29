import { fetchMarket, fetchAccrualPosition, fetchToken } from "@morpho-org/blue-sdk-viem";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  MARKET_ID,
  LENDER_ADDRESS,
  RPC_URLS,
  MONITOR_INTERVAL_MS,
  MIN_LIQUIDITY_THRESHOLD,
  SUDDEN_DRAIN_MULTIPLIER,
  NOTIFICATION_COOLDOWN_MS,
  MAX_NOTIFICATIONS_PER_DAY,
  NTFY_SERVER,
  NTFY_TOPIC,
  WEBAPP_URL,
  PRESIGNED_FILE,
  shouldNotify,
  computeDrainThreshold,
  wadToPercent,
  formatTokenAmount,
  formatApy,
  shortenAddress,
} from "./shared.mjs";
import {
  createRobustPublicClient,
  createRobustWalletClient,
  addGlobalErrorHandlers,
} from "./rpc-client.mjs";

// Global error handlers — prevent crashes from unhandled RPC rejections
addGlobalErrorHandlers("monitor");

// Robust RPC clients — created once at startup, reused across all cycles.
// The circuit breaker state (module-level Map in rpc-client.mjs) persists
// across requests, so reusing the same client preserves failure history.
// This also avoids viem re-building its internal transport state every cycle.
const publicClient = createRobustPublicClient(RPC_URLS);
const walletClient = createRobustWalletClient(RPC_URLS);

// ============================================================
// CONFIG (resolved from .env or defaults)
// ============================================================
const RESOLVED_NTFY_TOPIC =
  NTFY_TOPIC || `morpho-monitor-${crypto.randomBytes(4).toString("hex")}`;

// ============================================================
// ANTI-SPAM STATE
// ============================================================
let lastSeenLiquidity = null; // bigint | null - chưa biết lần đầu
let hasNotifiedThisCycle = false;
let lastNotificationTime = 0;
let notificationsToday = 0;
let notificationDayStart = Date.now();

// Reset daily counter at midnight
function resetDailyIfNeeded() {
  const now = Date.now();
  if (now - notificationDayStart > 24 * 60 * 60 * 1000) {
    notificationsToday = 0;
    notificationDayStart = now;
  }
}

// ============================================================
// NTFY NOTIFICATION
// ============================================================

/**
 * Send a push notification via ntfy.sh.
 * @param {string} scenario - "sudden_drain" | "liquidity_appeared"
 */
async function sendNtfyNotification(
  market,
  loanToken,
  collateralToken,
  position,
  scenario
) {
  const loanSymbol = loanToken.symbol ?? "tokens";
  const collateralSymbol = collateralToken.symbol ?? "tokens";
  const loanDecimals = loanToken.decimals;

  const webappLink = `${WEBAPP_URL}?market=${MARKET_ID}&lender=${LENDER_ADDRESS}`;
  const morphoAppLink = `https://app.morpho.org/ethereum/market?id=${MARKET_ID}`;

  const isSuddenDrain = scenario === "sudden_drain";
  const title = isSuddenDrain
    ? `Morpho Blue: Canh bao rut thanh khoan! ${loanSymbol}`
    : `Morpho Blue: Thanh khoan ${loanSymbol} kha dung!`;
  const tags = isSuddenDrain
    ? "warning,chart_with_downwards_trend"
    : "moneybag,chart_with_upwards_trend";
  const intro = isSuddenDrain
    ? "**Canh bao: Thanh khoan giam dot ngot!**"
    : "**Thanh khoản đã xuất hiện trên market!**";

  const body = [
    intro,
    ``,
    `**Market:** ${collateralSymbol}/${loanSymbol}`,
    `**Thanh khoản khả dụng:** ${formatTokenAmount(market.liquidity, loanDecimals, loanSymbol)}`,
    `**Utilization:** ${wadToPercent(market.utilization)}`,
    `**Supply APY:** ${formatApy(market.supplyApy)}`,
    `**Vị thế của bạn:** ${formatTokenAmount(position.supplyAssets, loanDecimals, loanSymbol)}`,
    ``,
    `[Mở Webapp để rút tiền](${webappLink})`,
  ].join("\n");

  const actions = [
    {
      action: "view",
      label: "Mo Webapp Rut Tien",
      url: webappLink,
    },
    {
      action: "view",
      label: "Xem tren Morpho App",
      url: morphoAppLink,
    },
  ];

  const response = await fetch(`${NTFY_SERVER}/${RESOLVED_NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      "Title": title,
      "Tags": tags,
      "Priority": "4",
      "Markdown": "yes",
      "Click": webappLink,
      "Actions": JSON.stringify(actions),
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`ntfy responded with ${response.status}: ${await response.text()}`);
  }

  return response;
}

// ============================================================
// PRE-SIGNED TRANSACTION BROADCAST
// ============================================================

/**
 * Estimate the current asset value of a shares amount using pool exchange rate.
 * Uses the same formula as Morpho: (shares * totalSupplyAssets) / totalSupplyShares
 */
function estimateSharesValue(sharesWei, totalSupplyAssets, totalSupplyShares) {
  if (!totalSupplyShares || totalSupplyShares === 0n) return 0n;
  return (BigInt(sharesWei) * totalSupplyAssets) / totalSupplyShares;
}

/**
 * Load presigned bundle, select best tier ≤ liquidity, broadcast.
 * Prioritizes "withdraw-all-shares" entries over fixed-amount tiers.
 * Returns { broadcasted: boolean, txHash?, tier? }.
 */
async function broadcastPresigned(liquidity, loanToken, market) {
  // 1. Check file exists
  if (!fs.existsSync(PRESIGNED_FILE)) {
    return { broadcasted: false };
  }

  let bundle;
  try {
    const raw = fs.readFileSync(PRESIGNED_FILE, "utf-8");
    bundle = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] ❌ Lỗi đọc presigned file: ${err.message}`
    );
    return { broadcasted: false };
  }

  // 2. Check status
  if (bundle.status !== "pending") {
    return { broadcasted: false };
  }

  // 3. Check nonce still valid (optional: could query chain)
  if (!bundle.withdrawals || bundle.withdrawals.length === 0) {
    console.log(
      `[${new Date().toISOString()}] ⚠️  Presigned bundle rỗng, bỏ qua.`
    );
    return { broadcasted: false };
  }

  // Log discovery on first detection
  const sym = loanToken.symbol ?? "tokens";
  const dec = loanToken.decimals;
  console.log(
    `[${new Date().toISOString()}] 📄 Phát hiện presigned bundle: ` +
      `${bundle.withdrawals.length} tiers, nonce=${bundle.nonce}`
  );

  // 4. First, check for "withdraw-all-shares" entry (prioritize over fixed tiers)
  let best = null;
  const allSharesEntry = bundle.withdrawals.find(
    w => w.type === "all-shares" && w.sharesWei && w.signedTx
  );

  if (allSharesEntry && market?.totalSupplyAssets != null && market?.totalSupplyShares != null) {
    const estimatedAssets = estimateSharesValue(
      allSharesEntry.sharesWei,
      market.totalSupplyAssets,
      market.totalSupplyShares
    );

    console.log(
      `[${new Date().toISOString()}] ℹ️  Phát hiện withdraw-all entry: ` +
        `${allSharesEntry.sharesWei} shares, ước tính ${formatTokenAmount(estimatedAssets, dec, sym)}, ` +
        `thanh khoản: ${formatTokenAmount(liquidity, dec, sym)}`
    );

    if (estimatedAssets > 0n && estimatedAssets <= liquidity) {
      best = allSharesEntry;
      console.log(
        `[${new Date().toISOString()}] 🎯 Chọn withdraw-all (ước tính ${formatTokenAmount(estimatedAssets, dec, sym)} ≤ liquidity)`
      );
    } else {
      console.log(
        `[${new Date().toISOString()}] ℹ️  Withdraw-all cần ~${formatTokenAmount(estimatedAssets, dec, sym)} ` +
          `nhưng thanh khoản chỉ ${formatTokenAmount(liquidity, dec, sym)} — fallback xuống tier`
      );
    }
  }

  // 5. Fall back to tier selection if no all-shares entry chosen
  if (!best) {
    const sorted = [...bundle.withdrawals]
      .filter(w => w.amountWei && w.signedTx && w.type !== "all-shares")
      .sort((a, b) => {
        const diff = BigInt(a.amountWei) - BigInt(b.amountWei);
        if (diff > 0n) return 1;
        if (diff < 0n) return -1;
        return 0;
      });

    // Find largest tier where amountWei ≤ liquidity
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (BigInt(sorted[i].amountWei) <= liquidity) {
        best = sorted[i];
        break;
      }
    }
  }

  if (!best) {
    console.log(
      `[${new Date().toISOString()}] ℹ️  Presigned bundle có nhưng không tier nào ≤ ` +
        `thanh khoản (${formatTokenAmount(liquidity, dec, sym)}).`
    );
    return { broadcasted: false };
  }

  // 6. Broadcast
  console.log(
    `[${new Date().toISOString()}] 🔄 Đang broadcast presigned tier ` +
      `"${best.label}" (${best.amountFormatted})...`
  );

  try {
    const txHash = await walletClient.sendRawTransaction({
      serializedTransaction: best.signedTx,
    });

    console.log(
      `[${new Date().toISOString()}] ✅ Đã broadcast presigned tx: ${txHash}`
    );

    // 7. Mark as used — rename file
    bundle.status = "broadcast";
    bundle.broadcastedAt = new Date().toISOString();
    bundle.broadcastedTier = best.label;
    bundle.txHash = txHash;

    const usedPath = PRESIGNED_FILE.replace(".json", ".used.json");
    fs.writeFileSync(usedPath, JSON.stringify(bundle, null, 2));
    fs.unlinkSync(PRESIGNED_FILE);

    console.log(
      `[${new Date().toISOString()}] 📁 Đã lưu ${usedPath}`
    );

    return {
      broadcasted: true,
      txHash,
      tier: best.label,
      amountFormatted: best.amountFormatted,
    };
  } catch (err) {
    // If nonce already consumed (e.g., user made another tx), mark as used
    if (err.message?.includes("nonce") || err.message?.includes("already known")) {
      console.warn(
        `[${new Date().toISOString()}] ⚠️  Presigned tx nonce đã được dùng, ` +
          `đánh dấu bundle là expired.`
      );
      bundle.status = "expired";
      bundle.error = err.message;
      const usedPath = PRESIGNED_FILE.replace(".json", ".used.json");
      fs.writeFileSync(usedPath, JSON.stringify(bundle, null, 2));
      fs.unlinkSync(PRESIGNED_FILE);
      return { broadcasted: false, error: err.message };
    }

    console.error(
      `[${new Date().toISOString()}] ❌ Lỗi broadcast presigned tx: ${err.message}`
    );
    return { broadcasted: false, error: err.message };
  }
}

// ============================================================
// STALE BUNDLE CHECK (proactive nonce validation)
// ============================================================

/**
 * Check if the pre-signed bundle's nonce is still valid.
 * If the lender's on-chain nonce has increased beyond the bundle nonce,
 * the bundle is stale and should be cleared.
 */
async function expireStaleBundle(client, market, loanToken, collateralToken) {
  if (!fs.existsSync(PRESIGNED_FILE)) return;

  let bundle;
  try {
    const raw = fs.readFileSync(PRESIGNED_FILE, "utf-8");
    bundle = JSON.parse(raw);
  } catch {
    return;
  }

  if (bundle.status !== "pending") return;

  // Fetch current nonce for lender from chain
  const currentNonce = await client.getTransactionCount({
    address: LENDER_ADDRESS,
    blockTag: "pending",
  });

  if (currentNonce > bundle.nonce) {
    console.log(
      `[${new Date().toISOString()}] 🧹 Nonce lender đã tăng ` +
        `(${bundle.nonce} → ${currentNonce}), ` +
        `pre-signed bundle đã hết hạn. Đang dọn dẹp...`
    );
    bundle.status = "expired";
    bundle.error = `Nonce tăng: bundle=${bundle.nonce}, chain=${currentNonce}`;
    bundle.expiredAt = new Date().toISOString();
    const usedPath = PRESIGNED_FILE.replace(".json", ".used.json");
    fs.writeFileSync(usedPath, JSON.stringify(bundle, null, 2));
    fs.unlinkSync(PRESIGNED_FILE);
    console.log(
      `[${new Date().toISOString()}] 📁 Đã lưu bundle expired → ${usedPath}`
    );

    // Gửi thông báo qua ntfy
    if (market && loanToken && collateralToken) {
      try {
        const loanSymbol = loanToken.symbol ?? "tokens";
        const collateralSymbol = collateralToken.symbol ?? "tokens";
        const webappLink = `${WEBAPP_URL}?market=${MARKET_ID}&lender=${LENDER_ADDRESS}`;

        const title = `Morpho Blue: Pre-signed bundle da het han! ${loanSymbol}`;
        const body = [
          `**Pre-signed bundle đã bị xóa do nonce tăng.**`,
          ``,
          `**Market:** ${collateralSymbol}/${loanSymbol}`,
          `**Nonce bundle:** ${bundle.nonce}`,
          `**Nonce on-chain:** ${currentNonce}`,
          `**Lý do:** Ví lender đã gửi một giao dịch khác với nonce cao hơn, ` +
            `khiến pre-signed bundle không còn hợp lệ.`,
          ``,
          `[Mở Webapp để tạo bundle mới](${webappLink})`,
        ].join("\n");

        await fetch(`${NTFY_SERVER}/${RESOLVED_NTFY_TOPIC}`, {
          method: "POST",
          headers: {
            "Title": title,
            "Tags": "warning",
            "Priority": "4",
            "Markdown": "yes",
            "Click": webappLink,
          },
          body,
        });

        console.log(
          `[${new Date().toISOString()}] 🔔 Đã gửi thông báo bundle hết hạn`
        );
      } catch (err) {
        console.error(
          `[${new Date().toISOString()}] ❌ Lỗi gửi ntfy bundle hết hạn: ${err.message}`
        );
      }
    }
  }
}

// ============================================================
// MONITORING LOGIC
// ============================================================

/**
 * Single check cycle. Returns { notified, liquidity } for logging.
 */
async function checkAndNotify() {
  // Reset daily counter early — must run even if RPC is down
  // to ensure counters don't stay stale during extended outages.
  resetDailyIfNeeded();

  let market, position, loanToken, collateralToken;
  try {
    [market, position] = await Promise.all([
      fetchMarket(MARKET_ID, publicClient, { deployless: false }),
      fetchAccrualPosition(LENDER_ADDRESS, MARKET_ID, publicClient, {
        deployless: false,
      }),
    ]);
    [collateralToken, loanToken] = await Promise.all([
      fetchToken(market.params.collateralToken, publicClient, { deployless: false }),
      fetchToken(market.params.loanToken, publicClient, { deployless: false }),
    ]);
  } catch (err) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️  Lỗi fetch dữ liệu: ${err.message}`
    );
    return { notified: false, liquidity: null };
  }

  // Check for stale presigned bundle (nonce mismatch with chain)
  await expireStaleBundle(publicClient, market, loanToken, collateralToken);

  const liquidity = market.liquidity;
  const supplyAssets = position.supplyAssets;

  // First run: record state passively — NEVER notify on startup.
  // The monitor only alerts on below-threshold to above-threshold transitions.
  // This prevents notification floods on frequent restarts.
  if (lastSeenLiquidity === null) {
    lastSeenLiquidity = liquidity;
    const sym = loanToken.symbol ?? "tokens";
    const dec = loanToken.decimals;
    const drainThreshold = computeDrainThreshold(supplyAssets, SUDDEN_DRAIN_MULTIPLIER);
    console.log(
      `[${new Date().toISOString()}] 🔍 Khởi tạo monitor. ` +
        `Liquidity: ${formatTokenAmount(liquidity, dec, sym)} | ` +
        `Vị thế: ${formatTokenAmount(supplyAssets, dec, sym)} | ` +
        `Ngưỡng drain: ${formatTokenAmount(drainThreshold, dec, sym)} | ` +
        `APY: ${formatApy(market.supplyApy)}`
    );
    console.log(
      `[${new Date().toISOString()}] ℹ️  Vùng nguy hiểm: [${formatTokenAmount(MIN_LIQUIDITY_THRESHOLD, dec, sym)} — ${formatTokenAmount(drainThreshold, dec, sym)}]. ` +
        `Sẽ thông báo khi liquidity đi vào vùng này từ bên ngoài.`
    );
    return { notified: false, liquidity };
  }

  // Use pure-function anti-spam logic (from shared.mjs, independently testable)
  const decision = shouldNotify({
    liquidity,
    lastSeenLiquidity,
    supplyAssets,
    hasNotifiedThisCycle,
    lastNotificationTime,
    notificationsToday,
    notificationDayStart,
    minLiquidityThreshold: MIN_LIQUIDITY_THRESHOLD,
    suddenDrainMultiplier: SUDDEN_DRAIN_MULTIPLIER,
    notificationCooldownMs: NOTIFICATION_COOLDOWN_MS,
    maxNotificationsPerDay: MAX_NOTIFICATIONS_PER_DAY,
  });

  let notified = false;

  if (decision.shouldNotify) {
    try {
      await sendNtfyNotification(market, loanToken, collateralToken, position, decision.scenario);
      const scenarioLabel = decision.scenario === "sudden_drain"
        ? "RÚT THANH KHOẢN ĐỘT NGỘT"
        : "THANH KHOẢN XUẤT HIỆN";
      console.log(
        `[${new Date().toISOString()}] 🔔 ĐÃ GỬI THÔNG BÁO (${scenarioLabel})! ` +
          `Liquidity: ${formatTokenAmount(liquidity, loanToken.decimals, loanToken.symbol)}`
      );
      hasNotifiedThisCycle = true;
      lastNotificationTime = Date.now();
      notificationsToday++;
      notified = true;
    } catch (err) {
      // ntfy failed — DO NOT update anti-spam state.
      // Burning quota on failures would waste slots (e.g. 3 ntfy.sh outages
      // = 3 slots lost, 0 notifications delivered). Let next cycle retry.
      console.error(
        `[${new Date().toISOString()}] ❌ Lỗi gửi ntfy: ${err.message}. ` +
          `Sẽ thử lại ở chu kỳ sau.`
      );
    }
  }

  // Reset cycle flag khi liquidity thoát khỏi vùng nguy hiểm
  // Vùng nguy hiểm: [MIN_LIQUIDITY_THRESHOLD, supplyAssets × SUDDEN_DRAIN_MULTIPLIER]
  if (hasNotifiedThisCycle) {
    const drainThreshold = computeDrainThreshold(supplyAssets, SUDDEN_DRAIN_MULTIPLIER);
    if (liquidity < MIN_LIQUIDITY_THRESHOLD || liquidity > drainThreshold) {
      console.log(
        `[${new Date().toISOString()}] 🔄 Liquidity đã thoát vùng nguy hiểm, reset trạng thái.`
      );
      hasNotifiedThisCycle = false;
    }
  }

  // Log current state
  const sym = loanToken.symbol ?? "tokens";
  const dec = loanToken.decimals;
  const now = Date.now();
  const cooldownRemaining = Math.max(
    0,
    NOTIFICATION_COOLDOWN_MS - (now - lastNotificationTime)
  );
  const drainThreshold = computeDrainThreshold(supplyAssets, SUDDEN_DRAIN_MULTIPLIER);
  const status = (() => {
    if (liquidity === 0n) return "⏳ Chờ thanh khoản...";
    if (hasNotifiedThisCycle) return "🔕 Đã thông báo, đang chờ reset";
    if (decision.reason === "no_position") return "💤 Không có vị thế (supply = 0)";
    if (decision.reason === "below_threshold")
      return `⚠️  Thanh khoản thấp (${formatTokenAmount(liquidity, dec, sym)} < ngưỡng ${formatTokenAmount(MIN_LIQUIDITY_THRESHOLD, dec, sym)})`;
    if (decision.reason === "above_drain_threshold")
      return `✅  Thanh khoản thoải mái (> ${SUDDEN_DRAIN_MULTIPLIER}× vị thế = ${formatTokenAmount(drainThreshold, dec, sym)})`;
    if (decision.reason === "in_zone_no_transition")
      return `ℹ️  Đang trong vùng nguy hiểm [${formatTokenAmount(MIN_LIQUIDITY_THRESHOLD, dec, sym)} — ${formatTokenAmount(drainThreshold, dec, sym)}] nhưng không phải transition mới`;
    if (decision.reason === "cooldown")
      return `⏱️  Cooldown còn ${Math.ceil(cooldownRemaining / 1000)}s`;
    if (decision.reason === "daily_limit")
      return "🛑 Đã đạt giới hạn thông báo hôm nay";
    return "🟢 Sẵn sàng thông báo";
  })();

  console.log(
    `[${new Date().toISOString()}] ${status} | ` +
      `Liquidity: ${formatTokenAmount(liquidity, dec, sym)} | ` +
      `Vị thế: ${formatTokenAmount(supplyAssets, dec, sym)} | ` +
      `Ngưỡng drain: ${formatTokenAmount(drainThreshold, dec, sym)} | ` +
      `APY: ${formatApy(market.supplyApy)} | ` +
      `Thông báo hôm nay: ${notificationsToday}/${MAX_NOTIFICATIONS_PER_DAY}`
  );

  // Try presigned broadcast (independent of notification logic)
  if (liquidity > 0n) {
    const presignResult = await broadcastPresigned(liquidity, loanToken, market);
    if (presignResult.broadcasted) {
      console.log(
        `[${new Date().toISOString()}] 🎯 Presigned broadcast thành công: ` +
          `${presignResult.amountFormatted} — ${presignResult.txHash}`
      );
    }
  }

  lastSeenLiquidity = liquidity;
  return { notified, liquidity };
}

// ============================================================
// MAIN LOOP
// ============================================================

function printBanner() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Morpho Blue - Liquidity Monitor                      ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  Market:     ${shortenAddress(MARKET_ID)}`);
  console.log(`  Lender:     ${LENDER_ADDRESS}`);
  console.log(`  Interval:   ${MONITOR_INTERVAL_MS / 1000}s`);
  console.log(`  Threshold:  ${(MIN_LIQUIDITY_THRESHOLD / 1_000_000n).toString()} USDC (ngưỡng tối thiểu)`);
  console.log(`  Drain:      ${SUDDEN_DRAIN_MULTIPLIER}× vị thế (ngưỡng giảm đột ngột)`);
  console.log(`  Cooldown:   ${NOTIFICATION_COOLDOWN_MS / 60000} phút giữa các thông báo`);
  console.log(`  Max/ngày:   ${MAX_NOTIFICATIONS_PER_DAY} thông báo`);
  console.log(`  Webapp:     ${WEBAPP_URL}`);
  console.log(`  ntfy topic: ${RESOLVED_NTFY_TOPIC}`);
  console.log("");
  console.log("  📱 Subscribe ntfy app to topic:");
  console.log(`     ${NTFY_SERVER}/${RESOLVED_NTFY_TOPIC}`);
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Nhấn Ctrl+C để dừng");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

async function main() {
  printBanner();

  // Run first check immediately
  await checkAndNotify();

  // Then run on interval
  const interval = setInterval(checkAndNotify, MONITOR_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n[${new Date().toISOString()}] 🛑 Nhận ${signal}, đang dừng...`);
    clearInterval(interval);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
