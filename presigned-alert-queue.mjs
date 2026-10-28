import { randomUUID } from "node:crypto";
import { buildLifecycleAlert } from "./lifecycle-alert.mjs";
import { readRegistry, parseBundleKey } from "./presigned-store.mjs";

/** Persist one-off lifecycle transitions inside the same locked registry mutation. */
export function queueBundleAlert(bundle, { kind, id, marketId, nonce, tier, detail }, now = () => Date.now()) {
  if (!bundle || !["expired", "invalid", "superseded"].includes(kind)) return false;
  const alerts = bundle.lifecycleAlerts ??= [];
  // Each kind is tied to a one-way state transition for a given bundle identity.
  if (alerts.some((alert) => alert.kind === kind)) return false;
  alerts.push({
    eventId: randomUUID(), kind, state: "pending", queuedAt: new Date(now()).toISOString(),
    attempts: 0, nextAttemptAt: null, leaseId: null, leaseUntil: null,
    info: { id, marketId: marketId ?? bundle.marketId ?? parseBundleKey(id).marketId,
      nonce: nonce ?? bundle.nonce, tier: tier ?? bundle.broadcastingTier, detail },
  });
  return true;
}

const RETRY_DELAYS_MS = [5, 10, 20, 40, 60].map((min) => min * 60_000);
export const LIFECYCLE_LEASE_MS = 30_000;

/**
 * At-least-once outbox. Lease under the registry lock, release it for network I/O,
 * then acknowledge only if this worker still owns the lease.
 */
export async function drainLifecycleAlerts({
  filePath, updateRegistry, send, now = () => Date.now(), logger = console,
  batchSize = 5, concurrency = 2, leaseMs = LIFECYCLE_LEASE_MS, chain = null,
} = {}) {
  // Avoid writing the registry every 30 seconds when no alert is due.
  const elapsed = (timestamp, at) => !timestamp || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) <= at;
  const due = (alert, at) => alert?.state === "pending"
    && elapsed(alert.nextAttemptAt, at)
    && elapsed(alert.leaseUntil, at);
  let snapshot;
  try { snapshot = readRegistry(filePath); }
  catch (err) { logger?.warn?.(`[presign] cannot read lifecycle alerts: ${err?.message || err}`); return { sent: 0, failed: 0 }; }
  const bundleDue = Object.values(snapshot.bundles).some((bundle) => bundle.lifecycleAlerts?.some((alert) => due(alert, now())));
  const orphanDue = Object.values(snapshot.orphanedLifecycleAlerts ?? {}).some((alert) => due(alert, now()));
  if (!bundleDue && !orphanDue) {
    return { sent: 0, failed: 0 };
  }

  const owner = randomUUID();
  let leased;
  try { leased = await updateRegistry(filePath, (registry) => {
    const claimed = [];
    for (const [id, bundle] of Object.entries(registry.bundles)) {
      for (const [index, alert] of (bundle.lifecycleAlerts ?? []).entries()) {
        if (!due(alert, now()) || claimed.length >= batchSize) continue;
        alert.eventId ??= randomUUID();
        alert.leaseId = owner;
        alert.leaseUntil = new Date(now() + leaseMs).toISOString();
        alert.attempts = (Number(alert.attempts) || 0) + 1;
        claimed.push({ id, index, alert: structuredClone(alert) });
      }
      if (claimed.length >= batchSize) break;
    }
    for (const [id, alert] of Object.entries(registry.orphanedLifecycleAlerts ?? {})) {
      if (!due(alert, now()) || claimed.length >= batchSize) continue;
      alert.eventId = id;
      alert.leaseId = owner;
      alert.leaseUntil = new Date(now() + leaseMs).toISOString();
      alert.attempts = (Number(alert.attempts) || 0) + 1;
      claimed.push({ id, index: null, alert: structuredClone(alert) });
    }
    return claimed;
  }); }
  catch (err) {
    logger?.error?.(`[presign] cannot lease lifecycle alerts (will retry): ${err?.message || err}`);
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;
  let index = 0;
  async function worker() {
    while (index < leased.length) {
      const task = leased[index++];
      let error = null;
      try {
        const alert = buildLifecycleAlert(task.alert.kind, { ...task.alert.info, chain });
        if (!alert) throw new Error(`unsupported alert kind ${task.alert.kind}`);
        await send(alert);
      } catch (err) {
        error = err;
        logger?.error?.(`[presign] lifecycle alert (${task.alert.kind}, ${task.id}) failed: ${err?.message || err}`);
      }
      try {
        const acknowledged = await updateRegistry(filePath, (registry) => {
          const alert = registry.bundles[task.id]?.lifecycleAlerts?.find((item) => item.eventId === task.alert.eventId)
            ?? registry.orphanedLifecycleAlerts?.[task.alert.eventId];
          if (!alert || alert.leaseId !== owner || alert.state !== "pending") return false;
          alert.leaseId = null;
          alert.leaseUntil = null;
          if (error) {
            const delay = RETRY_DELAYS_MS[Math.min(alert.attempts - 1, RETRY_DELAYS_MS.length - 1)];
            alert.nextAttemptAt = new Date(now() + delay).toISOString();
          } else if (registry.orphanedLifecycleAlerts?.[task.alert.eventId] === alert) {
            delete registry.orphanedLifecycleAlerts[task.alert.eventId];
          } else {
            alert.state = "sent";
            alert.sentAt = new Date(now()).toISOString();
            alert.nextAttemptAt = null;
          }
          return true;
        });
        if (!acknowledged) throw new Error("lifecycle alert lease no longer owned");
        if (error) failed += 1;
        else sent += 1;
      } catch (err) {
        // The persisted lease will expire. A retry can cause a duplicate after
        // successful network delivery; this is intentional at-least-once semantics.
        failed += 1;
        logger?.error?.(`[presign] cannot acknowledge lifecycle alert (${task.id}), will retry: ${err?.message || err}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, leased.length) }, () => worker()));
  return { sent, failed };
}
