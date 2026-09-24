/**
 * Fix 5 (P2, audit 2026-09-24): merge rung cùng nonce không được phụ thuộc
 * TYPE của nonce ("7" string vs 7 number). Trước fix `old.nonce === incoming.nonce`
 * so sánh strict ⇒ bundle ghi bằng nonce string bị gắn nhãn "replaced (new nonce)"
 * sai và drop tier cũ âm thầm.
 *
 * Test dùng verifyPresignedBundle THẬT + chữ ký THẬT nên cần LENDER_ADDRESS khớp
 * tài khoản test TRƯỚC khi shared.mjs được nạp (module-level const) — vì vậy file
 * này set env rồi dynamic-import webapp-handler.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MARKET_ID_A, MARKET_PARAMS_A, lenderAccount, pendingBundle } from "./helpers/signed-withdraw.mjs";

// Phải chạy TRƯỚC khi webapp-handler (→ shared.mjs) được nạp.
process.env.LENDER_ADDRESS = lenderAccount().address;
const { createRequestHandler } = await import("../webapp-handler.mjs");

const content = "<html>test</html>";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-merge-"));
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

describe("merge rung cùng nonce không phụ thuộc type nonce", () => {
  it('POST nonce "7" (string) vào rung đã có nonce 7 (number) → merged, giữ cả tier cũ', async () => {
    const first = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "50000000000", label: "t1" }],
    });
    const r1 = await postPresign(first);
    expect(r1.status).toBe(200);
    expect(r1.json.ok).toBe(true);

    const second = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: "7",
      tiers: [{ amountWei: "20000000000", label: "t2" }],
    });
    const r2 = await postPresign(second);
    expect(r2.status).toBe(200);
    expect(r2.json.ok).toBe(true);
    // Trước Fix 5: action = "replaced (new nonce)" (sai nhãn) và tier t1 bị drop.
    expect(r2.json.action).toContain("merged");
    expect(r2.json.tiers).toBe(2);

    const stored = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const rungs = Object.values(stored.bundles);
    expect(rungs).toHaveLength(1); // cùng key marketId@7 — không tạo rung mới
    expect(rungs[0].withdrawals.map((w) => w.label).sort()).toEqual(["t1", "t2"]);
    expect(rungs[0].status).toBe("pending");
  });
});
