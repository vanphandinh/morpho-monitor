import { fetchMarket, fetchAccrualPosition, fetchToken, blueAbi } from "@morpho-org/blue-sdk-viem";
import { createPublicClient, webSocket } from "viem";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  MARKET_ID,
  LENDER_ADDRESS,
  MORPHO_BLUE_ADDRESS,
  RPC_URLS,
  WSS_URLS,
  WSS_DEBOUNCE_MS,
  MONITOR_INTERVAL_MS,
  MIN_LIQUIDITY_THRESHOLD,
  SUDDEN_DRAIN_MULTIPLIER,
  NOTIFICATION_COOLDOWN_MS,
  MAX_NOTIFICATIONS_PER_DAY,
  NTFY_SERVER,
  NTFY_TOPIC,
  VOIP_SECRET_KEY,
  VOIP_TARGET,
  WEBAPP_URL,
  PRESIGNED_FILE,
  shouldNotify,
  computeDrainThreshold,
  shouldBroadcastPresigned,
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
import { sendVoipNotification } from "./voip.mjs";

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
let checkInProgress = false;

// ============================================================
// WEBSOCKET STATE (hybrid trigger — không phải critical path)
// ============================================================
let wsState = null;        // { client, unwatchers, url } | null
let debounceTimer = null;  // setTimeout handle cho debounce

// Reset daily counter at midnight
function resetDailyIfNeeded() {
  const now = Date.now();
  if (now - notificationDayStart > 24 * 60 * 60 * 1000) {
    notificationsToday = 0;
    notificationDayStart = now;
  }
}

// ============================================================
// WEBSOCKET EVENT WATCHER (hybrid trigger)
// ============================================================

/**
 * Debounced trigger: gộp nhiều WSS events trong DEBOUNCE_MS window
 * thành 1 lần gọi checkAndNotify(). Tránh gọi fetchMarket() quá nhiều
 * khi market có nhiều events trong cùng 1 block.
 */
function debouncedCheck() {
  if (checkInProgress) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    checkAndNotify().catch((err) => {
      console.error(
        `[${new Date().toISOString()}] ❌ Lỗi checkAndNotify (WSS trigger): ${err.message}`
      );
    });
  }, WSS_DEBOUNCE_MS);
}

/**
 * Thử kết nối và subscribe events tại 1 WSS endpoint.
 * Returns true nếu thành công, false nếu thất bại.
 * Gọi lại chính nó với index+1 khi cần failover (kể cả lỗi async onError).
 */
async function _tryConnectWss(index) {
  if (index >= WSS_URLS.length) {
    console.warn("[WSS] ⚠️  Tất cả endpoints thất bại. Chạy HTTP-only mode.");
    return false;
  }

  const url = WSS_URLS[index];

  try {
    const client = createPublicClient({
      transport: webSocket(url, {
        key: "morpho-wss",
        name: "Morpho Blue WSS",
        reconnect: { delay: 3000, maxRetries: 10 },
        keepAlive: { interval: 30_000 },
        timeout: 10_000,
      }),
    });

    // Test kết nối thực sự — throws nếu WebSocket không kết nối được.
    await client.getChainId();

    // 5 subscription riêng biệt — mỗi event 1 subscription với SINGLE STRING
    // eventName. Cách này encode args CHÍNH XÁC (topics[1] = MARKET_ID)
    // thay vì bị lỗi flatMap như watchEvent với events[] + args.
    // Lọc ở RPC level → không nhận event thừa từ market khác.
    const EVENT_NAMES = ["Supply", "Withdraw", "Borrow", "Repay", "Liquidate"];
    const unwatchers = [];

    for (const eventName of EVENT_NAMES) {
      const unwatch = client.watchContractEvent({
        address: MORPHO_BLUE_ADDRESS,
        abi: blueAbi,
        eventName,               // SINGLE STRING → encodeEventTopics chính xác
        args: { id: MARKET_ID }, // → topics = [[eventSig], MARKET_ID]
        onLogs: () => {
          try {
            debouncedCheck();
          } catch (err) {
            console.error(
              `[${new Date().toISOString()}] ❌ Lỗi trong WSS onLogs (${eventName}): ${err.message}`
            );
          }
        },
        onError: (err) => {
          const msg = err?.message || String(err);
          console.error(
            `[${new Date().toISOString()}] ❌ Lỗi WSS subscription ${eventName} (${url}): ${msg}`
          );
          if (
            msg.includes("ethod not found") ||
            msg.includes("-32601") ||
            msg.includes("eth_subscribe") ||
            msg.includes("not supported")
          ) {
            // Guard 1: wsState đã bị clear → đang failover, bỏ qua
            if (wsState === null) return;
            // Guard 2: wsState thuộc về connection mới (đã failover trước đó)
            // → error này từ connection cũ, bỏ qua để không kill connection mới
            if (wsState.url !== url) return;
            // Unwatch tất cả 5 subscription rồi failover
            for (const fn of unwatchers) {
              try { fn(); } catch { /* ignore */ }
            }
            wsState = null;
            _tryConnectWss(index + 1);
          }
        },
      });
      unwatchers.push(unwatch);
    }

    console.log(`[WSS] ✅ Đã kết nối & đăng ký 5 events: ${url}`);
    wsState = { client, unwatchers, url };
    return true;
  } catch (err) {
    console.warn(`[WSS] ❌ Kết nối thất bại (${url}): ${err.message}`);
    return _tryConnectWss(index + 1);
  }
}

/**
 * Khởi động WebSocket watcher với sequential failover qua các WSS endpoints.
 * Fire-and-forget — không block main loop. HTTP interval vẫn chạy song song.
 */
async function startWsWatcher() {
  if (!WSS_URLS.length) {
    console.log("[WSS] Không có WSS_URLS, chạy HTTP-only mode.");
    return;
  }

  console.log(`[WSS] Đang thử kết nối qua ${WSS_URLS.length} endpoint(s)...`);
  // Fire-and-forget: không await để không block checkAndNotify() đầu tiên
  _tryConnectWss(0);
}

/**
 * Dọn dẹp WebSocket resources khi shutdown.
 */
function stopWsWatcher() {
  if (wsState?.unwatchers) {
    for (const fn of wsState.unwatchers) {
      try { fn(); } catch { /* ignore */ }
    }
    wsState = null;
  }
  clearTimeout(debounceTimer);
  debounceTimer = null;
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
async function broadcastPresigned(liquidity, loanToken, collateralToken, market) {
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
      try {
        fs.writeFileSync(usedPath, JSON.stringify(bundle, null, 2));
        fs.unlinkSync(PRESIGNED_FILE);
      } catch (fileErr) {
        console.warn(
          `[${new Date().toISOString()}] ⚠️  Không thể xóa presigned file: ${fileErr.message}`
        );
        try {
          fs.writeFileSync(PRESIGNED_FILE, JSON.stringify({ ...bundle, status: "expired" }, null, 2));
        } catch (writeErr) {
          console.error(
            `[${new Date().toISOString()}] ❌ Không thể cập nhật presigned file: ${writeErr.message}`
          );
        }
      }

      // Gửi thông báo ntfy
      try {
        const webappLink = `${WEBAPP_URL}?market=${MARKET_ID}&lender=${LENDER_ADDRESS}`;
        const loanSymbol = loanToken?.symbol ?? "tokens";
        const collateralSymbol = collateralToken?.symbol ?? "tokens";
        await fetch(`${NTFY_SERVER}/${RESOLVED_NTFY_TOPIC}`, {
          method: "POST",
          headers: {
            "Title": `Morpho Blue: Pre-signed bundle da het han! ${loanSymbol}`,
            "Tags": "warning",
            "Priority": "4",
            "Markdown": "yes",
            "Click": webappLink,
          },
          body: [
            `**Pre-signed bundle đã bị xóa do nonce đã được sử dụng.**`,
            ``,
            `**Market:** ${collateralSymbol}/${loanSymbol}`,
            `**Nonce bundle:** ${bundle.nonce}`,
            `**Lỗi:** ${err.message}`,
            `**Lý do:** Giao dịch với nonce này đã được broadcast (có thể do bạn đã gửi giao dịch khác).`,
            ``,
            `[Mở Webapp để tạo bundle mới](${webappLink})`,
          ].join("\n"),
        });
        console.log(
          `[${new Date().toISOString()}] 🔔 Đã gửi thông báo bundle hết hạn do nonce`
        );
      } catch (notifyErr) {
        console.error(
          `[${new Date().toISOString()}] ❌ Lỗi gửi ntfy bundle hết hạn: ${notifyErr.message}`
        );
      }

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

  // Guard: bundle must have a valid nonce
  if (bundle.nonce == null) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️  Bundle thiếu nonce, bỏ qua.`
    );
    return;
  }

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
    try {
      fs.writeFileSync(usedPath, JSON.stringify(bundle, null, 2));
      fs.unlinkSync(PRESIGNED_FILE);
    } catch (fileErr) {
      // If unlink fails, update the original file's status so it won't re-trigger
      console.warn(
        `[${new Date().toISOString()}] ⚠️  Không thể xóa presigned file: ${fileErr.message}`
      );
      try {
        fs.writeFileSync(PRESIGNED_FILE, JSON.stringify({ ...bundle, status: "expired" }, null, 2));
      } catch (writeErr) {
        console.error(
          `[${new Date().toISOString()}] ❌ Không thể cập nhật presigned file: ${writeErr.message}`
        );
      }
    }
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
  // Guard: prevent overlapping cycles if previous one takes longer than interval
  if (checkInProgress) {
    console.log(
      `[${new Date().toISOString()}] ⏭️  Chu kỳ trước chưa hoàn thành, bỏ qua chu kỳ này.`
    );
    return { notified: false, liquidity: null };
  }
  checkInProgress = true;
  try {
  // Reset daily counter early — must run even if RPC is down
  // to ensure counters don't stay stale during extended outages.
  resetDailyIfNeeded();

  let market, position, loanToken, collateralToken;
  let dataFetchOk = true;
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
    dataFetchOk = false;
    console.warn(
      `[${new Date().toISOString()}] ⚠️  Lỗi fetch dữ liệu: ${err.message}`
    );
  }

  // Always try to expire stale bundle (independent of data fetch).
  // If data fetch succeeded, full notification is sent.
  // If data fetch failed, run cleanup-only without notification.
  try {
    if (dataFetchOk) {
      await expireStaleBundle(publicClient, market, loanToken, collateralToken);
    } else {
      // Fallback: cleanup without notification (no token info available)
      await expireStaleBundle(publicClient, null, null, null);
    }
  } catch (err) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️  Lỗi expireStaleBundle: ${err.message}`
    );
  }

  if (!dataFetchOk) {
    return { notified: false, liquidity: null };
  }

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

  // Compute drainThreshold once — used by notification, broadcast, and status log
  const drainThreshold = computeDrainThreshold(supplyAssets, SUDDEN_DRAIN_MULTIPLIER);

  if (decision.shouldNotify) {
    // Fire all three operations concurrently — không tác vụ nào phải chờ tác vụ khác.
    // Mỗi promise có .catch() riêng để lỗi của tác vụ này không hủy các tác vụ khác.
    const tasks = [];

    // Task 1: ntfy notification
    tasks.push(
      sendNtfyNotification(market, loanToken, collateralToken, position, decision.scenario)
        .then(() => {
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
        })
        .catch((err) => {
          // ntfy failed — DO NOT update anti-spam state.
          // Burning quota on failures would waste slots (e.g. 3 ntfy.sh outages
          // = 3 slots lost, 0 notifications delivered). Let next cycle retry.
          console.error(
            `[${new Date().toISOString()}] ❌ Lỗi gửi ntfy: ${err.message}. ` +
              `Sẽ thử lại ở chu kỳ sau.`
          );
        })
    );

    // Task 2: VoIP notification (best-effort, độc lập với ntfy)
    tasks.push(
      sendVoipNotification(
        market,
        loanToken,
        collateralToken,
        position,
        decision.scenario
      )
        .then((voipResult) => {
          if (voipResult.sent) {
            console.log(
              `[${new Date().toISOString()}] 📞 ĐÃ GỌI VOIP (${voipResult.status})! ` +
                `Call ID: ${voipResult.callId}`
            );
          } else if (voipResult.attempts > 0) {
            // VoIP được cấu hình nhưng thất bại sau khi retry
            console.error(
              `[${new Date().toISOString()}] ❌ Lỗi gọi VoIP sau ${voipResult.attempts} lần: ` +
                `${voipResult.status || voipResult.error}`
            );
          }
          // voipResult.attempts === 0 → VOIP_SECRET_KEY rỗng, silent skip
        })
        .catch((err) => {
          // VoIP failed — DO NOT update anti-spam state (same pattern as ntfy)
          console.error(
            `[${new Date().toISOString()}] ❌ Lỗi gọi VoIP: ${err.message}. ` +
              `Sẽ thử lại ở chu kỳ sau.`
          );
        })
    );

    // Task 3: Presigned broadcast (chạy song song với ntfy+VoIP để đạt tốc độ tối đa)
    if (shouldBroadcastPresigned(liquidity, drainThreshold)) {
      tasks.push(
        broadcastPresigned(liquidity, loanToken, collateralToken, market)
          .then((presignResult) => {
            if (presignResult.broadcasted) {
              console.log(
                `[${new Date().toISOString()}] 🎯 Presigned broadcast thành công: ` +
                  `${presignResult.amountFormatted} — ${presignResult.txHash}`
              );
            }
          })
          .catch((err) => {
            console.error(
              `[${new Date().toISOString()}] ❌ Lỗi broadcast presigned: ${err.message}.`
            );
          })
      );
    }

    await Promise.all(tasks);
  } else if (shouldBroadcastPresigned(liquidity, drainThreshold)) {
    // Không cần notify, nhưng vẫn thử broadcast (chạy độc lập)
    try {
      const presignResult = await broadcastPresigned(liquidity, loanToken, collateralToken, market);
      if (presignResult.broadcasted) {
        console.log(
          `[${new Date().toISOString()}] 🎯 Presigned broadcast thành công: ` +
            `${presignResult.amountFormatted} — ${presignResult.txHash}`
        );
      }
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] ❌ Lỗi broadcast presigned: ${err.message}.`
      );
    }
  }

  // Reset cycle flag khi liquidity thoát khỏi vùng nguy hiểm
  // Vùng nguy hiểm: [MIN_LIQUIDITY_THRESHOLD, supplyAssets × SUDDEN_DRAIN_MULTIPLIER]
  if (hasNotifiedThisCycle) {
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

  // Only update lastSeenLiquidity when:
  // - Notification sent successfully, OR
  // - No notification was needed (shouldNotify returned false)
  // Skip update when ntfy failed — allows retry on next cycle
  if (notified || !decision.shouldNotify) {
    lastSeenLiquidity = liquidity;
  }
  return { notified, liquidity };
  } finally {
    checkInProgress = false;
  }
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
  console.log(`  VoIP:       ${VOIP_SECRET_KEY ? `BẬT (${VOIP_TARGET})` : "TẮT (không có VOIP_SECRET_KEY)"}`);
  console.log(`  WSS:        ${WSS_URLS.length ? `BẬT (${WSS_URLS.length} endpoint(s), debounce ${WSS_DEBOUNCE_MS}ms)` : "TẮT (không có WSS_URLS)"}`);
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

  // Khởi động WebSocket watcher (không block — chạy song song với HTTP polling)
  // Nếu WSS không được cấu hình hoặc thất bại, HTTP interval vẫn hoạt động bình thường.
  startWsWatcher();

  // Run first check immediately
  await checkAndNotify();

  // Then run on interval
  const interval = setInterval(checkAndNotify, MONITOR_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n[${new Date().toISOString()}] 🛑 Nhận ${signal}, đang dừng...`);
    stopWsWatcher();
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
