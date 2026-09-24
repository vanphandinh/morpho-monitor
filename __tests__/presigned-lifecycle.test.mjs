import { describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex } from "viem";
import { broadcastEligible, selectBestWithdrawal, RECOVERY_THRESHOLD_MS } from "../presigned-broadcast.mjs";
import { updateRegistry, bundleKey, ACTIVE_CLAIM_CONFLICT } from "../presigned-store.mjs";
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

  // Observation (2026-09-24): broadcast thành công phải để lại dấu vết trong
  // logs — claim (nonce, tier) và terminal (market, txHash, tier, nonce).
  it("logs claim and terminal broadcast with market/txHash/tier/nonce", async () => {
    const filePath = tempRegistryPath();
    const tx = "0xdead";
    seedRegistry(filePath, { version: 2, bundles: { a: pending(7, tx) } });
    const lines = [];
    const logger = { log: (m) => lines.push(String(m)), warn: () => {}, error: () => {} };
    const client = { getTransactionCount: async () => 7, sendRawTransaction: async () => "ignored", waitForTransactionReceipt: async () => minedReceipt("success") };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["a", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true, logger });
    expect(lines.some((l) => l.includes("claiming a") && l.includes("nonce 7") && l.includes("tier small"))).toBe(true);
    expect(lines.some((l) => l.includes("broadcast submitted") && l.includes("market=a") && l.includes("tier=small") && l.includes("nonce=7"))).toBe(true);
    expect(lines.some((l) => l.includes("txHash="))).toBe(true);
  });

  it("logs nothing on a same-nonce conflict (fail closed stays quiet-ish)", async () => {
    const filePath = tempRegistryPath();
    const tx1 = "0x01";
    seedRegistry(filePath, { version: 2, bundles: { a: { ...pending(7, tx1), status: "broadcasting", broadcastingAt: new Date().toISOString(), rawTx: tx1, txHash: keccak256(tx1) } } });
    const lines = [];
    const logger = { log: (m) => lines.push(String(m)), warn: () => {}, error: () => {} };
    // Registry has one active claim; a second pending bundle at the SAME nonce
    // would violate the one-claim invariant — but here we assert that a plain
    // reconcile run logs no claim line (claim already exists, not newly claimed).
    const client = { getTransactionCount: async () => 7 };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true, logger });
    expect(lines.filter((l) => l.includes("claiming "))).toHaveLength(0);
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

describe("multi-nonce ladder (v3, 2026-09-24)", () => {
  // Bậc thang nonce: nhiều bundle (market khác nhau hoặc cùng market) tồn tại
  // đồng thời ở nonce liên tiếp. Broadcast luôn claim đúng nonce == on-chain
  // pending ⇒ tự động theo thứ tự nonce tăng dần; rung nonce cao hơn CHỜ.
  it("ladder 2 nonce: chỉ nonce thấp nhất (== pending) được claim, rung cao hơn giữ pending", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: {
      a: pending(7),                       // == pending nonce → claimable
      ["b@8"]: { marketId: "b", nonce: 8, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x02" }] },
    } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: vi.fn(), waitForTransactionReceipt: async () => minedReceipt("success") };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["a", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.a.status).toBe("submitted");
    expect(stored.bundles["b@8"].status).toBe("pending"); // rung cao hơn chờ
  });

  it("nonce tăng lên: rung kế tiếp trở thành claimable ở chu kỳ sau", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: {
      done: { marketId: "a", nonce: 7, status: "submitted", txHash: keccak256(stringToHex("mined")), withdrawals: [] },
      ["b@8"]: { marketId: "b", nonce: 8, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x02" }] },
    } });
    const client = { getTransactionCount: async () => 8, sendRawTransaction: vi.fn(), waitForTransactionReceipt: async () => minedReceipt("success") };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["b", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["b@8"].status).toBe("submitted");
  });

  it("hết hạn theo on-chain nonce: pending nonce nhảy qua rung → rung expired", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: {
      ["a@7"]: { marketId: "a", nonce: 7, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x01" }] },
      ["b@8"]: { marketId: "b", nonce: 8, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x02" }] },
    } });
    // Nonce on-chain nhảy thẳng lên 9 (tx ngoài, ví dụ thủ công) — CẢ HAI rung
    // đều đã bị vượt qua ⇒ expired (đây là nghĩa "hết hạn dựa trên onchain nonce").
    const client = { getTransactionCount: async () => 9, sendRawTransaction: vi.fn() };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["a", snapshot], ["b", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["a@7"].status).toBe("expired");
    expect(stored.bundles["b@8"].status).toBe("expired");
  });

  it("migrate v2 → v3: giữ nguyên key, stamp marketId từ key, version 3 khi ghi", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: { a: pending(7) } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: vi.fn(), waitForTransactionReceipt: async () => minedReceipt("success") };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["a", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.version).toBe(3);
    expect(stored.bundles.a.marketId).toBe("a"); // stamped, key giữ nguyên
    expect(stored.bundles.a.status).toBe("submitted");
  });

  it("cùng market nhiều nonce: mọi rung của market được nhận diện qua marketId field", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 2, bundles: {
      ["a@7"]: { marketId: "a", nonce: 7, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x01" }] },
      ["a@8"]: { marketId: "a", nonce: 8, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x02" }] },
    } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: vi.fn(), waitForTransactionReceipt: async () => minedReceipt("success") };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["a", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["a@7"].status).toBe("submitted");
    // Sibling cùng nonce (không có ở đây) sẽ expired; rung 8 giữ pending.
    expect(stored.bundles["a@8"].status).toBe("pending");
  });

  // P0 regression (audit 2026-09-24) — production contract: snapshots key theo
  // MARKET ID (contract của market-reader), registry key composite `marketId@nonce`
  // (webapp ghi qua bundleKey). Trước fix: registry.bundles[marketId] = undefined
  // ⇒ không bao giờ claim được — bundle ký mới qua webapp kẹt pending vĩnh viễn.
  it("P0 regression: snapshot key = marketId, registry key = marketId@nonce → claim + broadcast", async () => {
    const filePath = tempRegistryPath();
    const key = bundleKey("m1", 7);
    seedRegistry(filePath, { version: 3, bundles: {
      [key]: { marketId: "m1", nonce: 7, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x01" }] },
    } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: vi.fn(), waitForTransactionReceipt: async () => minedReceipt("success") };
    const claim = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["m1", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(claim.id).toBe(key); // registry key (opaque)
    expect(claim.marketId).toBe("m1"); // marketId từ VALUE
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles[key].status).toBe("submitted");
    expect(stored.bundles[key].marketId).toBe("m1");
  });

  // AUDIT F4 (2026-09-24): terminal transition phải expire sibling cùng nonce
  // CỦA CLAIM, không phải sibling của "pending nonce hiện tại". Khi claim nonce 7
  // đang nằm trong mempool, getTransactionCount(pending) trả 8 (tx của chính nó
  // được tính) ⇒ nếu code dùng biến `nonce` (pending), nó expire rung 8 vừa được
  // ký — rung hoàn toàn hợp lệ và chính là bậc thang kế tiếp.
  it("F4: reconcile claim nonce 7 không được expire rung hợp lệ ở nonce 8", async () => {
    const filePath = tempRegistryPath();
    const tx = stringToHex("mined-claim");
    seedRegistry(filePath, { version: 3, bundles: {
      ["a@7"]: { marketId: "a", nonce: 7, status: "broadcasting", broadcastingAt: new Date().toISOString(), broadcastingTier: "small", rawTx: tx, txHash: keccak256(tx), withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }] },
      ["b@8"]: { marketId: "b", nonce: 8, status: "pending", withdrawals: [{ label: "next", amountWei: "50", signedTx: "0x02" }] },
    } });
    // Claim nonce 7 đã mine (receipt có block identity) và tx của nó được tính
    // vào pending nonce ⇒ pending = 8.
    const client = { getTransactionCount: async () => 8, getTransactionReceipt: async () => minedReceipt("success") };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["b", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["a@7"].status).toBe("submitted");
    // Rung 8 chưa bị tiêu thụ bởi bất kỳ tx nào ⇒ phải giữ nguyên pending.
    expect(stored.bundles["b@8"].status).toBe("pending");
  });

  it("P0 regression: verifyBundle nhận marketId từ VALUE, không bao giờ nhận composite key", async () => {
    const filePath = tempRegistryPath();
    const key = bundleKey("m1", 7);
    seedRegistry(filePath, { version: 3, bundles: {
      [key]: { marketId: "m1", nonce: 7, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x01" }] },
    } });
    const seenIds = [];
    const verifyBundle = async (_bundle, id) => { seenIds.push(id); return { ok: true }; };
    const client = { getTransactionCount: async () => 7, sendRawTransaction: vi.fn(), waitForTransactionReceipt: async () => minedReceipt("success") };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["m1", snapshot]]), updateRegistry, verifyBundle, isEligible: () => true });
    // "m1@7" sẽ làm verify thật từ chối bundle (P0 part 2) — phải là "m1".
    expect(seenIds).toEqual(["m1"]);
  });
});

describe("R1 — nhả claim chết (nonce đã bị tx KHÁC tiêu thụ)", () => {
  // Trước fix: claim mà nonce đã bị tx khác chiếm giữ `broadcasting` vĩnh viễn
  // (mọi lần rebroadcast chỉ nhận "nonce too low") và chặn MỌI rung sau trong
  // bậc thang; webapp cũng không ký lại/xoá được (guard 409).
  const oldEnough = () => new Date(Date.now() - RECOVERY_THRESHOLD_MS - 5000).toISOString();
  const liveClaim = (tx) => ({
    marketId: "a", nonce: 7, status: "broadcasting", broadcastingAt: oldEnough(),
    broadcastingTier: "small", rawTx: tx, txHash: keccak256(tx),
    withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }],
  });
  const nextRung = () => ({
    marketId: "b", nonce: 8, status: "pending",
    withdrawals: [{ label: "next", amountWei: "50", signedTx: "0x02" }],
  });

  it("(a) receipt null + latest > nonce ⇒ superseded, và rung kế tiếp được claim ở chu kỳ sau", async () => {
    const filePath = tempRegistryPath();
    const tx = stringToHex("dead-claim");
    seedRegistry(filePath, { version: 3, bundles: { ["a@7"]: liveClaim(tx), ["b@8"]: nextRung() } });

    const blockTags = [];
    const send = vi.fn(async () => "0xaccepted");
    const client = {
      getTransactionCount: async ({ blockTag }) => { blockTags.push(blockTag); return 8; },
      getTransactionReceipt: async () => null, // null = không tìm thấy (KHÔNG phải lỗi RPC)
      sendRawTransaction: send,
      waitForTransactionReceipt: async () => minedReceipt(),
    };
    const c1 = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["b", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(c1.superseded).toBe(true);
    // Bằng chứng phải dùng nonce ĐÃ MINE ("latest"), không phải pending.
    expect(blockTags).toContain("latest");
    // Nonce đã tiêu thụ ⇒ không rebroadcast vô ích.
    expect(send).not.toHaveBeenCalled();

    let stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["a@7"].status).toBe("superseded");
    expect(stored.bundles["a@7"].rawTx).toBeUndefined();
    expect(typeof stored.bundles["a@7"].terminalAt).toBe("string");
    expect(String(stored.bundles["a@7"].reason)).toContain("nonce");

    // Chu kỳ kế tiếp với CÙNG registry: bậc thang phải tiến lên b@8.
    const sends = [];
    const client2 = {
      getTransactionCount: async () => 8,
      sendRawTransaction: async ({ serializedTransaction }) => { sends.push(serializedTransaction); return "0xaccepted"; },
      waitForTransactionReceipt: async () => minedReceipt(),
    };
    const c2 = await broadcastEligible({ client: client2, lenderAddress: "x", filePath, snapshots: new Map([["b", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(c2.id).toBe("b@8");
    expect(sends).toEqual(["0x02"]);
    stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["b@8"].status).toBe("submitted");
  });

  it("(b) lỗi RPC khi đọc receipt ⇒ KHÔNG thu thập bằng chứng, giữ broadcasting (fail closed)", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 3, bundles: { ["a@7"]: liveClaim(stringToHex("rpc-error")) } });
    const blockTags = [];
    const client = {
      // latest > nonce — nhưng KHÔNG được dùng vì lần đọc receipt đã lỗi.
      getTransactionCount: async ({ blockTag }) => { blockTags.push(blockTag); return 99; },
      getTransactionReceipt: async () => { throw new Error("socket hang up"); },
      sendRawTransaction: vi.fn(async () => { throw new Error("nonce too low"); }),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const claim = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(claim.stuck).toBe(false);
    expect(blockTags).toEqual(["pending"]); // không có lần đọc "latest" nào
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["a@7"].status).toBe("broadcasting");
  });

  it("(c) receipt null nhưng nonce CHƯA bị tiêu thụ (latest == nonce) ⇒ giữ claim, vẫn rebroadcast", async () => {
    const filePath = tempRegistryPath();
    const tx = stringToHex("still-mine");
    seedRegistry(filePath, { version: 3, bundles: { ["a@7"]: liveClaim(tx) } });
    const blockTags = [];
    const send = vi.fn(async () => "0xrebroadcast");
    const client = {
      getTransactionCount: async ({ blockTag }) => { blockTags.push(blockTag); return 7; },
      getTransactionReceipt: async () => null,
      sendRawTransaction: send,
    };
    const claim = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(claim.superseded).toBeUndefined();
    expect(blockTags).toContain("latest"); // đã thử thu thập bằng chứng...
    expect(send).toHaveBeenCalledWith({ serializedTransaction: tx }); // ...nhưng vẫn đi đường rebroadcast
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["a@7"].status).toBe("broadcasting");
  });

  it("(d) receipt mine đúng hash ⇒ submitted (bằng chứng chết không chen ngang)", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 3, bundles: { ["a@7"]: liveClaim(stringToHex("mined")) } });
    const client = { getTransactionCount: async () => 99, getTransactionReceipt: async () => minedReceipt("success") };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["a@7"].status).toBe("submitted");
  });

  it("(e) nonce của claim đã nhả vẫn tiêu thụ vĩnh viễn ⇒ không bao giờ claim lại rung cùng nonce", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 3, bundles: {
      ["a@7"]: { ...liveClaim(stringToHex("released")), status: "superseded", reason: "nonce consumed by another transaction", terminalAt: new Date().toISOString() },
      ["c@7"]: { marketId: "c", nonce: 7, status: "pending", withdrawals: [{ label: "stale", amountWei: "50", signedTx: "0x03" }] },
    } });
    const send = vi.fn();
    // Node trả pending = 7 (lagging) — luật `value < pending` KHÔNG bắt được rung
    // c@7, nên chỉ có "nonce đã tiêu thụ" (consumedNonce) mới cứu được.
    const client = { getTransactionCount: async () => 7, sendRawTransaction: send };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["c", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["c@7"].status).toBe("expired");
    expect(send).not.toHaveBeenCalled();
  });
});
