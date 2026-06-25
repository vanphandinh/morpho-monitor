import { fetchMarket, fetchAccrualPosition, fetchToken } from "@morpho-org/blue-sdk-viem";
import { Time } from "@morpho-org/morpho-ts";
import crypto from "node:crypto";
import fs from "node:fs";
import { createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";
import {
  MARKET_ID,
  LENDER_ADDRESS,
  RPC_URLS,
  MONITOR_INTERVAL_MS,
  MIN_LIQUIDITY_THRESHOLD,
  NOTIFICATION_COOLDOWN_MS,
  MAX_NOTIFICATIONS_PER_DAY,
  NTFY_SERVER,
  NTFY_TOPIC,
  WEBAPP_URL,
  PRESIGNED_FILE,
  createClient,
  shouldNotify,
  wadToPercent,
  formatTokenAmount,
  formatApy,
  shortenAddress,
} from "./shared.mjs";

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
 */
async function sendNtfyNotification(
  market,
  loanToken,
  collateralToken,
  position
) {
  const loanSymbol = loanToken.symbol ?? "tokens";
  const collateralSymbol = collateralToken.symbol ?? "tokens";
  const loanDecimals = loanToken.decimals;

  const webappLink = `${WEBAPP_URL}?market=${MARKET_ID}&lender=${LENDER_ADDRESS}`;
  const morphoAppLink = `https://app.morpho.org/ethereum/market?id=${MARKET_ID}`;

  const body = [
    `**Thanh khoản đã xuất hiện trên market!**`,
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
      "Title": `Morpho Blue: Thanh khoan ${loanSymbol} kha dung!`,
      "Tags": "moneybag,chart_with_upwards_trend",
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
 * Load presigned bundle, select best tier ≤ liquidity, broadcast.
 * Returns { broadcasted: boolean, txHash?, tier? }.
 */
async function broadcastPresigned(liquidity, loanToken) {
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

  // 4. Select best tier: largest amount ≤ liquidity
  const sorted = [...bundle.withdrawals]
    .filter(w => w.amountWei && w.signedTx)
    .sort((a, b) => {
      const diff = BigInt(a.amountWei) - BigInt(b.amountWei);
      if (diff > 0n) return 1;
      if (diff < 0n) return -1;
      return 0;
    });

  // Find largest tier where amountWei ≤ liquidity
  let best = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (BigInt(sorted[i].amountWei) <= liquidity) {
      best = sorted[i];
      break;
    }
  }

  if (!best) {
    console.log(
      `[${new Date().toISOString()}] ℹ️  Presigned bundle có nhưng không tier nào ≤ ` +
        `thanh khoản (${formatTokenAmount(liquidity, dec, sym)}). Tier nhỏ nhất: ` +
        `${sorted[0]?.amountFormatted ?? "N/A"}`
    );
    return { broadcasted: false };
  }

  // 5. Broadcast
  console.log(
    `[${new Date().toISOString()}] 🔄 Đang broadcast presigned tier ` +
      `"${best.label}" (${best.amountFormatted})...`
  );

  try {
    // sendRawTransaction needs a wallet client
    const walletClient = createWalletClient({
      chain: mainnet,
      transport: http(RPC_URLS[0]),
    });
    const txHash = await walletClient.sendRawTransaction({
      serializedTransaction: best.signedTx,
    });

    console.log(
      `[${new Date().toISOString()}] ✅ Đã broadcast presigned tx: ${txHash}`
    );

    // 6. Mark as used — rename file
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
// MONITORING LOGIC
// ============================================================

/**
 * Single check cycle. Returns { notified, liquidity } for logging.
 */
async function checkAndNotify() {
  let client;
  try {
    client = await createClient(RPC_URLS);
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] ⚠️  Không thể kết nối RPC: ${err.message}`);
    return { notified: false, liquidity: null };
  }

  let market, position, loanToken, collateralToken;
  try {
    [market, position] = await Promise.all([
      fetchMarket(MARKET_ID, client, { deployless: false }),
      fetchAccrualPosition(LENDER_ADDRESS, MARKET_ID, client, {
        deployless: false,
      }),
    ]);
    [collateralToken, loanToken] = await Promise.all([
      fetchToken(market.params.collateralToken, client, { deployless: false }),
      fetchToken(market.params.loanToken, client, { deployless: false }),
    ]);
  } catch (err) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️  Lỗi fetch dữ liệu: ${err.message}`
    );
    return { notified: false, liquidity: null };
  }

  const liquidity = market.liquidity;
  const supplyAssets = position.supplyAssets;

  // First run: record state passively — NEVER notify on startup.
  // The monitor only alerts on 0-to-positive transitions in subsequent cycles.
  // This prevents notification floods on frequent restarts.
  if (lastSeenLiquidity === null) {
    lastSeenLiquidity = liquidity;
    const sym = loanToken.symbol ?? "tokens";
    const dec = loanToken.decimals;
    console.log(
      `[${new Date().toISOString()}] 🔍 Khởi tạo monitor. ` +
        `Liquidity: ${formatTokenAmount(liquidity, dec, sym)} | ` +
        `Vị thế: ${formatTokenAmount(supplyAssets, dec, sym)} | ` +
        `APY: ${formatApy(market.supplyApy)}`
    );
    if (liquidity === 0n) {
      console.log(
        `[${new Date().toISOString()}] ⏳ Liquidity hiện tại = 0. ` +
          `Sẽ thông báo khi có thanh khoản xuất hiện.`
      );
    } else {
      console.log(
        `[${new Date().toISOString()}] ℹ️  Liquidity hiện có > 0. ` +
          `Sẽ KHÔNG gửi thông báo khởi tạo. ` +
          `Chỉ thông báo khi liquidity trở về 0 rồi dương trở lại.`
      );
    }
    return { notified: false, liquidity };
  }

  // Reset daily counter
  resetDailyIfNeeded();

  // Use pure-function anti-spam logic (from shared.mjs, independently testable)
  const decision = shouldNotify({
    liquidity,
    lastSeenLiquidity,
    hasNotifiedThisCycle,
    lastNotificationTime,
    notificationsToday,
    notificationDayStart,
    minLiquidityThreshold: MIN_LIQUIDITY_THRESHOLD,
    notificationCooldownMs: NOTIFICATION_COOLDOWN_MS,
    maxNotificationsPerDay: MAX_NOTIFICATIONS_PER_DAY,
  });

  let notified = false;

  if (decision.shouldNotify) {
    try {
      await sendNtfyNotification(market, loanToken, collateralToken, position);
      console.log(
        `[${new Date().toISOString()}] 🔔 ĐÃ GỬI THÔNG BÁO! ` +
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

  // Reset cycle flag when liquidity goes back to 0
  if (liquidity === 0n && hasNotifiedThisCycle) {
    console.log(
      `[${new Date().toISOString()}] 🔄 Liquidity về 0, reset trạng thái.`
    );
    hasNotifiedThisCycle = false;
  }

  // Log current state
  const sym = loanToken.symbol ?? "tokens";
  const dec = loanToken.decimals;
  const now = Date.now();
  const cooldownRemaining = Math.max(
    0,
    NOTIFICATION_COOLDOWN_MS - (now - lastNotificationTime)
  );
  const status = (() => {
    if (liquidity === 0n) return "⏳ Chờ thanh khoản...";
    if (hasNotifiedThisCycle) return "🔕 Đã thông báo, đang chờ reset";
    if (decision.reason === "below_threshold")
      return `⚠️  Thanh khoản thấp (${formatTokenAmount(liquidity, dec, sym)} < ngưỡng)`;
    if (decision.reason === "no_transition")
      return "ℹ️  Thanh khoản có sẵn nhưng không phải 0→dương transition";
    if (decision.reason === "cooldown")
      return `⏱️  Cooldown còn ${Math.ceil(cooldownRemaining / 1000)}s`;
    if (decision.reason === "daily_limit")
      return "🛑 Đã đạt giới hạn thông báo hôm nay";
    if (decision.reason === "already_notified_this_cycle")
      return "🔕 Đã thông báo chu kỳ này";
    return "🟢 Sẵn sàng thông báo";
  })();

  console.log(
    `[${new Date().toISOString()}] ${status} | ` +
      `Liquidity: ${formatTokenAmount(liquidity, dec, sym)} | ` +
      `APY: ${formatApy(market.supplyApy)} | ` +
      `Thông báo hôm nay: ${notificationsToday}/${MAX_NOTIFICATIONS_PER_DAY}`
  );

  // Try presigned broadcast (independent of notification logic)
  if (liquidity > 0n) {
    const presignResult = await broadcastPresigned(liquidity, loanToken);
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
  console.log(`  Threshold:  ${(MIN_LIQUIDITY_THRESHOLD / 1_000_000n).toString()} USDC (min liquidity to notify)`);
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
