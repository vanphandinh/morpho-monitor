import { describe, it, expect, vi } from "vitest";
import { keccak256, stringToHex, TransactionReceiptNotFoundError } from "viem";
import { broadcastEligible, RECOVERY_THRESHOLD_MS, EVIDENCE_CONFIRMATIONS } from "../presigned-broadcast.mjs";
import { updateRegistry, readRegistry, consumedWatermark } from "../presigned-store.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A.2 — Bất biến "nonce đã tiêu thụ vĩnh viễn" không được nằm trong thứ user xoá được.
 *
 * Trước fix, `consumedNonce` được TÍNH LẠI từ record terminal mỗi chu kỳ. Mà
 * record terminal/expired là thứ user ĐƯỢC PHÉP xoá (quyết định M1: không có
 * retention policy thì file phình vô hạn). Xoá record ⇒ mất mốc ⇒ một rung
 * `pending` ở nonce đã tiêu thụ có thể được claim lại: gửi lại chữ ký đã chết,
 * nhận `nonce too low`, claim bị giữ lại ~180s và bậc thang đứng yên.
 */

const snapshot = { market: { liquidity: 100n, totalSupplyAssets: 100n, totalSupplyShares: 100n } };
const minedReceipt = (status = "success") => ({ status, blockHash: "0x" + "a".repeat(64), blockNumber: 1n, transactionHash: "0x" + "b".repeat(64) });
const receiptNotFound = () => { throw new TransactionReceiptNotFoundError({ hash: "0x" + "c".repeat(64) }); };

function tempRegistryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-watermark-"));
  return path.join(dir, "presigned.json");
}

function seedRegistry(filePath, registry) {
  fs.writeFileSync(filePath, JSON.stringify(registry));
  return registry;
}

const readFile = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const terminalBundle = (marketId, nonce, status = "submitted") => ({
  marketId, nonce, status, terminalAt: new Date().toISOString(),
  withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x01" }],
});
const broadcastingClaim = (marketId, nonce) => {
  const tx = stringToHex(`dead-${marketId}-${nonce}`);
  return {
    marketId, nonce, status: "broadcasting",
    broadcastingAt: new Date(Date.now() - RECOVERY_THRESHOLD_MS - 5000).toISOString(),
    broadcastingTier: "small", rawTx: tx, txHash: keccak256(tx),
    withdrawals: [{ label: "small", amountWei: "50", signedTx: tx }],
  };
};
const pendingBundle = (marketId, nonce) => ({
  marketId, nonce, status: "pending",
  withdrawals: [{ label: "small", amountWei: "50", signedTx: "0x02" }],
});

const runCycle = (filePath, client, snapshots) => broadcastEligible({
  client, lenderAddress: "x", filePath, snapshots,
  updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true,
});

describe("A.2 — watermark consumedNonce (registry)", () => {
  it("user xoá HẾT record terminal ⇒ rung pending ở nonce đã tiêu thụ VẪN bị expired", async () => {
    const filePath = tempRegistryPath();
    // (1) Một chu kỳ terminal ở nonce 7 (tx mine) ⇒ mốc phải được ghi lại.
    seedRegistry(filePath, { version: 3, bundles: { "a@7": broadcastingClaim("a", 7) } });
    await runCycle(filePath, { getTransactionCount: async () => 8, getTransactionReceipt: async () => minedReceipt("success") }, new Map());
    expect(readFile(filePath).bundles["a@7"].status).toBe("submitted");
    expect(readFile(filePath).consumedNonce).toBe(7);

    // (2) User dọn lịch sử: xoá mọi record không phải claim đang bay (M1).
    await updateRegistry(filePath, (registry) => {
      for (const [key, bundle] of Object.entries(registry.bundles)) {
        if (bundle.status !== "broadcasting") delete registry.bundles[key];
      }
    }, { origin: "user" });
    expect(readFile(filePath).bundles).toEqual({});
    expect(readFile(filePath).consumedNonce).toBe(7); // ký ức còn nguyên

    // (3) Một rung pending ở nonce 7 xuất hiện lại (copy registry giữa hai môi
    //     trường, hoặc ký lại khi node đang tụt hậu).
    await updateRegistry(filePath, (registry) => {
      registry.bundles["b@7"] = pendingBundle("b", 7);
    }, { origin: "user" });

    // (4) Node tụt hậu: pending nonce vẫn là 7 ⇒ rule `value < nonce` KHÔNG bắt
    //     được; chỉ còn mốc tiêu thụ cứu.
    const send = vi.fn(async () => "0xaccepted");
    const client = { getTransactionCount: async () => 7, sendRawTransaction: send };
    await runCycle(filePath, client, new Map([["b", snapshot]]));

    expect(readFile(filePath).bundles["b@7"].status).toBe("expired");
    expect(send).not.toHaveBeenCalled();
  });

  it("mốc KHÔNG BAO GIỜ lùi — kể cả khi mutation xoá record hoặc cố set thấp hơn", async () => {
    const filePath = tempRegistryPath();
    seedRegistry(filePath, { version: 3, consumedNonce: 9, bundles: { "a@9": terminalBundle("a", 9) } });

    await updateRegistry(filePath, (registry) => {
      delete registry.bundles["a@9"];
      registry.consumedNonce = 0;
    });
    expect(readFile(filePath).consumedNonce).toBe(9);

    await updateRegistry(filePath, (registry) => { registry.consumedNonce = undefined; });
    expect(readFile(filePath).consumedNonce).toBe(9);

    // User origin cũng không hạ được sàn.
    await updateRegistry(filePath, (registry) => { registry.consumedNonce = -1; }, { origin: "user" });
    expect(readFile(filePath).consumedNonce).toBe(9);
  });

  it("registry v3 cũ KHÔNG có field ⇒ suy từ record terminal, và persist ở lần write kế tiếp", async () => {
    const filePath = tempRegistryPath();
    // Không có `consumedNonce` — đúng hình dạng file trước bản vá này.
    seedRegistry(filePath, { version: 3, bundles: { "a@7": terminalBundle("a", 7, "failed") } });

    const registry = readRegistry(filePath);
    expect(registry.consumedNonce).toBe(7);
    expect(consumedWatermark(registry)).toBe(7);

    await updateRegistry(filePath, () => {});
    expect(readFile(filePath).consumedNonce).toBe(7);
  });

  it("mọi đường terminal đều TIẾN mốc: failed và superseded (submitted đã ở test đầu)", async () => {
    const failedPath = tempRegistryPath();
    seedRegistry(failedPath, { version: 3, bundles: { "a@7": broadcastingClaim("a", 7) } });
    await runCycle(failedPath, { getTransactionCount: async () => 8, getTransactionReceipt: async () => minedReceipt("reverted") }, new Map());
    expect(readFile(failedPath).bundles["a@7"].status).toBe("failed");
    expect(readFile(failedPath).consumedNonce).toBe(7);

    const supersededPath = tempRegistryPath();
    seedRegistry(supersededPath, { version: 3, bundles: { "a@7": broadcastingClaim("a", 7) } });
    const claim = await runCycle(supersededPath, {
      // Bằng chứng R1: receipt NOT FOUND (hình dạng viem) + nonce đã tiêu thụ ở
      // block đã lùi (head 100 − EVIDENCE_CONFIRMATIONS).
      getBlockNumber: async () => 100n,
      getTransactionCount: async ({ blockTag }) => (blockTag ? 7 : 8),
      getTransactionReceipt: async () => receiptNotFound(),
      sendRawTransaction: vi.fn(),
    }, new Map());
    expect(claim.superseded).toBe(true);
    expect(readFile(supersededPath).bundles["a@7"].status).toBe("superseded");
    expect(readFile(supersededPath).consumedNonce).toBe(7);
    expect(EVIDENCE_CONFIRMATIONS).toBe(2); // neo head-2 như D6
  });
});
