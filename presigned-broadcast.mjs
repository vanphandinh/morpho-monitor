import { keccak256 } from "viem";
import { parseBundleKey, marketBundles, consumedWatermark, readRegistry, TERMINAL_STATUSES } from "./presigned-store.mjs";
import { isConfigVerifyError } from "./presign-verify.mjs";

/**
 * Presigned transaction lifecycle.
 *
 * Invariants (audit 2026-09-23):
 * 1. Claim ("broadcasting") must be durable BEFORE any RPC I/O, and is never
 *    cleared by a timeout, an ambiguous RPC error, or a pending-nonce advance.
 * 2. Recovery rebroadcasts the EXACT persisted raw transaction only after
 *    keccak256(rawTx) === persisted txHash. A bundle without persisted raw
 *    identity stays reserved and reports manual reconciliation (fail closed).
 * 3. Only a mined receipt for that exact hash permits terminal state
 *    (submitted/failed) and the subsequent expiry of same-nonce siblings.
 * 4. Nonce < current is stale ONLY for status "pending"; the single active
 *    claim ("broadcasting") is receipt-grounded, never nonce-grounded.
 * 5. Terminal statuses (submitted/failed) are INERT history: they never
 *    reserve, never conflict, never reconcile and never warn. Their nonce is
 *    still consumed forever, so every pending bundle at or below the highest
 *    terminal nonce is expired instead of broadcast (audit C2/M1).
 */
export const RECEIPT_TIMEOUT_MS = 120_000;
export const RECOVERY_THRESHOLD_MS = 180_000;

/**
 * Ân hạn mặc định trước khi dọn record `expired` (chẩn đoán 2026-09-26).
 *
 * Record `expired` là lịch sử TRƠ (nonce đã tiêu thụ, chữ ký không thể mine) nhưng trước fix không
 * đường nào xoá chúng: phase-0 idle short-circuit ngay khi registry không còn `pending`/
 * `broadcasting`, nên chúng tích tụ vĩnh viễn (artifact thật: `…@2550` expired + rỗng nằm nguyên
 * hơn một ngày). Mặc định 1 giờ để người dùng còn kịp nhìn thấy chuyện gì đã xảy ra; env
 * `PRESIGN_EXPIRED_RETENTION_MINUTES` ghi đè (0 = xoá ngay chu kỳ kế tiếp).
 */
export const DEFAULT_EXPIRED_RETENTION_MS = 60 * 60 * 1000;

/**
 * Số block phải lùi trước khi đọc nonce làm bằng chứng nhả claim (audit vòng 2).
 * 2 block ≈ 24s — không đáng kể so với RECOVERY_THRESHOLD_MS, nhưng loại được ca
 * kết luận bị lật bởi reorg ở đỉnh chuỗi.
 */
export const EVIDENCE_CONFIRMATIONS = 2;

export function selectBestWithdrawal(withdrawals, snapshot) {
  const liquidity = snapshot.market.liquidity;
  const estimatedAssets = (w) =>
    (BigInt(w.sharesWei || 0) * snapshot.market.totalSupplyAssets) /
    snapshot.market.totalSupplyShares;
  const allShares = withdrawals.find((w) =>
    w.type === "all-shares" &&
    snapshot.market.totalSupplyShares > 0n &&
    estimatedAssets(w) > 0n &&
    estimatedAssets(w) <= liquidity);
  if (allShares) return allShares;
  return withdrawals.filter((w) => w.type !== "all-shares" && BigInt(w.amountWei || 0) > 0n && BigInt(w.amountWei) <= liquidity)
    .sort((a, b) => BigInt(b.amountWei) > BigInt(a.amountWei) ? 1 : -1)[0] ?? null;
}

/**
 * Terminal states are receipt-grounded history: they hold no claim.
 *
 * `superseded` (audit R1) is terminal too: the nonce was consumed by a DIFFERENT
 * transaction, so these bytes can never mine and their nonce stays consumed
 * forever. Like the others it is inert history the user may delete —
 * `TERMINAL_STATUSES` sống ở presigned-store.mjs cùng với watermark
 * `consumedNonce`, nên xoá record không làm mất ký ức "nonce đã tiêu thụ" (A.2).
 */
export const SUPERSEDED_STATUS = "superseded";
export const SUPERSEDED_REASON = "nonce consumed by another transaction — this presigned tx can never mine";

/**
 * Registry còn "việc" đáng trả phí RPC không (round-4 quota audit, 2026-09-25)?
 *
 * Chỉ hai trạng thái đòi hỏi I/O mạng: `pending` (có thể được claim ở nonce
 * hiện tại) và `broadcasting` (claim durable cần reconcile). Mọi trạng thái
 * khác (terminal/expired/invalid/history) là inert — pipeline chạy đủ cũng
 * chẳng làm gì ngoài đọc nonce và kết luận "không có gì để làm".
 *
 * Pending với nonce hỏng (không parse được số) vẫn tính là CÓ VIỆC: fail
 * closed — trạng thái lạ không được phép kích hoạt chế độ bỏ qua.
 */
export function registryHasWork(registry) {
  for (const bundle of Object.values(registry?.bundles ?? {})) {
    const status = bundle?.status;
    if (status === "broadcasting" || status === "pending") return true;
  }
  return false;
}

/**
 * True when the bundle holds the nonce-wide active claim. ONLY an unmined
 * "broadcasting" record reserves: a terminal record has its rawTx deleted in
 * phase 2, so treating it as a reservation wedged the registry forever
 * (reconcile reported "lacks rawTx/txHash identity" and no new bundle could
 * ever be claimed — audit C2).
 */
function isActiveClaim(bundle) {
  return bundle.status === "broadcasting";
}

/** Oldest durable claim first; a missing/invalid broadcastingAt counts as oldest. */
function compareClaimAge([idA, a], [idB, b]) {
  const ta = Date.parse(a.broadcastingAt ?? "");
  const tb = Date.parse(b.broadcastingAt ?? "");
  const va = Number.isFinite(ta) ? ta : 0;
  const vb = Number.isFinite(tb) ? tb : 0;
  if (va !== vb) return va - vb;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

/** A receipt is mined proof only when it carries block identity. */
function isMinedReceipt(receipt) {
  return Boolean(receipt && receipt.blockHash && receipt.blockNumber != null && receipt.transactionHash);
}

/**
 * Expire same-nonce siblings of a consumed nonce. The argument is the CLAIM's
 * nonce, never the current pending nonce (audit F4): once the slot is gone every
 * other bundle signed for it is dead. Terminal records are already history, and a
 * missing/invalid nonce expires nobody (fail closed).
 */
function expireSameNonceSiblings(registry, claimId, claimNonce, now = () => Date.now()) {
  if (!Number.isFinite(claimNonce)) return;
  for (const [id, other] of Object.entries(registry.bundles)) {
    if (id === claimId) continue;
    if (Number(other.nonce) !== claimNonce) continue;
    if (TERMINAL_STATUSES.has(other.status)) continue;
    other.status = "expired";
    // Mốc để purge đo ân hạn (chẩn đoán 2026-09-26); record cũ thiếu field thì purge lùi về
    // updatedAt/createdAt.
    other.expiredAt = new Date(now()).toISOString();
  }
}

/**
 * Evidence that a durable claim can NEVER mine: the account's MINED nonce has
 * moved past the claim's nonce while no receipt exists for the claim's own hash.
 *
 * Mining cannot skip a nonce (a tx is only valid when tx.nonce === account.nonce),
 * so every nonce below that count is mined — and with our receipt missing, the
 * slot belongs to another transaction. `pending` is deliberately NOT used: it
 * counts the claim's own broadcast, which is exactly what made F4 ambiguous.
 *
 * Audit vòng 2 (lệch node): nonce được đọc ở block đã lùi `confirmations`
 * (`getBlockNumber` → `getTransactionCount({ blockNumber })`), và cả ba lần đọc
 * phải rơi vào CÙNG một node (transport sticky ở monitor). Nếu `getTransactionCount(latest)`
 * rơi vào node khác với lần đọc receipt, hai góc nhìn có thể lệch nhau: node chậm
 * chưa có block chứa tx của claim, node nhanh đã thấy nonce nhảy — và kết luận
 * "nonce bị tx KHÁC tiêu thụ" sẽ SAI khi tx của claim chính là cái làm nonce nhảy
 * (đo thực tế: cặp slot liền kề trong vòng xoay lệch head nhau 2.5% số mẫu).
 * Neo ở `head - confirmations` cũng loại ca kết luận bị lật bởi reorg đỉnh chuỗi.
 *
 * Any doubt (non-finite nonce/head, lookup error) ⇒ KHÔNG có bằng chứng — fail closed.
 *
 * @returns {Promise<{ consumed: boolean, anchorBlock: number|null }>}
 */
async function nonceConsumedByAnotherTx(client, lenderAddress, claimNonce, confirmations = EVIDENCE_CONFIRMATIONS) {
  if (!Number.isFinite(claimNonce)) return { consumed: false, anchorBlock: null };
  try {
    const head = Number(await client.getBlockNumber());
    if (!Number.isFinite(head)) return { consumed: false, anchorBlock: null };
    // Neo ở block đã lùi `confirmations` block: một tx tiêu thụ nonce ở độ sâu đó
    // thì reorg không lật lại được kết luận. Cửa sổ lùi cũng không tốn gì so với
    // RECOVERY_THRESHOLD_MS (180s).
    const anchorBlock = head - confirmations;
    if (anchorBlock < 0) return { consumed: false, anchorBlock: null };
    const mined = await client.getTransactionCount({ address: lenderAddress, blockNumber: BigInt(anchorBlock) });
    return { consumed: Number(mined) > claimNonce, anchorBlock };
  } catch {
    return { consumed: false, anchorBlock: null };
  }
}

/**
 * Reconcile a pre-existing "broadcasting" reservation, receipt-first.
 * Returns a claim descriptor; never mutates the registry here.
 */
function reconcileBroadcasting(id, bundle) {
  const txHash = bundle.txHash;
  const rawTx = bundle.rawTx;
  if (!txHash || !rawTx) {
    // Legacy record without immutable identity: fail closed, keep the claim.
    return { id, existing: true, stuck: true, bundle, diagnostic: `broadcasting bundle ${id} (nonce ${bundle.nonce}) lacks rawTx/txHash identity; manual reconciliation required — verify the on-chain nonce before editing the registry` };
  }
  if (keccak256(rawTx) !== txHash) {
    // Persisted identity is inconsistent: never rebroadcast anything.
    return { id, existing: true, stuck: true, bundle, diagnostic: `broadcasting bundle ${id} (nonce ${bundle.nonce}) rawTx does not match persisted txHash; manual reconciliation required` };
  }
  return { id, existing: true, bundle, rawTx, stuck: false };
}

/**
 * Release a durable claim whose nonce was taken by another transaction (audit R1).
 *
 * The exact bytes are never sent again — the slot is gone. The record becomes
 * inert history (`superseded`) carrying the evidence as `reason`, keeps its
 * withdrawals as an audit trail, drops the raw bytes and expires same-nonce
 * siblings exactly like a mined receipt would. It is not an active claim, so the
 * ladder may claim the next rung on the next cycle and the webapp may delete it.
 */
async function releaseSuperseded({ filePath, claim, claimNonce, txHash, updateRegistry, now, logger, lenderAddress, anchorBlock }) {
  // Số block neo nằm trong bằng chứng để người vận hành kiểm tay được đúng block
  // đã tiêu thụ nonce (audit vòng 2).
  const anchor = Number.isFinite(anchorBlock) ? ` (mined nonce read at block ${anchorBlock})` : "";
  const evidence = `receipt for ${txHash.slice(0, 10)}… not found while the mined nonce advanced past ${claimNonce} for ${String(lenderAddress).slice(0, 10)}…${anchor}`;
  await updateRegistry(filePath, (registry) => {
    const bundle = registry.bundles[claim.id];
    if (!bundle || bundle.status !== "broadcasting" || bundle.txHash !== txHash) return;
    // v3: stamp marketId from the composite key if missing (migrated bundles carry it).
    if (bundle.marketId == null) {
      const { marketId } = parseBundleKey(claim.id);
      if (marketId) bundle.marketId = marketId;
    }
    bundle.status = SUPERSEDED_STATUS;
    bundle.reason = SUPERSEDED_REASON;
    bundle.terminalAt = new Date(now()).toISOString();
    delete bundle.rawTx; // never rebroadcast these bytes again
    expireSameNonceSiblings(registry, claim.id, claimNonce, now);
  });
  logger?.warn?.(`[presign] claim ${claim.id} released as ${SUPERSEDED_STATUS} (nonce ${claimNonce}): ${evidence} — the next rung may now be claimed; verify on-chain before deleting`);
  return { ...claim, superseded: true, diagnostic: evidence };
}

/**
 * Dọn record `expired` đã quá ân hạn (chẩn đoán 2026-09-26).
 *
 * Vì sao cần: `expired` là lịch sử trơ — chữ ký ở nonce đó vĩnh viễn không mine được (`expired`
 * chỉ được set khi on-chain pending nonce đã đi qua, hoặc nonce ≤ watermark). Nhưng trước fix không
 * có đường nào xoá chúng: phase-0 idle short-circuit ngay khi registry không còn
 * `pending`/`broadcasting`, nên record chết tích tụ mãi.
 *
 * An toàn: xoá record KHÔNG làm mất ký ức "nonce đã tiêu thụ" — hàm NÂNG `registry.consumedNonce`
 * lên chính nonce bị xoá (audit A.2), nên một `pending` cùng nonce về sau vẫn bị expire thay vì
 * được claim. Chỉ chạm `status === "expired"`; record thiếu mốc thời gian bị GIỮ LẠI (fail closed),
 * nonce không hữu hạn cũng vậy.
 *
 * Không tốn RPC: chỉ đọc file, và chỉ lấy lock/ghi khi thật sự có record cần xoá.
 *
 * @param {object} deps
 * @param {string} deps.filePath registry path
 * @param {Function} deps.updateRegistry hàm ghi registry có lock (`presigned-store.mjs`) — DI như
 *   phần còn lại của module để test/monitor truyền cùng một bản
 * @returns {Promise<{ purged: number, keys: string[] }>}
 */
export async function purgeExpiredRungs({ filePath, updateRegistry, now = () => Date.now(), retentionMs = DEFAULT_EXPIRED_RETENTION_MS, logger = console } = {}) {
  let registry;
  try {
    registry = readRegistry(filePath);
  } catch {
    return { purged: 0, keys: [] }; // không đọc được ⇒ không xoá gì (fail closed)
  }
  const t = now();
  const victims = [];
  for (const [key, bundle] of Object.entries(registry.bundles ?? {})) {
    if (bundle?.status !== "expired") continue;
    const nonce = Number(bundle.nonce);
    if (!Number.isFinite(nonce)) continue; // nonce lạ ⇒ để người vận hành đối soát tay
    const age = t - Date.parse(bundle.expiredAt ?? bundle.updatedAt ?? bundle.createdAt ?? "");
    if (!Number.isFinite(age) || age < retentionMs) continue;
    victims.push({ key, nonce });
  }
  if (victims.length === 0) return { purged: 0, keys: [] };

  let keys;
  try {
    keys = await updateRegistry(filePath, (reg) => {
      const purged = [];
      for (const { key, nonce } of victims) {
        const bundle = reg.bundles[key];
        // Trạng thái đổi giữa hai lần đọc (chu kỳ/tiến trình khác vừa claim hoặc xoá) ⇒ bỏ qua,
        // không xoá mù.
        if (!bundle || bundle.status !== "expired") continue;
        delete reg.bundles[key];
        // Nâng mốc TRƯỚC khi record biến mất khỏi file — nếu không, nonce này "sống lại".
        reg.consumedNonce = Math.max(Number(reg.consumedNonce) || -1, nonce, consumedWatermark(reg));
        purged.push(key);
      }
      return purged;
    });
  } catch (err) {
    // Purge là dọn dẹp BEST-EFFORT: lock bị process khác giữ (LOCK_STALE), registry hỏng giữa hai
    // lần đọc… chỉ được TRÌ HOÃN việc dọn sang chu kỳ sau. Trước fix lỗi từ đây xuyên thẳng ra
    // `broadcastEligible` (purge chạy trước cả nhánh idle) ⇒ một lượt dọn không lấy được lock giết
    // cả chu kỳ 30s, kể cả khi registry idle — thứ trước đây không bao giờ ném (audit D15–D20).
    logger?.warn?.(`[presign] purge expired rungs bỏ qua lượt này: ${err?.message || err}`);
    return { purged: 0, keys: [] };
  }
  if (keys.length > 0) {
    logger?.log?.(
      `[presign] purged ${keys.length} expired rung(s) quá ân hạn ${Math.round(retentionMs / 60_000)} phút: ${keys.join(", ")}`
    );
  }
  return { purged: keys.length, keys };
}

export async function broadcastEligible({ client, lenderAddress, filePath, snapshots, updateRegistry, verifyBundle, isEligible, now = () => Date.now(), logger = console, expiredRetentionMs = DEFAULT_EXPIRED_RETENTION_MS }) {
  // Dọn record `expired` TRƯỚC nhánh idle (chẩn đoán 2026-09-26): registry chỉ còn record expired
  // bị coi là idle nên trước fix không chu kỳ nào chạm tới chúng. Purge không RPC.
  const purge = await purgeExpiredRungs({ filePath, updateRegistry, now, retentionMs: expiredRetentionMs, logger });

  // ---- Phase 0: pure idle check — no RPC, no lock (round-4 quota audit) ----
  // broadcastEligible chạy MỖI chu kỳ monitor (30s). Registry trống hoặc chỉ
  // còn history thì toàn bộ pipeline chỉ để đọc 1 nonce rồi kết luận không có
  // gì để làm — ~2.880 request/ngày phí phạm ở trạng thái idle. Short-circuit
  // CHỈ kích hoạt trên trạng thái đọc được và chứng minh được là idle; file
  // hỏng/không đọc được ⇒ chạy pipeline đủ như cũ (fail closed). Race với một
  // bundle vừa ký (webapp) không mất an toàn: phase 1 vẫn là thẩm quyền duy
  // nhất, bundle mới chỉ được claim ở chu kỳ kế tiếp như trước đây.
  let idle = false;
  try {
    idle = !registryHasWork(readRegistry(filePath));
  } catch {
    idle = false; // không đọc được registry ⇒ không được coi là idle
  }
  if (idle) {
    return {
      idle: true,
      purged: purge.purged,
      diagnostic: `registry idle — no pending bundle and no broadcasting claim; nonce read skipped${purge.purged ? ` (purged ${purge.purged} expired rung(s))` : ""}`,
    };
  }

  const nonce = await client.getTransactionCount({ address: lenderAddress, blockTag: "pending" });

  // Audit vòng 2 (D2): vấn đề verify phát hiện trong chu kỳ này (lệch .env hoặc
  // bundle hỏng). Trước đây chúng chỉ được ghi vào registry dưới dạng `invalid`
  // nên monitor im lặng; nay gắn vào kết quả để `alertOnLifecycle` báo được.
  const problems = [];

  // ---- Phase 1: durable claim under the registry lock (no network I/O) ----
  const claim = await updateRegistry(filePath, async (registry) => {
    const entries = Object.entries(registry.bundles);

    // A terminal record consumed its nonce forever (submitted OR failed) —
    // even after its rawTx was deleted. Every pending bundle at or below the
    // highest terminal nonce is therefore dead, never claimable. Mốc đọc từ
    // registry (field đơn điệu + record terminal), nên user dọn record history
    // KHÔNG làm mất nó (audit A.2) — trước đây mốc được tính lại từ record và
    // có thể biến mất cùng record.
    const consumedNonce = consumedWatermark(registry);
    for (const [, bundle] of entries) {
      if (bundle.status !== "pending") continue;
      const value = Number(bundle.nonce);
      if (value < Number(nonce) || value <= consumedNonce) {
        bundle.status = "expired";
        // Mốc để purge đo ân hạn (chẩn đoán 2026-09-26).
        bundle.expiredAt = new Date(now()).toISOString();
      }
    }

    // Only unmined claims reserve the nonce: a pending-nonce advance is NOT
    // receipt evidence for a lower-nonce claim. Terminal records are inert.
    const claims = entries
      .filter(([, bundle]) => isActiveClaim(bundle) && Number(bundle.nonce) <= Number(nonce))
      .sort(compareClaimAge);
    const byNonce = new Map();
    for (const [, bundle] of claims) {
      const key = Number(bundle.nonce);
      byNonce.set(key, (byNonce.get(key) ?? 0) + 1);
    }
    if ([...byNonce.values()].some((count) => count > 1)) {
      logger?.error?.(`[presign] FAIL CLOSED: multiple active claims share a nonce (${claims.map(([id, bundle]) => `${id}:${bundle.nonce}`).join(", ")}); no broadcast will be attempted`);
      // `nonce` đi kèm để monitor cảnh báo được theo (kind, nonce) — xung đột nonce
      // là ca bắt buộc phải báo, không chỉ log (audit R1).
      return { conflict: true, nonce: Number(claims[0][1].nonce), diagnostic: "multiple active broadcasting claims share a nonce; no broadcast attempted" };
    }
    // Exactly one claim per cycle, oldest broadcastingAt first. Never claim a
    // new bundle while a durable claim is still being reconciled.
    if (claims.length > 0) return reconcileBroadcasting(claims[0][0], claims[0][1]);

    // Multi-nonce ladder (v3): entries are keyed `marketId@nonce`, so a market
    // can hold several bundles at once. Only the entry at the CURRENT on-chain
    // pending nonce is ever claimable (txs mine strictly in nonce order) — a
    // future-nonce tx pre-broadcast would mine unconditionally and defeat the
    // trigger condition. Among same-nonce contenders the first market in
    // markets.json order wins; siblings stay pending until the nonce is
    // consumed (then they expire — their signature is bound to that nonce).
    // snapshots được key theo MARKET ID (contract của market-reader); registry v3
    // key bundle dạng `marketId@nonce` (identity nằm trong VALUE). Claim phải tìm
    // rung theo market qua marketBundles — KHÔNG index registry.bundles bằng
    // marketId (audit 2026-09-24 P0: lookup đó chỉ trúng key legacy v2, khiến
    // mọi bundle ký mới qua webapp kẹt pending vĩnh viễn).
    for (const [marketId, snapshot] of snapshots) {
      const rung = marketBundles(registry.bundles, marketId)
        .find(({ bundle }) => bundle?.status === "pending" && Number(bundle.nonce) === Number(nonce));
      if (!rung || !isEligible(snapshot)) continue;
      // Registry key và marketId là HAI identity khác nhau: key là opaque,
      // marketId lấy từ VALUE (P0 part 2: verifyBundle phải nhận marketId —
      // composite key sẽ làm verify thật từ chối bundle).
      const { key, bundle } = rung;
      const bundleMarketId = rung.marketId;
      const verified = await verifyBundle(bundle, bundleMarketId);
      if (!verified.ok) {
        const nonceValue = Number(bundle.nonce);
        if (isConfigVerifyError(verified.code)) {
          // Lệch .env (LENDER_ADDRESS / MORPHO_BLUE_ADDRESS đổi): bundle VẪN TỐT, chỉ
          // môi trường khác lúc ký. GIỮ pending — operator sửa .env là monitor tự
          // broadcast lại ở chu kỳ sau; đánh `invalid` ở đây sẽ giết vĩnh viễn mọi
          // bundle đã ký mà không cách nào tự khỏi (audit D2).
          bundle.verifyError = verified.error;
          problems.push({ id: key, marketId: bundleMarketId, nonce: nonceValue, kind: "config", error: verified.error });
        } else {
          // Lỗi thuộc về NỘI DUNG bundle ⇒ verify là hàm thuần, chạy lại cũng sai
          // như vậy: chốt `invalid` (không còn claimable) và báo cho người vận hành.
          bundle.status = "invalid";
          bundle.error = verified.error;
          problems.push({ id: key, marketId: bundleMarketId, nonce: nonceValue, kind: "invalid", error: verified.error });
        }
        continue;
      }
      // Config đã khớp lại ⇒ xoá dấu vết lệch trước đó.
      delete bundle.verifyError;
      const withdrawal = selectBestWithdrawal(bundle.withdrawals, snapshot);
      if (!withdrawal) continue;
      // Persist the exact signed bytes + hash BEFORE releasing the lock.
      bundle.status = "broadcasting";
      bundle.broadcastingAt = new Date(now()).toISOString();
      bundle.broadcastingTier = withdrawal.label;
      bundle.rawTx = withdrawal.signedTx;
      bundle.txHash = keccak256(withdrawal.signedTx);
      logger?.log?.(`[presign] claiming ${key} (market ${bundleMarketId}, nonce ${bundle.nonce}, tier ${withdrawal.label})`);
      return { id: key, marketId: bundleMarketId, bundle, rawTx: withdrawal.signedTx, stuck: false };
    }

    // Nothing to claim: say WHY. A legacy stuck claim is reported earlier;
    // this branch separates ordinary terminal history from an idle registry.
    const terminals = entries.filter(([, bundle]) => TERMINAL_STATUSES.has(bundle.status));
    if (terminals.length > 0) {
      return {
        existing: false,
        stuck: false,
        terminalSummary: { count: terminals.length, consumedNonce },
        diagnostic: `${terminals.length} terminal bundle(s) are history (highest consumed nonce ${consumedNonce}); no claim is held`,
      };
    }
    return null;
  });

  // Gắn `problems` vào MỌI kết quả (kể cả khi không claim được gì) — nếu bỏ sót,
  // một chu kỳ chỉ toàn bundle hỏng sẽ trả `null` và monitor không báo gì.
  const withProblems = (result) => {
    if (!problems.length) return result;
    if (result && typeof result === "object") { result.problems = problems; return result; }
    return { problems };
  };

  if (!claim || claim.conflict) return withProblems(claim);
  if (claim.stuck) {
    logger?.warn?.(`[presign] ${claim.diagnostic}`);
    return withProblems(claim);
  }
  // Terminal-only / nothing claimable: informational result, no RPC I/O.
  if (!claim.bundle || !claim.rawTx) return withProblems(claim);
  // Mọi `return claim` từ đây trả CÙNG object ⇒ gắn một lần là đủ.
  if (problems.length) claim.problems = problems;

  const rawTx = claim.rawTx;
  const txHash = claim.bundle.txHash;
  // Sibling expiry dùng NONCE CỦA CLAIM, không phải `nonce` (pending nonce đọc ở
  // đầu chu kỳ): khi claim đang nằm trong mempool, getTransactionCount(pending)
  // đã tính chính nó ⇒ pending = claim.nonce + 1 (audit F4).
  const claimNonce = Number(claim.bundle?.nonce);
  try {
    let receipt;
    if (claim.existing) {
      // Receipt-first: reconcile by the persisted hash before any rebroadcast.
      //
      // "Không có receipt" LÀ bằng chứng, nhưng nó đến theo HAI hình dạng tuỳ client:
      //  - viem thật: getTransactionReceipt NÉM TransactionReceiptNotFoundError khi
      //    JSON-RPC trả null (viem/_esm/actions/public/getTransactionReceipt.js);
      //  - transport tự viết: trả thẳng `null`.
      // Audit vòng 2 (D1): code cũ chỉ nhận `null` và coi MỌI throw là "lookup lỗi"
      // ⇒ với viem thật `receiptMissing` luôn false ⇒ nhánh nhả superseded không bao
      // giờ chạy và claim chết vẫn kẹt bậc thang. Lỗi mạng/RPC KHÁC vẫn không phải
      // bằng chứng (fail closed).
      let receiptMissing = false;
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash });
        receiptMissing = receipt == null;
      } catch (err) {
        receiptMissing = err?.name === "TransactionReceiptNotFoundError";
        receipt = undefined;
      }
      if (!isMinedReceipt(receipt)) {
        receipt = undefined;
        const claimedAt = Date.parse(claim.bundle.broadcastingAt || "");
        if (Number.isFinite(claimedAt) && now() - claimedAt < RECOVERY_THRESHOLD_MS) return claim;
        // Audit R1: nếu nonce đã bị tx khác tiêu thụ thì rebroadcast exact-bytes
        // chỉ có thể thất bại ("nonce too low") trong khi claim durable chặn cả
        // bậc thang — nhả theo bằng chứng TRƯỚC khi thử gửi lại.
        if (receiptMissing) {
          const evidence = await nonceConsumedByAnotherTx(client, lenderAddress, claimNonce);
          if (evidence.consumed) {
            return await releaseSuperseded({ filePath, claim, claimNonce, txHash, updateRegistry, now, logger, lenderAddress, anchorBlock: evidence.anchorBlock });
          }
        }
        // Recovery window elapsed: rebroadcast the EXACT same bytes (verified in phase 1).
        await client.sendRawTransaction({ serializedTransaction: rawTx });
        try { receipt = await client.getTransactionReceipt({ hash: txHash }); } catch { receipt = undefined; }
        if (!isMinedReceipt(receipt)) return claim; // ambiguity keeps the claim
      }
    } else {
      await client.sendRawTransaction({ serializedTransaction: rawTx });
      receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
      if (!isMinedReceipt(receipt)) return claim;
    }
    if (!isMinedReceipt(receipt)) return claim;

    // ---- Phase 2: receipt-grounded terminal transition + sibling expiry ----
    await updateRegistry(filePath, (registry) => {
      const bundle = registry.bundles[claim.id];
      if (!bundle || bundle.status !== "broadcasting" || bundle.txHash !== txHash) return;
      // v3: stamp marketId from the composite key if missing (migrated v2
      // bundles already carry it).
      if (bundle.marketId == null) {
        const { marketId } = parseBundleKey(claim.id);
        if (marketId) bundle.marketId = marketId;
      }
      bundle.status = receipt.status === "success" ? "submitted" : "failed";
      const stamped = new Date(now()).toISOString();
      // terminalAt drives retention/display; minedAt kept for older readers.
      bundle.terminalAt = stamped;
      bundle.minedAt = stamped;
      delete bundle.rawTx; // raw bytes are no longer needed once terminal
      logger?.log?.(`[presign] broadcast ${bundle.status} market=${claim.marketId ?? claim.bundle?.marketId ?? claim.id} txHash=${txHash} tier=${claim.bundle.broadcastingTier} nonce=${Number.isFinite(claimNonce) ? claimNonce : nonce}`);
      // A mined receipt consumes THE CLAIM'S nonce: expire same-nonce siblings.
      expireSameNonceSiblings(registry, claim.id, claimNonce, now);
    });
  } catch (err) {
    // RPC ambiguity deliberately retains the durable broadcasting claim.
    logger?.error?.(`[presign] broadcast error (claim retained): ${err?.message || err}`);
  }
  return claim;
}
