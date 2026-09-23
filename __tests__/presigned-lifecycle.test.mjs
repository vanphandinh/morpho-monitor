import { describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex } from "viem";
import { broadcastEligible, selectBestWithdrawal, RECOVERY_THRESHOLD_MS } from "../presigned-broadcast.mjs";
import { updateRegistry, ACTIVE_CLAIM_CONFLICT } from "../presigned-store.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const snapshot = { market: { liquidity: 100n, totalSupplyAssets: 100n, totalSupplyShares: 100n } };
const pending = (nonce, tx = "0x01") => ({ nonce, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }] });

/** Temp registry file backed by the REAL store implementation. */
function tempRegistryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-lifecycle-"));
  return path.join(dir, "presigned.json");
}

/** Seed the on-disk registry so the real store actually reads this state. */
function seedRegistry(filePath, registry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(registry));
  return registry;
}

const minedReceipt = (status = "success") => ({ status, blockHash: "0x" + "a".repeat(64), blockNumber: 1n, transactionHash: "0x" + "b".repeat(64) });

describe("presigned broadcaster lifecycle", () => {
  it("retains future nonce and permits only one same-nonce claim", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: { a: pending(7), b: pending(7), future: pending(9) } });
    const client = { getTransactionCount: vi.fn().mockResolvedValue(7), sendRawTransaction: vi.fn().mockRejectedValue(new Error("timeout")) };
    await Promise.all([
      broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["a", snapshot], ["b", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true }),
      broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["a", snapshot], ["b", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true }),
    ]);
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(Object.values(stored.bundles).filter((b) => b.status === "broadcasting")).toHaveLength(1);
    expect(stored.bundles.future.status).toBe("pending");
  });

  it("only selects all-shares when its current asset value fits liquidity", () => {
    const selected = selectBestWithdrawal([{ type: "all-shares", sharesWei: "200", label: "all" }, { amountWei: "90", label: "fixed" }], snapshot);
    expect(selected.label).toBe("fixed");
  });

  it("finalizes only a mined receipt and expires sibling nonce claims", async () => {
    const filePath = tempRegistryPath();
    const tx = "0xdead";
    seedRegistry(filePath, { version: 2, bundles: { a: pending(7, tx), b: pending(7) } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: async () => "ignored", waitForTransactionReceipt: async () => minedReceipt("reverted") };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["a", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.a.status).toBe("failed");
    expect(stored.bundles.b.status).toBe("expired");
  });

  it("persists rawTx + txHash at claim and clears rawTx only at terminal state", async () => {
    const filePath = tempRegistryPath();
    const tx = stringToHex("payload");
    seedRegistry(filePath, { version: 2, bundles: { a: pending(7, tx) } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: async () => {}, waitForTransactionReceipt: async () => minedReceipt() };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["a", { ...snapshot }]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true, });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.a.status).toBe("submitted");
    expect(stored.bundles.a.rawTx).toBeUndefined();
    expect(stored.bundles.a.txHash).toBe(keccak256(tx));
    // A2: terminal transition ghi terminalAt (retention/display) cùng minedAt.
    expect(typeof stored.bundles.a.terminalAt).toBe("string");
    expect(stored.bundles.a.terminalAt).toBe(stored.bundles.a.minedAt);
  });

  it("keeps broadcasting on send timeout even when pending nonce advances", async () => {
    const filePath = tempRegistryPath();
    const tx = stringToHex("stuck");
    seedRegistry(filePath, { version: 2, bundles: { a: { nonce: 7, status: "broadcasting", broadcastingAt: new Date(Date.now() - RECOVERY_THRESHOLD_MS - 1000).toISOString(), broadcastingTier: "small", rawTx: tx, txHash: keccak256(tx), withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }] } } });
    // Pending nonce advanced to 9 — NOT receipt evidence for nonce 7.
    const client = { getTransactionCount: async () => 9, getTransactionReceipt: async () => { throw new Error("not mined"); }, sendRawTransaction: async () => { throw new Error("replacement underpriced"); } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(result.existing).toBe(true);
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.a.status).toBe("broadcasting");
  });

  it("reconciles an ambiguous claim to terminal state when the exact tx was mined", async () => {
    const filePath = tempRegistryPath();
    const tx = stringToHex("ambiguous");
    seedRegistry(filePath, { version: 2, bundles: { a: { nonce: 7, status: "broadcasting", broadcastingAt: new Date().toISOString(), broadcastingTier: "small", rawTx: tx, txHash: keccak256(tx), withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }] } } });
    const client = { getTransactionCount: async () => 9, getTransactionReceipt: async ({ hash }) => (hash === keccak256(tx) ? minedReceipt() : minedReceipt()) };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.a.status).toBe("submitted");
    // A mined receipt consumes the nonce: same-nonce siblings must not linger.
    expect(Object.values(stored.bundles).filter((b) => b.nonce === 7 && (b.status === "pending" || b.status === "broadcasting"))).toHaveLength(0);
  });

  it("fails closed on a legacy broadcasting record without raw identity", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: { legacy: { nonce: 7, status: "broadcasting", broadcastingAt: new Date(Date.now() - 10 * RECOVERY_THRESHOLD_MS).toISOString(), broadcastingTier: "small", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x01" }] } } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: vi.fn(), getTransactionReceipt: async () => { throw new Error("not mined"); } };
    const claim = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(claim.stuck).toBe(true);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.legacy.status).toBe("broadcasting");
  });

  it("fails closed when persisted rawTx does not match txHash", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: { tampered: { nonce: 7, status: "broadcasting", broadcastingAt: new Date(Date.now() - 10 * RECOVERY_THRESHOLD_MS).toISOString(), broadcastingTier: "small", rawTx: stringToHex("different"), txHash: keccak256(stringToHex("original")), withdrawals: [] } } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: vi.fn(), getTransactionReceipt: async () => { throw new Error("not mined"); } };
    const claim = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(claim.stuck).toBe(true);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("recovery rebroadcasts the exact persisted bytes, never a different tx", async () => {
    const filePath = tempRegistryPath();
    const tx = stringToHex("exact-bytes");
    seedRegistry(filePath, { version: 2, bundles: { a: { nonce: 7, status: "broadcasting", broadcastingAt: new Date(Date.now() - RECOVERY_THRESHOLD_MS - 5000).toISOString(), broadcastingTier: "small", rawTx: tx, txHash: keccak256(tx), withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }] } } });
    const client = { getTransactionCount: async () => 7, getTransactionReceipt: async () => { throw new Error("not mined"); }, sendRawTransaction: vi.fn().mockResolvedValue("ok"), waitForTransactionReceipt: async () => minedReceipt() };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(client.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: tx });
  });

  it("fails closed when two active same-nonce claims exist", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: { a: { nonce: 7, status: "broadcasting", rawTx: stringToHex("x"), txHash: keccak256(stringToHex("x")) }, b: { nonce: 7, status: "broadcasting", rawTx: stringToHex("y"), txHash: keccak256(stringToHex("y")) } } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: vi.fn(), getTransactionReceipt: async () => { throw new Error("not mined"); } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const claim = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(claim.conflict).toBe(true);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
    // Cả hai claim vẫn nguyên vẹn — không tự phá một cái nào.
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(Object.values(stored.bundles).every((b) => b.status === "broadcasting")).toBe(true);
  });

  it("A2: record terminal cùng nonce là lịch sử trơ, không phải conflict", async () => {
    const filePath = tempRegistryPath();
    const tx = stringToHex("live-claim");
    seedRegistry(filePath, { version: 2, bundles: {
      done: { nonce: 7, status: "submitted", txHash: keccak256(stringToHex("mined")), withdrawals: [] },
      live: { nonce: 7, status: "broadcasting", broadcastingAt: new Date().toISOString(), rawTx: tx, txHash: keccak256(tx), withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }] },
    } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: vi.fn(), getTransactionReceipt: async () => { throw new Error("not mined"); } };
    const claim = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(claim.conflict).toBeUndefined();
    expect(claim.stuck).toBe(false);
    // Chỉ claim đang mở được reconcile; record terminal không bị đụng tới.
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.live.status).toBe("broadcasting");
    expect(stored.bundles.done.status).toBe("submitted");
  });

  it("M11: nhiều claim khác nonce được reconcile theo broadcastingAt cũ nhất", async () => {
    const filePath = tempRegistryPath();
    const older = stringToHex("older");
    const newer = stringToHex("newer");
    seedRegistry(filePath, { version: 2, bundles: {
      zzz: { nonce: 8, status: "broadcasting", broadcastingAt: "2026-09-23T10:00:00.000Z", rawTx: newer, txHash: keccak256(newer), withdrawals: [] },
      aaa: { nonce: 7, status: "broadcasting", broadcastingAt: "2026-09-23T09:00:00.000Z", rawTx: older, txHash: keccak256(older), withdrawals: [] },
    } });
    const client = { getTransactionCount: async () => 9, getTransactionReceipt: async () => { throw new Error("not mined"); }, sendRawTransaction: vi.fn() };
    const claim = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(claim.id).toBe("aaa"); // oldest broadcastingAt, không phải thứ tự id
    expect(claim.bundle.nonce).toBe(7);
  });
});

describe("registry lifecycle guard (user origin)", () => {
  it("rejects deleting an active bundle from user origin", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: { a: { nonce: 7, status: "broadcasting", rawTx: stringToHex("x"), txHash: keccak256(stringToHex("x")) } } });
    await expect(updateRegistry(filePath, (registry) => { delete registry.bundles.a; }, { origin: "user" })).rejects.toMatchObject({ code: ACTIVE_CLAIM_CONFLICT });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.a.status).toBe("broadcasting");
  });

  it("M1: cho phép user xoá record terminal (submitted/failed), vẫn chặn broadcasting", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: {
      done: { nonce: 7, status: "submitted", txHash: keccak256(stringToHex("mined")), terminalAt: "2026-09-23T00:00:00.000Z", withdrawals: [] },
      failed: { nonce: 6, status: "failed", txHash: keccak256(stringToHex("reverted")), withdrawals: [] },
      live: { nonce: 8, status: "broadcasting", rawTx: stringToHex("x"), txHash: keccak256(stringToHex("x")) },
    } });
    await updateRegistry(filePath, (registry) => { delete registry.bundles.done; delete registry.bundles.failed; }, { origin: "user" });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.done).toBeUndefined();
    expect(stored.bundles.failed).toBeUndefined();
    expect(stored.bundles.live.status).toBe("broadcasting");
  });

  it("rejects tier removal from an active bundle from user origin", async () => {
    const filePath = tempRegistryPath();
    const tx = stringToHex("x");
    seedRegistry(filePath, { version: 2, bundles: { a: { nonce: 7, status: "broadcasting", rawTx: tx, txHash: keccak256(tx), withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }] } } });
    await expect(updateRegistry(filePath, (registry) => { registry.bundles.a.withdrawals.splice(0, 1); }, { origin: "user" })).rejects.toMatchObject({ code: ACTIVE_CLAIM_CONFLICT });
  });

  it("allows pending-bundle deletion and edits from user origin", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: { a: pending(7), active: { nonce: 8, status: "broadcasting", rawTx: stringToHex("x"), txHash: keccak256(stringToHex("x")) } } });
    await updateRegistry(filePath, (registry) => { registry.bundles.a.withdrawals.splice(0, 1); }, { origin: "user" });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.a.withdrawals).toHaveLength(0);
    expect(stored.bundles.active.status).toBe("broadcasting");
  });
});
