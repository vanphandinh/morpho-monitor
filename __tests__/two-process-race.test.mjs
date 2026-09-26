/**
 * Two-process race test: hai tiến trình Node THẬT đua claim cùng nonce trên
 * cùng registry file (production store + production broadcaster).
 * Không có promise queue giả lập — serialize đến từ withFileLock thật.
 *
 * Chẩn đoán 2026-09-26 (flake `windows-latest`, từng làm CI #19 đỏ): khẳng định cũ
 * `expect(submittedCount).toBe(1)` giả định "ĐÚNG MỘT chu kỳ luôn hoàn tất terminal" — đó KHÔNG phải
 * hợp đồng của hệ thống. `broadcastEligible` chủ ý giữ claim khi kết quả mơ hồ ("ambiguity keeps the
 * claim") và hoàn tất ở chu kỳ sau; trên Windows còn thêm một đường mơ hồ thật: `writeRegistry` ghi
 * `.tmp` rồi `renameSync`, mà rename đè lên file đang được tiến trình anh em MỞ ĐỂ ĐỌC thì ném
 * `EPERM` (share mode của Windows; POSIX không quan tâm) ⇒ bước chốt terminal không chạy xong. Đã sửa
 * tận gốc ở `writeRegistry` (thử lại lỗi tạm thời — `__tests__/presigned-store-write-race.test.mjs`),
 * và ở đây khẳng định đúng HỢP ĐỒNG thay vì đúng một thời điểm: tối đa MỘT raw send, bên thua không
 * bao giờ thành `submitted`, và nếu claim còn sống thì bên thua phải còn `pending` (nonce CHƯA được
 * chứng minh là đã tiêu thụ nên không được đánh `expired`).
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
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`Bad worker output: ${stdout}`)); }
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
      // Khẳng định theo BÊN GỬI, không theo thời điểm. Ba trạng thái của bên gửi đều hợp lệ:
      //   `submitted`   — receipt mine thành công (bước chốt terminal đã chạy xong);
      //   `failed`      — receipt mine nhưng status ≠ success (nonce VẪN bị tiêu thụ — `isMinedReceipt`
      //                   chỉ đòi blockHash/blockNumber/transactionHash, không đòi status);
      //   `broadcasting`— bước chốt terminal CHƯA chạy xong (RPC mơ hồ, hoặc rename bị chặn tạm thời
      //                   trên Windows — xem đầu file): claim durable nằm lại theo thiết kế
      //                   "ambiguity keeps the claim" và chu kỳ sau hoàn tất nó.
      const sender = a.sent === 1 ? marketA : marketB;
      const loser = a.sent === 1 ? marketB : marketA;
      const senderStatus = stored.bundles[sender].status;
      const loserStatus = stored.bundles[loser].status;

      expect(["broadcasting", "submitted", "failed"]).toContain(senderStatus);
      // Bên KHÔNG gửi không bao giờ được terminal: nó chỉ được chờ (`pending`), hoặc bị đánh `expired`
      // khi nonce đã được chứng minh là tiêu thụ. `submitted` ở bên không gửi = broadcast cùng nonce.
      expect(["pending", "expired"]).toContain(loserStatus);

      if (senderStatus === "broadcasting") {
        // Chưa có bằng chứng nonce bị tiêu thụ ⇒ bên kia PHẢI còn `pending` (đánh `expired` ở đây sẽ
        // xoá mất một chữ ký còn dùng được), và claim phải giữ rawTx để chu kỳ sau chốt tiếp.
        expect(loserStatus).toBe("pending");
        expect(typeof stored.bundles[sender].rawTx, "claim sống phải còn rawTx").toBe("string");
      } else {
        // Receipt mine (thành công HAY thất bại) đều tiêu nonce ⇒ rung cùng nonce hết đường.
        expect(loserStatus).toBe("expired");
      }
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
