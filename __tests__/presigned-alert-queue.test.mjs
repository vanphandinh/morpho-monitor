import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak256 } from "viem";
import { broadcastEligible, purgeExpiredRungs, RECOVERY_THRESHOLD_MS } from "../presigned-broadcast.mjs";
import { updateRegistry, readRegistry } from "../presigned-store.mjs";
import { drainLifecycleAlerts } from "../presigned-alert-queue.mjs";

const BASE = Date.parse("2026-10-13T08:00:00Z");
const silent = { log() {}, error() {}, warn() {} };
const pending = (nonce) => ({ nonce, status: "pending", withdrawals: [] });
function fixture(bundles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-alert-"));
  const filePath = path.join(dir, "presigned.json");
  fs.writeFileSync(filePath, JSON.stringify({ version: 3, consumedNonce: -1, bundles }));
  return filePath;
}
const read = (filePath) => readRegistry(filePath).bundles;
const run = (filePath, client, now = () => BASE) => broadcastEligible({
  client, lenderAddress: "0x111", filePath, snapshots: new Map(), updateRegistry,
  verifyBundle: async () => ({ ok: true }), isEligible: () => false, now, logger: silent,
});
const drain = (filePath, send, now = () => BASE) => drainLifecycleAlerts({ filePath, updateRegistry, send, now, logger: silent });

describe("durable lifecycle alert outbox", () => {
  it("records every pending nonce that expires and delivers exactly once", async () => {
    const filePath = fixture({ a: pending(3), b: pending(4), c: pending(7) });
    await run(filePath, { getTransactionCount: async () => 6 });
    expect(read(filePath).a.lifecycleAlerts[0].kind).toBe("expired");
    expect(read(filePath).b.lifecycleAlerts[0].kind).toBe("expired");
    expect(read(filePath).c.lifecycleAlerts).toBeUndefined();
    const send = vi.fn(async () => {});
    expect((await drain(filePath, send)).sent).toBe(2);
    await drain(filePath, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(read(filePath).a.lifecycleAlerts[0].state).toBe("sent");
  });

  it("keeps failed events after restart and retries after persisted backoff", async () => {
    const filePath = fixture({ a: pending(3) });
    await run(filePath, { getTransactionCount: async () => 4 });
    await drain(filePath, async () => { throw new Error("offline"); });
    expect(read(filePath).a.lifecycleAlerts[0].state).toBe("pending");
    expect(read(filePath).a.lifecycleAlerts[0].attempts).toBe(1);
    const send = vi.fn(async () => {});
    await drain(filePath, send, () => BASE + 4 * 60_000);
    expect(send).not.toHaveBeenCalled();
    await drain(filePath, send, () => BASE + 5 * 60_000);
    expect(send).toHaveBeenCalledOnce();
    expect(read(filePath).a.lifecycleAlerts[0].state).toBe("sent");
  });

  it("two simultaneous pumps lease disjoint work, including when one is still sending", async () => {
    const filePath = fixture({ a: pending(3) });
    await run(filePath, { getTransactionCount: async () => 4 });
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const send = vi.fn(async () => waiting);
    const first = drain(filePath, send);
    // Await until first sender starts and holds its lease.
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await drain(filePath, send);
    expect(send).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it("purge retains unsent expired events and deletes sent events after retention", async () => {
    const filePath = fixture({ a: pending(3) });
    await run(filePath, { getTransactionCount: async () => 4 });
    await purgeExpiredRungs({ filePath, updateRegistry, now: () => BASE + 2 * 3_600_000, retentionMs: 0, logger: silent });
    expect(read(filePath).a).toBeDefined();
    await drain(filePath, async () => {}, () => BASE + 2 * 3_600_000);
    await purgeExpiredRungs({ filePath, updateRegistry, now: () => BASE + 2 * 3_600_000, retentionMs: 0, logger: silent });
    expect(read(filePath).a).toBeUndefined();
  });

  it("receipt-based sibling expiry records alerts", async () => {
    const tx = "0xdead";
    const filePath = fixture({ a: { ...pending(7), withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }] }, b: pending(7) });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: async () => "ok", waitForTransactionReceipt: async () => ({ status: "success", blockHash: "0xabc", blockNumber: 1n, transactionHash: keccak256(tx) }) };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["a", { market: { liquidity: 100n, totalSupplyAssets: 100n, totalSupplyShares: 100n } }]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true, now: () => BASE, logger: silent });
    expect(read(filePath).b.lifecycleAlerts.map((a) => a.kind)).toContain("expired");
  });

  it("superseded claim and its sibling each produce their own durable alerts", async () => {
    const tx = "0xdead";
    const filePath = fixture({ a: { ...pending(7), status: "broadcasting", broadcastingAt: new Date(BASE - RECOVERY_THRESHOLD_MS - 1000).toISOString(), rawTx: tx, txHash: keccak256(tx) }, b: pending(7) });
    const client = { getTransactionCount: async ({ blockTag }) => blockTag === "pending" ? 8 : 8, getTransactionReceipt: async () => { const e = new Error("missing"); e.name = "TransactionReceiptNotFoundError"; throw e; }, getBlockNumber: async () => 25n };
    await run(filePath, client);
    expect(read(filePath).a.lifecycleAlerts.map((a) => a.kind)).toContain("superseded");
    expect(read(filePath).b.lifecycleAlerts.map((a) => a.kind)).toContain("expired");
  });

  it("does not lose an invalid alert when a later nonce transition expires it", async () => {
    const filePath = fixture({ a: { ...pending(7), lifecycleAlerts: [{ kind: "invalid", state: "pending", queuedAt: new Date(BASE).toISOString(), attempts: 0 }] } });
    // Nonce 7 becomes consumed by an on-chain terminal sibling at nonce 7.
    await updateRegistry(filePath, (registry) => { registry.bundles.b = { nonce: 7, status: "submitted" }; });
    await run(filePath, { getTransactionCount: async () => 8 });
    expect(read(filePath).a.lifecycleAlerts.map((a) => a.kind)).toEqual(["invalid", "expired"]);
  });

  it("malformed timestamps cannot permanently strand a pending alert", async () => {
    const filePath = fixture({ a: { ...pending(3), lifecycleAlerts: [{
      kind: "expired", state: "pending", attempts: 0,
      nextAttemptAt: "bad timestamp", leaseUntil: "bad timestamp",
      info: { id: "a", nonce: 3 },
    }] } });
    const send = vi.fn(async () => {});
    await drain(filePath, send);
    expect(send).toHaveBeenCalledOnce();
    expect(read(filePath).a.lifecycleAlerts[0].state).toBe("sent");
  });

  it("claim failure remains retryable and does not reject the monitor", async () => {
    const filePath = fixture({ a: pending(3) });
    await run(filePath, { getTransactionCount: async () => 4 });
    const send = vi.fn(async () => {});
    const failedClaim = vi.fn(async () => { throw new Error("lock unavailable"); });
    await expect(drainLifecycleAlerts({ filePath, updateRegistry: failedClaim, send, logger: silent })).resolves.toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    await drain(filePath, send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("acknowledgment failure is reported and the leased alert survives for retry", async () => {
    const filePath = fixture({ a: pending(3) });
    await run(filePath, { getTransactionCount: async () => 4 });
    let writes = 0;
    const write = async (...args) => {
      if (++writes === 2) throw new Error("disk temporarily unavailable");
      return updateRegistry(...args);
    };
    const send = vi.fn(async () => {});
    await expect(drainLifecycleAlerts({ filePath, updateRegistry: write, send, now: () => BASE, logger: silent })).resolves.toEqual({ sent: 0, failed: 1 });
    expect(read(filePath).a.lifecycleAlerts[0].state).toBe("pending");
    await drain(filePath, send, () => BASE + 31_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(read(filePath).a.lifecycleAlerts[0].state).toBe("sent");
  });

  it("preserves a pending event when a user deletes or replaces its bundle", async () => {
    const filePath = fixture({ a: pending(3), b: pending(4) });
    await run(filePath, { getTransactionCount: async () => 5 });
    await updateRegistry(filePath, (registry) => {
      delete registry.bundles.a;
      registry.bundles.b = { nonce: 9, status: "pending", withdrawals: [] };
    }, { origin: "user" });
    const stored = readRegistry(filePath);
    expect(stored.bundles.a).toBeUndefined();
    expect(stored.bundles.b.lifecycleAlerts).toBeUndefined();
    expect(Object.values(stored.orphanedLifecycleAlerts)).toHaveLength(2);
    const send = vi.fn(async () => {});
    expect((await drain(filePath, send)).sent).toBe(2);
    await drain(filePath, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(Object.values(readRegistry(filePath).orphanedLifecycleAlerts)).toHaveLength(0);
  });

  it("acknowledges an in-flight alert moved to the orphan store by user deletion", async () => {
    const filePath = fixture({ a: pending(3) });
    await run(filePath, { getTransactionCount: async () => 4 });
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const send = vi.fn(async () => waiting);
    const delivery = drain(filePath, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await updateRegistry(filePath, (registry) => { delete registry.bundles.a; }, { origin: "user" });
    expect(Object.values(readRegistry(filePath).orphanedLifecycleAlerts)).toHaveLength(1);
    await drain(filePath, send);
    expect(send).toHaveBeenCalledOnce();
    release();
    expect((await delivery).sent).toBe(1);
    expect(Object.values(readRegistry(filePath).orphanedLifecycleAlerts)).toHaveLength(0);
    await drain(filePath, send);
    expect(send).toHaveBeenCalledOnce();
  });
});
