import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./shared.mjs";

export function emptyRegistry() {
  return { version: 2, bundles: {} };
}

export function readRegistry(filePath) {
  if (!fs.existsSync(filePath)) return emptyRegistry();
  const registry = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!registry || registry.version !== 2 || !registry.bundles || Array.isArray(registry.bundles)) {
    throw new Error("Presigned registry must use version 2 with a bundles object");
  }
  return registry;
}

export function writeRegistry(filePath, registry) {
  if (registry?.version !== 2 || !registry.bundles || Array.isArray(registry.bundles)) {
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
