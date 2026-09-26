/**
 * Chẩn đoán 2026-09-26 — rung `expired` phải tự được dọn sau ân hạn, và mốc "nonce đã tiêu thụ"
 * phải sống sót qua việc xoá record (watermark `consumedNonce`).
 *
 * Bối cảnh (artifact thật của người dùng): `presigned.json` có `…@2550` status expired +
 * `withdrawals: []` nằm nguyên qua hơn một ngày, `consumedNonce: -1`; monitor coi registry là idle
 * (chỉ còn record `expired`) nên short-circuit trước cả nhánh dọn ⇒ record chết tích tụ mãi.
 *
 * Đỏ-trước: `purgeExpiredRungs` chưa tồn tại; expiry không ghi `expiredAt`; `broadcastEligible`
 * không dọn gì khi registry chỉ còn `expired`.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { broadcastEligible, purgeExpiredRungs } from "../presigned-broadcast.mjs";
import { updateRegistry } from "../presigned-store.mjs";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const silent = { log: () => {}, warn: () => {}, error: () => {} };

function tempRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-purge-"));
  return path.join(dir, "presigned.json");
}

function seed(filePath, registry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
}

const read = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

/** Đúng hình dạng `…@2550` trong presigned.json thật: expired, rỗng tier, tạo hôm trước. */
const expiredEmpty = () => ({
  marketId: "m1", nonce: 2550, status: "expired",
  createdAt: "2026-09-25T17:43:11.262Z",
  withdrawals: [],
});

const pendingAt = (nonce, extra = {}) => ({
  marketId: "m1", nonce, status: "pending",
  createdAt: "2026-09-26T05:04:14.155Z",
  withdrawals: [{ label: "t", amountWei: "50", signedTx: "0x01" }],
  ...extra,
});

describe("dọn rung expired (chẩn đoán 2026-09-26)", () => {
  it("P1 (đúng artifact): quá ân hạn ⇒ xoá, watermark nâng lên, rung pending không bị chạm", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 3, consumedNonce: -1, bundles: {
      "m1@2550": expiredEmpty(),
      "m1@2553": pendingAt(2553),
    } });

    const result = await purgeExpiredRungs({ filePath, updateRegistry, now: () => NOW, retentionMs: HOUR, logger: silent });
    expect(result.purged).toBe(1);

    const stored = read(filePath);
    expect(stored.bundles["m1@2550"]).toBeUndefined();
    expect(stored.bundles["m1@2553"].status).toBe("pending");
    // Không được mất ký ức "nonce đã tiêu thụ" khi xoá record (audit A.2).
    expect(stored.consumedNonce).toBeGreaterThanOrEqual(2550);
  });

  it("P2: còn trong ân hạn (expiredAt 10 phút) ⇒ giữ lại", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 3, consumedNonce: -1, bundles: {
      "m1@2550": { ...expiredEmpty(), expiredAt: new Date(NOW - 10 * 60_000).toISOString() },
    } });

    const result = await purgeExpiredRungs({ filePath, updateRegistry, now: () => NOW, retentionMs: HOUR, logger: silent });
    expect(result.purged).toBe(0);
    expect(read(filePath).bundles["m1@2550"].status).toBe("expired");
  });

  it("P3: chỉ chạm record expired — pending/broadcasting/terminal giữ nguyên", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 3, consumedNonce: -1, bundles: {
      "m1@2550": expiredEmpty(),
      "m1@2551": pendingAt(2551),
      "m1@2552": { marketId: "m1", nonce: 2552, status: "broadcasting", broadcastingAt: "2026-09-25T00:00:00.000Z", withdrawals: [] },
      "m1@2553": { marketId: "m1", nonce: 2553, status: "submitted", terminalAt: "2026-09-25T00:00:00.000Z", withdrawals: [] },
    } });

    expect((await purgeExpiredRungs({ filePath, updateRegistry, now: () => NOW, retentionMs: HOUR, logger: silent })).purged).toBe(1);
    const stored = read(filePath);
    expect(Object.keys(stored.bundles).sort()).toEqual(["m1@2551", "m1@2552", "m1@2553"]);
  });

  it("P4: thiếu mọi mốc thời gian ⇒ fail closed (giữ lại, không xoá mù)", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 3, consumedNonce: -1, bundles: {
      "m1@2550": { marketId: "m1", nonce: 2550, status: "expired", withdrawals: [] },
    } });

    expect((await purgeExpiredRungs({ filePath, updateRegistry, now: () => NOW, retentionMs: HOUR, logger: silent })).purged).toBe(0);
    expect(read(filePath).bundles["m1@2550"].status).toBe("expired");
  });

  it("P5: broadcastEligible dọn cả khi registry IDLE (chỉ còn expired) — không tốn RPC", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 3, consumedNonce: -1, bundles: { "m1@2550": expiredEmpty() } });
    let nonceReads = 0;
    const client = { getTransactionCount: async () => { nonceReads++; return 2553n; } };

    const result = await broadcastEligible({
      client, lenderAddress: "x", filePath, snapshots: new Map(),
      updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true,
      now: () => NOW, logger: silent, expiredRetentionMs: HOUR,
    });

    expect(result.idle).toBe(true);
    expect(nonceReads).toBe(0);
    expect(read(filePath).bundles["m1@2550"]).toBeUndefined();
  });

  it("P6: nhánh expire theo on-chain nonce ghi thêm expiredAt (mốc để đo ân hạn)", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 3, consumedNonce: -1, bundles: { "m1@5": pendingAt(5) } });
    const client = { getTransactionCount: async () => 7n };

    await broadcastEligible({
      client, lenderAddress: "x", filePath, snapshots: new Map(),
      updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true,
      now: () => NOW, logger: silent,
    });

    const stored = read(filePath);
    expect(stored.bundles["m1@5"].status).toBe("expired");
    expect(stored.bundles["m1@5"].expiredAt).toBe(new Date(NOW).toISOString());
  });

  it("P7: lock/hỏng registry KHÔNG được xuyên ra ngoài — purge là best-effort, trả 0 và warn", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 3, consumedNonce: -1, bundles: { "m1@2550": expiredEmpty() } });
    for (const code of ["LOCK_STALE", "ENOENT"]) {
      const warnings = [];
      const locked = async () => {
        const err = new Error(`Could not acquire lock (${code})`);
        err.code = code;
        throw err;
      };

      const result = await purgeExpiredRungs({
        filePath, updateRegistry: locked, now: () => NOW, retentionMs: HOUR,
        logger: { log: () => {}, warn: (m) => warnings.push(String(m)), error: () => {} },
      });

      expect(result.purged).toBe(0);
      expect(warnings.join("\n"), "phải nói rõ vì sao bỏ lượt dọn").toMatch(/purge/);
      expect(read(filePath).bundles["m1@2550"].status, "record còn nguyên, chờ lượt sau").toBe("expired");
    }
  });

  it("P8: chu kỳ IDLE vẫn hoàn tất khi purge không lấy được lock (trước fix: cả chu kỳ ném)", async () => {
    const filePath = tempRegistry();
    seed(filePath, { version: 3, consumedNonce: -1, bundles: { "m1@2550": expiredEmpty() } });
    const warnings = [];
    const locked = async () => {
      const err = new Error("Could not acquire lock after 50 attempts");
      err.code = "LOCK_STALE";
      throw err;
    };
    const client = { getTransactionCount: async () => { throw new Error("idle ⇒ không được đọc RPC"); } };

    const result = await broadcastEligible({
      client, lenderAddress: "x", filePath, snapshots: new Map(),
      updateRegistry: locked, verifyBundle: async () => ({ ok: true }), isEligible: () => true,
      now: () => NOW, expiredRetentionMs: HOUR,
      logger: { log: () => {}, warn: (m) => warnings.push(String(m)), error: () => {} },
    });

    expect(result.idle).toBe(true);
    expect(result.purged).toBe(0);
    expect(warnings.join("\n")).toMatch(/purge/);
  });
});
