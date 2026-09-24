import { keccak256 } from "viem";
import { parseBundleKey } from "./presigned-store.mjs";

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

/** Terminal states are receipt-grounded history: they hold no claim. */
const TERMINAL_STATUSES = new Set(["submitted", "failed"]);

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

export async function broadcastEligible({ client, lenderAddress, filePath, snapshots, updateRegistry, verifyBundle, isEligible, now = () => Date.now(), logger = console }) {
  const nonce = await client.getTransactionCount({ address: lenderAddress, blockTag: "pending" });

  // ---- Phase 1: durable claim under the registry lock (no network I/O) ----
  const claim = await updateRegistry(filePath, async (registry) => {
    const entries = Object.entries(registry.bundles);

    // A terminal record consumed its nonce forever (submitted OR failed) —
    // even after its rawTx was deleted. Every pending bundle at or below the
    // highest terminal nonce is therefore dead, never claimable.
    let consumedNonce = -1;
    for (const [, bundle] of entries) {
      const value = Number(bundle.nonce);
      if (TERMINAL_STATUSES.has(bundle.status) && Number.isFinite(value)) consumedNonce = Math.max(consumedNonce, value);
    }
    for (const [, bundle] of entries) {
      if (bundle.status !== "pending") continue;
      const value = Number(bundle.nonce);
      if (value < Number(nonce) || value <= consumedNonce) bundle.status = "expired";
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
      return { conflict: true, diagnostic: "multiple active broadcasting claims share a nonce; no broadcast attempted" };
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
    for (const [id, snapshot] of snapshots) {
      const bundle = registry.bundles[id];
      if (!bundle || bundle.status !== "pending" || Number(bundle.nonce) !== Number(nonce) || !isEligible(snapshot)) continue;
      const verified = await verifyBundle(bundle, id);
      if (!verified.ok) { bundle.status = "invalid"; bundle.error = verified.error; continue; }
      const withdrawal = selectBestWithdrawal(bundle.withdrawals, snapshot);
      if (!withdrawal) continue;
      // Persist the exact signed bytes + hash BEFORE releasing the lock.
      bundle.status = "broadcasting";
      bundle.broadcastingAt = new Date(now()).toISOString();
      bundle.broadcastingTier = withdrawal.label;
      bundle.rawTx = withdrawal.signedTx;
      bundle.txHash = keccak256(withdrawal.signedTx);
      logger?.log?.(`[presign] claiming ${id} (nonce ${bundle.nonce}, tier ${withdrawal.label})`);
      return { id, bundle, rawTx: withdrawal.signedTx, stuck: false };
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

  if (!claim || claim.conflict) return claim;
  if (claim.stuck) {
    logger?.warn?.(`[presign] ${claim.diagnostic}`);
    return claim;
  }
  // Terminal-only / nothing claimable: informational result, no RPC I/O.
  if (!claim.bundle || !claim.rawTx) return claim;

  const rawTx = claim.rawTx;
  const txHash = claim.bundle.txHash;
  try {
    let receipt;
    if (claim.existing) {
      // Receipt-first: reconcile by the persisted hash before any rebroadcast.
      try { receipt = await client.getTransactionReceipt({ hash: txHash }); } catch { /* not mined yet */ }
      if (!isMinedReceipt(receipt)) {
        receipt = undefined;
        const claimedAt = Date.parse(claim.bundle.broadcastingAt || "");
        if (Number.isFinite(claimedAt) && now() - claimedAt < RECOVERY_THRESHOLD_MS) return claim;
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
      logger?.log?.(`[presign] broadcast ${bundle.status} market=${claim.id} txHash=${txHash} tier=${claim.bundle.broadcastingTier} nonce=${nonce}`);
      // A mined receipt consumes the nonce: expire same-nonce siblings.
      for (const [id, other] of Object.entries(registry.bundles)) {
        if (id !== claim.id && Number(other.nonce) === Number(nonce) && other.status !== "submitted" && other.status !== "failed") other.status = "expired";
      }
    });
  } catch (err) {
    // RPC ambiguity deliberately retains the durable broadcasting claim.
    logger?.error?.(`[presign] broadcast error (claim retained): ${err?.message || err}`);
  }
  return claim;
}
