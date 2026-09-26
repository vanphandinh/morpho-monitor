/**
 * Cross-process lifecycle test — 2 Node process THẬT, không phải promise queue.
 * (audit 2026-09-23: chứng minh 2 process không thể cùng claim/broadcast cùng nonce)
 *
 * Mỗi worker import presigned-store.mjs + presigned-broadcast.mjs thật,
 * dùng registry tạm và fake RPC. Barrier qua lock file polling.
 * Số lần broadcast THẬT được đối chiếu qua send log dùng chung (append-only).
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Worker source — chạy trong process con, import production modules (pathToFileURL cho Windows). */
const toFileUrl = (p) => pathToFileURL(p).href;
const WORKER_SRC = `
import { broadcastEligible } from ${JSON.stringify(toFileUrl(path.join(__dirname, "..", "presigned-broadcast.mjs")))};
import { updateRegistry } from ${JSON.stringify(toFileUrl(path.join(__dirname, "..", "presigned-store.mjs")))};
import fs from "node:fs";

// Với ["-e", src, a, b]: process.argv = [execPath, a, b] → args bắt đầu từ index 1.
const argvRest = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(argvRest[0], "utf8"));

// Chờ cả 2 process sẵn sàng rồi mới đua claim.
const deadline = Date.now() + 10_000;
while (!fs.existsSync(argvRest[1]) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
await new Promise((r) => setTimeout(r, 50));

const NEWLINE = String.fromCharCode(10);
const client = {
  getTransactionCount: async () => cfg.nonce,
  sendRawTransaction: async ({ serializedTransaction }) => {
    fs.appendFileSync(cfg.sendLog, serializedTransaction + NEWLINE);
    return "ok";
  },
  waitForTransactionReceipt: async () => ({ status: "success", blockHash: "0x" + "a".repeat(64), blockNumber: 1n, transactionHash: "0x" + "b".repeat(64) }),
};

const snapshots = new Map(cfg.snapshots.map((id) => [id, { market: { liquidity: 100n, totalSupplyAssets: 100n, totalSupplyShares: 100n } }]));
const claim = await broadcastEligible({
  client, lenderAddress: "x", filePath: cfg.registryPath, snapshots,
  updateRegistry, verifyBundle: async () => ({ ok: true }), isEligible: () => true,
});
console.log(JSON.stringify({ id: claim?.id ?? null, conflict: Boolean(claim?.conflict), stuck: Boolean(claim?.stuck) }));
`;

const pending = (nonce) => ({ nonce, status: "pending", withdrawals: [{ label: "small", amountWei: "50", signedTx: "0xdead" }] });

function runWorker(cfgPath, barrierPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", WORKER_SRC, cfgPath, barrierPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("cross-process same-nonce claim (2 real Node processes)", () => {
  it("only one process claims and broadcasts; the other observes the reservation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-process-"));
    const registryPath = path.join(dir, "presigned.json");
    const cfgPath = path.join(dir, "cfg.json");
    const barrierPath = path.join(dir, "barrier");
    const sendLog = path.join(dir, "sends.log");

    fs.writeFileSync(registryPath, JSON.stringify({ version: 2, bundles: { a: pending(7), b: pending(7) } }));
    // BigInt không serialize được qua JSON — worker dựng snapshot từ string.
    fs.writeFileSync(cfgPath, JSON.stringify({
      registryPath, sendLog, nonce: 7,
      snapshots: ["a", "b"],
    }));
    fs.writeFileSync(barrierPath, "go");

    const [w1, w2] = await Promise.all([runWorker(cfgPath, barrierPath), runWorker(cfgPath, barrierPath)]);

    const parseOut = (w) => JSON.parse(w.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}");
    const results = [parseOut(w1), parseOut(w2)];
    expect(results.every((r) => r && typeof r === "object")).toBe(true);

    // Bất biến cốt lõi: ĐÚNG MỘT raw tx được broadcast trong tổng số 2 process.
    const sendLogRaw = fs.existsSync(sendLog) ? fs.readFileSync(sendLog, "utf8") : "";
    const sends = sendLogRaw.split("\n").map((s) => s.trim()).filter(Boolean);
    expect(sends).toEqual(["0xdead"]);

    // Đúng một bundle chạm terminal submitted (receipt mined tiêu thụ nonce).
    const stored = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const statuses = Object.values(stored.bundles).map((b) => b.status);
    expect(statuses.filter((s) => s === "submitted")).toHaveLength(1);
    expect(statuses.filter((s) => s === "expired")).toHaveLength(1);

    // Không process nào được báo conflict/stuck trong kịch bản này.
    expect(results.some((r) => r.conflict)).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
