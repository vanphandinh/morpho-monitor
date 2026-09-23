/**
 * Expiration behavior of the PRODUCTION broadcaster (presigned-broadcast.mjs).
 * Bản cũ copy logic expireStaleBundle từ monitor v1 — đã thay bằng import
 * production lifecycle: pending dưới nonce hiện tại bị expire, claim đang mở
 * (broadcasting) KHÔNG bao giờ bị expire theo nonce.
 *
 * Audit 2026-09-23 (C2): record terminal (submitted/failed) là LỊCH SỬ trơ —
 * nonce của nó vĩnh viễn đã tiêu thụ, nhưng nó không được phép chặn claim mới.
 */
import { describe, it, expect, vi } from "vitest";
import { stringToHex, keccak256 } from "viem";
import { broadcastEligible } from "../presigned-broadcast.mjs";
import { updateRegistry } from "../presigned-store.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const snapshot = { market: { liquidity: 100n, totalSupplyAssets: 100n, totalSupplyShares: 100n }, position: { supplyAssets: 1000n } };

function tempRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expire-"));
  return path.join(dir, "presigned.json");
}

function seed(filePath, registry) {
  fs.writeFileSync(filePath, JSON.stringify(registry));
  return registry;
}

const pending50 = (nonce, tx = "0x01") => ({ nonce, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }] });

describe("production expiration semantics", () => {
  it("expires only pending bundles below the current nonce; future nonce is retained", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 2, bundles: { past: pending50(5), current: pending50(7), future: pending50(9) } });
    const client = { getTransactionCount: async () => 7, sendRawTransaction: vi.fn().mockRejectedValue(new Error("timeout")) };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["current", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.past.status).toBe("expired");
    expect(stored.bundles.current.status).toBe("broadcasting"); // claimed, send ambiguous
    expect(stored.bundles.future.status).toBe("pending");
  });

  it("never expires a broadcasting reservation even when the pending nonce advanced", async () => {
    const filePath = tempRegistry();
    const tx = stringToHex("reserved");
    seed(filePath, { version: 2, bundles: { reserved: { nonce: 5, status: "broadcasting", broadcastingAt: new Date().toISOString(), broadcastingTier: "small", rawTx: tx, txHash: keccak256(tx), withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }] } } });
    const client = { getTransactionCount: async () => 9, getTransactionReceipt: async () => { throw new Error("not mined"); }, sendRawTransaction: async () => { throw new Error("down"); } };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.reserved.status).toBe("broadcasting");
  });

  it("never expires a submitted reservation even when the pending nonce advanced", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 2, bundles: { done: { nonce: 3, status: "submitted", txHash: "0x" + "c".repeat(64), withdrawals: [] } } });
    const client = { getTransactionCount: async () => 9, sendRawTransaction: vi.fn() };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.done.status).toBe("submitted");
  });

  it("C2: terminal history không wedged registry — bundle pending mới vẫn được broadcast", async () => {
    const filePath = tempRegistry();
    // Y nguyên repro C2: 1 submitted (đã bị xoá rawTx) + 1 pending đủ điều kiện.
    seed(filePath, { version: 2, bundles: {
      done: { nonce: 7, status: "submitted", txHash: "0x" + "c".repeat(64), terminalAt: "2026-09-23T00:00:00.000Z", withdrawals: [{ label: "t", amountWei: "50", signedTx: "0x01" }] },
      next: pending50(8, "0xdead"),
    } });
    const client = { getTransactionCount: async () => 8, sendRawTransaction: vi.fn(), waitForTransactionReceipt: async () => ({ status: "success", blockHash: "0x" + "a".repeat(64), blockNumber: 1n, transactionHash: "0x" + "b".repeat(64) }) };
    const result = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["next", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(result.stuck).toBe(false);
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.next.status).toBe("submitted");
  });

  it("nonce của terminal vẫn đã tiêu thụ: pending <= max terminal nonce bị expire", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 2, bundles: {
      done: { nonce: 7, status: "failed", txHash: "0x" + "c".repeat(64), withdrawals: [] },
      sameNonce: pending50(7),
      below: pending50(6),
      ahead: pending50(8),
    } });
    const client = { getTransactionCount: async () => 8, sendRawTransaction: vi.fn() };
    await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles.done.status).toBe("failed"); // terminal không bị đổi
    expect(stored.bundles.sameNonce.status).toBe("expired");
    expect(stored.bundles.below.status).toBe("expired");
    expect(stored.bundles.ahead.status).toBe("pending");
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("hai terminal cùng nonce không tạo conflict và không sinh warning", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 2, bundles: {
      a: { nonce: 7, status: "submitted", txHash: "0x" + "c".repeat(64), withdrawals: [] },
      b: { nonce: 7, status: "failed", txHash: "0x" + "d".repeat(64), withdrawals: [] },
      next: pending50(8),
    } });
    const client = { getTransactionCount: async () => 8, sendRawTransaction: vi.fn(), waitForTransactionReceipt: async () => ({ status: "success", blockHash: "0x" + "a".repeat(64), blockNumber: 1n, transactionHash: "0x" + "b".repeat(64) }) };
    const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    const result = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map([["next", snapshot]]), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true, logger });
    expect(result.conflict).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("khi không còn gì để claim, diagnostic nói rõ đây là terminal history", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 2, bundles: { done: { nonce: 7, status: "submitted", txHash: "0x" + "c".repeat(64), withdrawals: [] } } });
    const client = { getTransactionCount: async () => 9, sendRawTransaction: vi.fn() };
    const result = await broadcastEligible({ client, lenderAddress: "x", filePath, snapshots: new Map(), updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true });
    expect(result.stuck).toBe(false);
    expect(result.terminalSummary).toEqual({ count: 1, consumedNonce: 7 });
    expect(result.diagnostic).toMatch(/terminal bundle\(s\) are history/);
  });
});
