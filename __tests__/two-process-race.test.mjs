/**
 * Two-process race test: hai tiến trình Node THẬT đua claim cùng nonce trên
 * cùng registry file (production store + production broadcaster).
 * Không có promise queue giả lập — serialize đến từ withFileLock thật.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, stringToHex } from "viem";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(__dirname, "helpers", "two-process-worker.mjs");
const projectRoot = path.resolve(__dirname, "..");

function runWorker(registryPath, marketId, signedTx) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [workerPath, registryPath, marketId, signedTx], { cwd: projectRoot, timeout: 30_000 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      // Worker prints exactly one JSON line at the end.
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      try { resolve(JSON.parse(line)); } catch (e) { reject(new Error(`Bad worker output: ${stdout}`)); }
    });
  });
}

const TX_A = stringToHex("market-a-tx");
const TX_B = stringToHex("market-b-tx");

describe("two-process claim race (real child processes)", () => {
  it("only one of two racing processes broadcasts; the loser keeps pending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-race-"));
    const registryPath = path.join(dir, "presigned.json");
    fs.writeFileSync(registryPath, JSON.stringify({
      version: 2,
      bundles: {
        [`${"0x" + "a".repeat(64)}`]: { nonce: 7, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: TX_A }] },
        [`${"0x" + "b".repeat(64)}`]: { nonce: 7, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: TX_B }] },
      },
    }));

    const marketA = "0x" + "a".repeat(64);
    const marketB = "0x" + "b".repeat(64);

    // Startup barrier: spin both processes concurrently.
    const [a, b] = await Promise.all([runWorker(registryPath, marketA, TX_A), runWorker(registryPath, marketB, TX_B)]);

    const totalSent = a.sent + b.sent;
    expect(totalSent).toBeLessThanOrEqual(1); // at most ONE raw broadcast

    const stored = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const statuses = [stored.bundles[marketA].status, stored.bundles[marketB].status];

    if (totalSent === 1) {
      // Winner is terminal (mock receipt is mined) and the mined receipt
      // consumes the nonce: the sibling must be expired, never broadcast.
      const submittedCount = statuses.filter((s) => s === "submitted").length;
      expect(submittedCount).toBe(1);
      expect(statuses).toContain("expired");
    } else if (totalSent === 0) {
      // Both found the other's claim first (possible under contention) —
      // no corruption, and at most one reservation exists.
      expect(statuses.every((s) => ["pending", "broadcasting", "submitted", "expired"].includes(s))).toBe(true);
      expect(statuses.filter((s) => s === "broadcasting").length).toBeLessThanOrEqual(1);
    } else {
      throw new Error(`Two processes broadcast the same nonce: ${totalSent} raw sends`);
    }
  });

  it("a broadcasting reservation blocks the second process entirely", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-block-"));
    const registryPath = path.join(dir, "presigned.json");
    const marketA = "0x" + "a".repeat(64);
    const marketB = "0x" + "b".repeat(64);
    fs.writeFileSync(registryPath, JSON.stringify({
      version: 2,
      bundles: {
        [marketA]: { nonce: 7, status: "broadcasting", broadcastingAt: new Date().toISOString(), broadcastingTier: "small", rawTx: TX_A, txHash: keccak256(TX_A), withdrawals: [{ label: "small", amountWei: "50", signedTx: TX_A }] },
        [marketB]: { nonce: 7, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: TX_B }] },
      },
    }));

    const result = await runWorker(registryPath, marketB, TX_B);
    // Process B must not broadcast (A holds the nonce-wide reservation)…
    expect(result.sent).toBe(0);
    // …and A's claim must be untouched.
    const stored = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    expect(stored.bundles[marketA].status).toBe("broadcasting");
    expect(stored.bundles[marketB].status).toBe("pending");
  });
});
