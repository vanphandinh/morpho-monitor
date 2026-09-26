/**
 * Chẩn đoán 2026-09-26 — rung `expired` không được hồi sinh, và tier mới không được nhét vào
 * bundle nonce cũ.
 *
 * Đỏ-trước (A1/A2 trên cây trước fix): POST cùng nonce vào rung `expired` trả 200 và ghi record
 * thành `pending` — kể cả rung RỖNG (`withdrawals: []`, đúng hình dạng file presigned.json thật của
 * người dùng: `…@2550` expired + rỗng) vì nó lọt qua cả hai điều kiện của nhánh merge
 * (`old.withdrawals.length > 0` và `!HISTORY_STATUSES.includes(old.status)`).
 *
 * A3 ghim bất biến còn lại: nonce CAO HƠN luôn tạo rung mới và không được chạm rung cũ — nếu ca này
 * xanh thì phía server không phải thủ phạm ca "tier mới nonce cao hơn".
 *
 * Test dùng verifyPresignedBundle THẬT + chữ ký THẬT nên phải set LENDER_ADDRESS TRƯỚC khi
 * dynamic-import webapp-handler (shared.mjs đọc env ở module scope).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MARKET_ID_A, MARKET_PARAMS_A, lenderAccount, pendingBundle } from "./helpers/signed-withdraw.mjs";

process.env.LENDER_ADDRESS = lenderAccount().address;
const { createRequestHandler } = await import("../webapp-handler.mjs");
// Import ĐỘNG cùng lý do trên: static import sẽ nạp shared.mjs trước dòng gán env.
const { bundleKey } = await import("../presigned-store.mjs");

const content = "<html>test</html>";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-expired-"));
const registryPath = path.join(dir, "presigned.json");

let server;
let port;

beforeAll(async () => {
  server = http.createServer(
    createRequestHandler({ presignedPath: registryPath, markets: [{ id: MARKET_ID_A }], content })
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

async function postPresign(bundle) {
  const resp = await fetch(`http://127.0.0.1:${port}/api/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bundle),
  });
  return { status: resp.status, json: await resp.json() };
}

function seed(bundles, consumedNonce = -1) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const raw = JSON.stringify({ version: 3, bundles, consumedNonce }, null, 2);
  fs.writeFileSync(registryPath, raw);
  return raw;
}

const readBundles = () => JSON.parse(fs.readFileSync(registryPath, "utf8")).bundles;

describe("rung expired không được hồi sinh (chẩn đoán 2026-09-26)", () => {
  it("A1 (minimise, đúng artifact): rung expired RỖNG cùng nonce ⇒ 409, registry không đổi", async () => {
    const dead = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "100000000000", label: "old-100" }],
    });
    dead.status = "expired";
    dead.withdrawals = []; // đúng `…@2550` trong presigned.json thật
    const raw = seed({ [bundleKey(MARKET_ID_A, 7)]: dead });

    const incoming = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "50000000000", label: "new-50" }],
    });
    const resp = await postPresign(incoming);
    expect(resp.status).toBe(409);
    expect(resp.json.ok).toBe(false);
    expect(resp.json.error).toMatch(/hết hạn/);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
  });

  it("A2: rung expired CÒN tier cùng nonce ⇒ 409, tier cũ không bị trộn", async () => {
    const dead = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "100000000000", label: "old-100" }],
    });
    dead.status = "expired";
    const raw = seed({ [bundleKey(MARKET_ID_A, 7)]: dead });

    const incoming = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "50000000000", label: "new-50" }],
    });
    expect((await postPresign(incoming)).status).toBe(409);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
  });

  it("A3 (ghim bất biến): nonce CAO HƠN ⇒ rung cũ nguyên trạng, rung mới chỉ có tier mới", async () => {
    const old = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "100000000000", label: "old-100" }],
    });
    seed({ [bundleKey(MARKET_ID_A, 7)]: old });

    const incoming = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 8,
      tiers: [{ amountWei: "50000000000", label: "new-50" }],
    });
    const resp = await postPresign(incoming);
    expect(resp.status).toBe(200);
    expect(resp.json.ok).toBe(true);

    const bundles = readBundles();
    expect(bundles[bundleKey(MARKET_ID_A, 7)].withdrawals.map((w) => w.label)).toEqual(["old-100"]);
    expect(bundles[bundleKey(MARKET_ID_A, 7)].status).toBe("pending");
    expect(bundles[bundleKey(MARKET_ID_A, 8)].withdrawals.map((w) => w.label)).toEqual(["new-50"]);
    expect(bundles[bundleKey(MARKET_ID_A, 8)].status).toBe("pending");
  });
});
