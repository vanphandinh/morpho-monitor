/**
 * Pure monitor business rules — tách khỏi shared.mjs (audit P1.4).
 *
 * Trước đây các hàm này nằm chung file với phần đọc `process.env`, nên mỗi rule
 * đều bị buộc vào toàn bộ config của tiến trình dù bản thân chúng không chạm I/O.
 * Ở đây chúng là hàm thuần, không import gì — test được độc lập và không kéo theo
 * env.
 */

/**
 * Compute drainThreshold = supplyAssets × multiplier.
 * Supports fractional multipliers (e.g., 1.5) via BigInt rational arithmetic.
 */
export function computeDrainThreshold(supplyAssets, multiplier) {
  if (supplyAssets == null || supplyAssets === 0n) return 0n;
  // Guard: multiplier must be a positive finite number (or string that converts to one)
  if (typeof multiplier === "string") {
    multiplier = Number(multiplier);
  }
  if (multiplier == null || typeof multiplier !== "number" || !isFinite(multiplier) || multiplier <= 0) {
    return 0n;
  }
  const str = String(multiplier);
  const dot = str.indexOf(".");
  if (dot === -1) {
    return supplyAssets * BigInt(Number(multiplier));
  }
  // Fractional: 1.5 → (supplyAssets × 15) / 10
  const decimals = str.length - dot - 1;
  const numerator = BigInt(str.replace(".", ""));
  const denominator = 10n ** BigInt(decimals);
  return (supplyAssets * numerator) / denominator;
}

/**
 * Pure function: determine whether a presigned bundle should be broadcast.
 * Aligns with shouldNotify danger zone: liquidity in
 * [minLiquidityThreshold, max(drainThreshold, minLiquidityThreshold)].
 */
export function shouldBroadcastPresigned(liquidity, drainThreshold, minLiquidityThreshold = 0n) {
  if (liquidity == null || liquidity === 0n) return false;
  if (drainThreshold == null) return false;
  const min = minLiquidityThreshold ?? 0n;
  let effectiveDrain = drainThreshold;
  if (effectiveDrain < min) effectiveDrain = min;
  return liquidity >= min && liquidity <= effectiveDrain;
}

/**
 * Pure function: determine whether a notification should be sent.
 * All anti-spam rules live here so they can be unit-tested without
 * mocking any I/O.
 *
 * Unified danger-zone logic: triggers when liquidity enters the zone
 * [minLiquidityThreshold, supplyAssets × suddenDrainMultiplier] from outside.
 * Two entry directions:
 *   - "sudden_drain":     từ trên xuống (last > drainThreshold → now ≤ drainThreshold)
 *   - "liquidity_appeared": từ dưới lên (last < threshold → now ≥ threshold)
 *
 * Returns { shouldNotify: boolean, reason: string, scenario: string|null }.
 */
export function shouldNotify({
  liquidity,
  lastSeenLiquidity,
  supplyAssets,
  hasNotifiedThisCycle,
  lastNotificationTime,
  notificationsToday,
  notificationDayStart,
  minLiquidityThreshold,
  suddenDrainMultiplier,
  notificationCooldownMs,
  maxNotificationsPerDay,
}) {
  // Guard: không có vị thế → không cần theo dõi
  if (supplyAssets == null || supplyAssets === 0n) {
    return { shouldNotify: false, reason: "no_position", scenario: null };
  }

  let drainThreshold = computeDrainThreshold(supplyAssets, suddenDrainMultiplier);
  // Guard: prevent empty zone when drainThreshold < minLiquidityThreshold
  if (drainThreshold < minLiquidityThreshold) {
    drainThreshold = minLiquidityThreshold;
  }
  const inZone =
    liquidity >= minLiquidityThreshold && liquidity <= drainThreshold;

  // ================================================================
  // Xác định scenario: liquidity đi vào vùng nguy hiểm từ đâu?
  // ================================================================
  let scenario = null;

  if (inZone && lastSeenLiquidity != null) {
    if (lastSeenLiquidity > drainThreshold) {
      // Từ trên xuống: sudden drain
      scenario = "sudden_drain";
    } else if (lastSeenLiquidity < minLiquidityThreshold) {
      // Từ dưới lên: liquidity mới xuất hiện trong vùng nguy hiểm
      scenario = "liquidity_appeared";
    }
    // else: đã ở trong zone từ trước → không phải transition mới
  }

  // ================================================================
  // Không có scenario nào trigger → trả về reason để hiển thị
  // ================================================================
  if (!scenario) {
    let reason;
    if (liquidity < minLiquidityThreshold) {
      reason = "below_threshold";
    } else if (liquidity > drainThreshold) {
      reason = "above_drain_threshold";
    } else {
      // inZone = true nhưng không có transition (đã ở trong zone từ trước)
      reason = "in_zone_no_transition";
    }
    return { shouldNotify: false, reason, scenario: null };
  }

  // ================================================================
  // Shared anti-spam checks (áp dụng cho cả 2 scenario)
  // ================================================================

  // 3. Cycle check: không gửi trùng trong cùng một chu kỳ
  if (hasNotifiedThisCycle) {
    return { shouldNotify: false, reason: "already_notified_this_cycle", scenario };
  }

  // 4. Cooldown check
  const now = Date.now();
  if (now - lastNotificationTime < notificationCooldownMs) {
    return { shouldNotify: false, reason: "cooldown", scenario };
  }

  // 5. Daily limit check (with day-roll detection)
  const dayElapsed = now - notificationDayStart;
  if (dayElapsed > 24 * 60 * 60 * 1000) {
    // Day has rolled over — counters will be reset by caller,
    // so we treat this as 0 notifications today.
  } else if (notificationsToday >= maxNotificationsPerDay) {
    return { shouldNotify: false, reason: "daily_limit", scenario };
  }

  return { shouldNotify: true, reason: "all_checks_passed", scenario };
}
