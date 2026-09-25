/**
 * Round-4 audit (quota RPC, 2026-09-25): broadcastEligible chạy MỖI chu kỳ
 * monitor (30s) và trước đây luôn trả phí 1 `eth_getTransactionCount` ngay cả
 * khi registry trống — ~2.880 request/ngày để... làm gì cũng không.
 *
 * Hợp đồng ghim:
 * 1. Registry không có pending (nonce hữu hạn) và không có claim broadcasting
 *    ⇒ KHÔNG có RPC call nào trong chu kỳ đó (idle short-circuit).
 * 2. Có pending hoặc broadcasting ⇒ pipeline như cũ (đọc nonce, claim, ...).
 * 3. Registry hỏng/garbage ⇒ fail closed: phải đọc nonce (không short-circuit
 *    trên trạng thái không đáng tin).
 */
import { describe, expect, it, vi } from "vitest";
import { broadcastEligible } from "../presigned-broadcast.mjs";
import { updateRegistry } from "../presigned-store.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const snapshot = { market: { liquidity: 100n, totalSupplyAssets: 100n, totalSupplyShares: 100n } };

function tempRegistryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-idle-"));
  return path.join(dir, "presigned.json");
}

function seedRegistry(filePath, registry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(registry));
  return registry;
}

/** Client đếm MỌI lời gọi RPC qua Proxy — bất kỳ phương thức nào. */
function countingClient() {
  const calls = [];
  const handler = {
    get(_target, prop) {
      if (prop === "__calls") return calls;
      return vi.fn((...args) => {
        calls.push({ method: String(prop), args });
        return Promise.reject(new Error(`unexpected RPC call: ${String(prop)}`));
      });
    },
  };
  return new Proxy({}, handler);
}

const run = (client, filePath) =>
  broadcastEligible({
    client,
    lenderAddress: "0x" + "b".repeat(40),
    filePath,
    snapshots: new Map([["m1", snapshot]]),
    updateRegistry,
    verifyBundle: async () => ({ ok: true }),
    isEligible: () => true,
  });

describe("broadcastEligible — idle short-circuit (round-4 quota)", () => {
  it("registry KHÔNG TỒN TẠI ⇒ 0 RPC call", async () => {
    const filePath = tempRegistryPath();
    const client = countingClient();
    await run(client, filePath);
    expect(client.__calls).toEqual([]);
  });

  it("registry chỉ có terminal/expired ⇒ 0 RPC call (inert history)", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, {
      version: 3,
      consumedNonce: 7,
      bundles: {
        "m1@5": { marketId: "m1", nonce: 5, status: "submitted", txHash: "0x" + "1".repeat(64) },
        "m1@6": { marketId: "m1", nonce: 6, status: "expired" },
      },
    });
    const client = countingClient();
    await run(client, filePath);
    expect(client.__calls).toEqual([]);
  });

  it("registry garbage (v1) ⇒ fail closed: KHÔNG short-circuit trên trạng thái không đáng tin", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 1, bundles: {} });
    const client = countingClient();
    // readRegistry ném ⇒ broadcastEligible phải để lỗi lan ra (không im lặng
    // coi như idle — file hỏng có thể đang che một claim).
    await expect(run(client, filePath)).rejects.toBeDefined();
  });

  it("có bundle pending ⇒ pipeline như cũ: đọc nonce (≥1 RPC call)", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, {
      version: 3,
      consumedNonce: -1,
      bundles: {
        "m1@7": { marketId: "m1", nonce: 7, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x01" }] },
      },
    });
    const client = {
      getTransactionCount: vi.fn().mockResolvedValue(7),
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    await run(client, filePath);
    expect(client.getTransactionCount).toHaveBeenCalledTimes(1);
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles["m1@7"].status).toBe("broadcasting"); // claim giữ nguyên sau lỗi RPC
  });

  it("đang có claim broadcasting ⇒ không idle: reconcile receipt-first như cũ", async () => {
    const filePath = tempRegistryPath();
    const tx = "0xdead";
    seedRegistry(filePath, {
      version: 3,
      consumedNonce: -1,
      bundles: {
        "m1@7": { marketId: "m1", nonce: 7, status: "broadcasting", broadcastingAt: new Date().toISOString(), rawTx: tx, txHash: "0x" + "a".repeat(64) },
      },
    });
    // txHash không khớp keccak(rawTx) ⇒ stuck trước mọi RPC I/O, nhưng quan
    // trọng là KHÔNG rơi vào nhánh idle: phase 0 thấy `broadcasting` ⇒ chạy
    // pipeline (đọc nonce) rồi reconcile.
    const client = {
      getTransactionCount: vi.fn().mockResolvedValue(7),
    };
    const result = await run(client, filePath);
    expect(client.getTransactionCount).toHaveBeenCalledTimes(1); // đã vượt phase 0
    expect(result.stuck).toBe(true);
    expect(result.diagnostic).toMatch(/rawTx does not match|manual reconciliation/i);
  });
});
