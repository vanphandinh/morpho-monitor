import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./shared.mjs";

/**
 * Registry v3 (multi-nonce presign ladder, 2026-09-24):
 * bundles được khóa phức hợp `marketId@nonce` thay vì chỉ marketId, nên MỌI
 * market có thể giữ bundle ở NHIỀU nonce liên tiếp cùng lúc (ký trước, chờ
 * on-chain nonce đi qua). Mỗi bundle mang field `marketId` (authoritative khi
 * key bị mâu thuẫn). Broadcast vẫn chỉ claim bundle ở nonce == on-chain
 * pending; bundle nonce thấp hơn pending/đã tiêu thụ → expired.
 */
export const REGISTRY_VERSION = 3;

export function emptyRegistry() {
  return { version: REGISTRY_VERSION, bundles: {} };
}

/** Composite registry key: `marketId@nonce` (marketId lowercase). */
export function bundleKey(marketId, nonce) {
  return `${String(marketId).toLowerCase()}@${Number(nonce)}`;
}

/** Split a composite key; plain legacy keys → marketId = key, nonce = NaN. */
export function parseBundleKey(key) {
  const idx = String(key).lastIndexOf("@");
  if (idx <= 0) return { marketId: String(key), nonce: NaN };
  return { marketId: String(key).slice(0, idx), nonce: Number(String(key).slice(idx + 1)) };
}

/**
 * Coerce an on-disk registry to v3 shape. v2 (one bundle per marketId) is
 * migrated in-memory: bundles KEEP their original keys (opaque identifiers —
 * nothing parses them for identity) and gain a `marketId` field. New saves
 * via the webapp API write composite keys `marketId@nonce`. Identity of a
 * bundle is (bundle.marketId ?? key, bundle.nonce) — always read from VALUES,
 * never from the key. Anything else fails closed (v1 or garbage must never
 * be silently accepted).
 */
function migrateRegistry(parsed) {
  if (parsed && (parsed.version === REGISTRY_VERSION || parsed.version === 2) && parsed.bundles && typeof parsed.bundles === "object" && !Array.isArray(parsed.bundles)) {
    const bundles = {};
    for (const [key, bundle] of Object.entries(parsed.bundles)) {
      if (!bundle || typeof bundle !== "object") continue;
      bundles[key] = bundle.marketId != null ? bundle : { ...bundle, marketId: String(key).toLowerCase() };
    }
    return { version: REGISTRY_VERSION, bundles };
  }
  throw new Error("Presigned registry must use version 3 (or legacy version 2) with a bundles object");
}

export function readRegistry(filePath) {
  if (!fs.existsSync(filePath)) return emptyRegistry();
  const registry = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return migrateRegistry(registry);
}

export function writeRegistry(filePath, registry) {
  if (registry?.version !== REGISTRY_VERSION || !registry.bundles || Array.isArray(registry.bundles)) {
    throw new Error("Refusing to write invalid presigned registry");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

/**
 * Statuses that represent an active nonce claim no user request may touch.
 *
 * ONLY an unmined `broadcasting` record is untouchable. Terminal records
 * (`submitted`/`failed`) are history: their nonce is already consumed and
 * their rawTx deleted, so the user must be able to delete or replace them
 * (otherwise the registry grows forever with no retention policy — M1).
 */
const PROTECTED_STATUSES = new Set(["broadcasting"]);
export const ACTIVE_CLAIM_CONFLICT = "ACTIVE_CLAIM_CONFLICT";

/** Snapshot the identity of every active claim for post-mutation comparison. */
function activeClaimSignature(registry) {
  const claims = [];
  for (const [id, bundle] of Object.entries(registry.bundles)) {
    if (!PROTECTED_STATUSES.has(bundle.status)) continue;
    claims.push({
      id,
      status: bundle.status,
      nonce: bundle.nonce,
      txHash: bundle.txHash ?? null,
      broadcastingTier: bundle.broadcastingTier ?? null,
      // Any tier add/remove/edit on an active bundle is a conflict.
      withdrawalsDigest: JSON.stringify(bundle.withdrawals ?? null),
    });
  }
  // Deterministic order so signatures compare structurally.
  claims.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return claims;
}

function sameClaims(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id !== y.id || x.status !== y.status || x.nonce !== y.nonce) return false;
    if ((x.txHash ?? null) !== (y.txHash ?? null)) return false;
    if ((x.broadcastingTier ?? null) !== (y.broadcastingTier ?? null)) return false;
    if (x.withdrawalsDigest !== y.withdrawalsDigest) return false;
  }
  return true;
}

/**
 * Serialize all mutations across webapp and monitor processes.
 *
 * opts.origin — "user" (webapp HTTP API) or "monitor" (default). A user-origin
 * mutation is rejected when it would delete or alter any active claim
 * (broadcasting/submitted bundle, its nonce, tier or tx identity). The error
 * carries code ACTIVE_CLAIM_CONFLICT so HTTP layers can answer 409. The
 * monitor's own terminal transitions use the default origin and are unaffected.
 */
export async function updateRegistry(filePath, mutate, opts = {}) {
  const origin = opts.origin === "user" ? "user" : "monitor";
  return withFileLock(`${filePath}.lock`, async () => {
    const registry = readRegistry(filePath);
    if (origin === "user") {
      const before = activeClaimSignature(registry);
      try {
        const result = await mutate(registry);
        if (!sameClaims(before, activeClaimSignature(registry))) {
          const err = new Error("Conflict: the presigned transaction is actively claimed (broadcasting/submitted) and cannot be modified from the web interface");
          err.code = ACTIVE_CLAIM_CONFLICT;
          throw err;
        }
        writeRegistry(filePath, registry);
        return result;
      } catch (err) {
        // Signature mismatch muộn hơn (mutate đã đổi registry rồi mới throw):
        // ưu tiên giữ code ACTIVE_CLAIM_CONFLICT; lỗi khác giữ nguyên.
        if (err?.code === ACTIVE_CLAIM_CONFLICT) throw err;
        if (!sameClaims(before, activeClaimSignature(registry))) {
          err.code = ACTIVE_CLAIM_CONFLICT;
          throw err;
        }
        throw err;
      }
    }
    const result = await mutate(registry);
    writeRegistry(filePath, registry);
    return result;
  });
}

export function registrySummary(bundle) {
  if (!bundle) return { exists: false };
  return {
    exists: true,
    status: bundle.status || "pending",
    nonce: bundle.nonce,
    createdAt: bundle.createdAt,
    // Terminal retention/display timestamp (null while not terminal).
    terminalAt: bundle.terminalAt ?? null,
    tiers: (bundle.withdrawals || []).map((w) => ({
      label: w.label,
      amountFormatted: w.amountFormatted,
      amountWei: w.amountWei,
      ...(w.type === "all-shares" ? { type: w.type, sharesWei: w.sharesWei } : {}),
    })),
  };
}

/** Every bundle of one market, ascending nonce. Identity comes from bundle VALUES (marketId field, nonce); the key is opaque. */
export function marketBundles(registryOrBundles, marketId) {
  const bundles = registryOrBundles?.bundles ?? registryOrBundles ?? {};
  const id = String(marketId).toLowerCase();
  return Object.entries(bundles)
    .filter(([, bundle]) => String(bundle?.marketId ?? "").toLowerCase() === id)
    .map(([key, bundle]) => ({ key, bundle }))
    .sort((a, b) => Number(a.bundle?.nonce) - Number(b.bundle?.nonce));
}

/**
 * Group bundles by nonce ascending. Each round: { nonce, entries: [{ key,
 * marketId, bundle }] } — the webapp overview renders one row per round and
 * the broadcaster resolves same-nonce races by trigger order.
 */
export function nonceRounds(registryOrBundles) {
  const bundles = registryOrBundles?.bundles ?? registryOrBundles ?? {};
  const rounds = new Map();
  for (const [key, bundle] of Object.entries(bundles)) {
    const marketId = String(bundle?.marketId ?? parseBundleKey(key).marketId).toLowerCase();
    const n = Number(bundle?.nonce);
    if (!Number.isFinite(n)) continue;
    if (!rounds.has(n)) rounds.set(n, []);
    rounds.get(n).push({ key, marketId, bundle });
  }
  return [...rounds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([nonce, entries]) => ({ nonce, entries }));
}
