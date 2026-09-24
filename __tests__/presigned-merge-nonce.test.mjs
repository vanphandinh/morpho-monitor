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
import { keccak256, stringToHex } from "viem";
import { MARKET_ID_A, MARKET_PARAMS_A, lenderAccount, pendingBundle } from "./helpers/signed-withdraw.mjs";

// Phải chạy TRƯỚC khi webapp-handler (→ shared.mjs) được nạp.
process.env.LENDER_ADDRESS = lenderAccount().address;
const { createRequestHandler } = await import("../webapp-handler.mjs");
// Cũng phải là import ĐỘNG: static import sẽ nạp shared.mjs (→ LENDER_ADDRESS)
// trước dòng gán env ở trên, khiến mọi verify dùng zero-address ⇒ 400.
const { marketBundles } = await import("../presigned-store.mjs");

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

  // AUDIT F1 (2026-09-24): registry v2→v3 migration GIỮ NGUYÊN key cũ (key là
  // opaque, identity nằm trong VALUE). Nhưng POST /api/presign lại tra rung bằng
  // `registry.bundles[bundleKey(marketId, nonce)]` — key composite không bao giờ
  // khớp key legacy ⇒ coi như "bundle mới" và GHI THÊM một rung cùng
  // (marketId, nonce). Hệ quả: identity trùng lặp, ladder hiển thị race giả, và
  // broadcaster claim rung CŨ (Object.entries giữ thứ tự chèn) ⇒ có thể broadcast
  // số tiền cũ mà user đã sửa.
  it("F1: POST cùng nonce vào registry đã migrate v2 KHÔNG được tạo rung trùng identity", async () => {
    const legacy = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "100000000000", label: "old-100" }],
    });
    // Registry v2 như trên đĩa của deployment: key = marketId (plain), chưa composite.
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ version: 2, bundles: { [MARKET_ID_A]: legacy } }));

    const incoming = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "50000000000", label: "new-50" }],
    });
    const resp = await postPresign(incoming);
    expect(resp.status).toBe(200);
    expect(resp.json.ok).toBe(true);

    const stored = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const rungsAt7 = marketBundles(stored.bundles, MARKET_ID_A).filter(({ bundle }) => Number(bundle.nonce) === 7);
    // Một identity (marketId, nonce) CHỈ được có một rung.
    expect(rungsAt7).toHaveLength(1);
    // Rung mà broadcaster sẽ claim (rung pending đầu tiên ở nonce 7) phải chứa
    // tier vừa ký — không được là bundle cũ với số tiền cũ.
    const claimable = rungsAt7.find(({ bundle }) => bundle.status === "pending");
    expect(claimable.bundle.withdrawals.map((w) => w.label)).toContain("new-50");
  });

  /** Bản ghi đang claim sống ở nonce 7 với bytes/hash "thật" (ổn định). */
  const liveClaimAt7 = (label = "live-claim") => {
    const bytes = stringToHex(label);
    return {
      marketId: MARKET_ID_A, nonce: 7, status: "broadcasting",
      broadcastingAt: new Date().toISOString(), broadcastingTier: "old-100",
      rawTx: bytes, txHash: keccak256(bytes),
      withdrawals: [{ label: "old-100", amountWei: "100000000000", signedTx: bytes }],
    };
  };

  // AUDIT vòng 2 (D4): bản vá F1 dọn bản sao identity nhưng BỎ QUA bản đang
  // broadcasting và lấy `sameIdentity[0]` làm target. Nếu bản broadcasting đứng
  // SAU bản pending (đúng thứ tự file do bug tra-key cũ tạo ra), merged được ghi
  // vào bản pending và bản broadcasting KHÔNG bị dọn ⇒ registry còn hai rung cùng
  // identity ⇒ overview báo race giả cho cùng một market.
  it("D4: bản sao broadcasting đứng SAU pending ⇒ 409, registry nguyên vẹn", async () => {
    const dup = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "100000000000", label: "dup" }],
    });
    const seeded = {
      version: 3,
      bundles: {
        [MARKET_ID_A]: { ...dup, status: "pending" }, // key legacy, PENDING — đứng trước
        [`${MARKET_ID_A}@7`]: liveClaimAt7(),          // key composite, BROADCASTING — đứng sau
      },
    };
    const raw = JSON.stringify(seeded, null, 2);
    fs.writeFileSync(registryPath, raw);

    const incoming = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "70000000000", label: "new-70" }],
    });
    const resp = await postPresign(incoming);
    expect(resp.status).toBe(409);
    // Không được dọn dở rồi mới throw: claim sống + bản sao vẫn nguyên trạng.
    expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
    const rungsAt7 = marketBundles(JSON.parse(raw).bundles, MARKET_ID_A)
      .filter(({ bundle }) => Number(bundle.nonce) === 7);
    expect(rungsAt7.filter(({ bundle }) => bundle.status === "broadcasting")).toHaveLength(1);
  });

  it("D4: bản sao broadcasting đứng TRƯỚC pending ⇒ vẫn 409 (không regression)", async () => {
    const dup = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "100000000000", label: "dup" }],
    });
    const seeded = {
      version: 3,
      bundles: {
        [`${MARKET_ID_A}@7`]: liveClaimAt7("live-claim-reversed"), // broadcasting trước
        [MARKET_ID_A]: { ...dup, status: "pending" },
      },
    };
    const raw = JSON.stringify(seeded, null, 2);
    fs.writeFileSync(registryPath, raw);

    const incoming = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "70000000000", label: "new-70" }],
    });
    expect((await postPresign(incoming)).status).toBe(409);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
  });

  it("D4: hai bản sao đều PENDING ⇒ hợp nhất còn MỘT rung (dọn bản sao vẫn hoạt động)", async () => {
    const first = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "100000000000", label: "old-100" }],
    });
    const second = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "30000000000", label: "other-30" }],
    });
    fs.writeFileSync(registryPath, JSON.stringify({ version: 3, bundles: {
      [MARKET_ID_A]: { ...first, status: "pending" },
      [`${MARKET_ID_A}@7`]: { ...second, status: "pending" },
    } }, null, 2));

    const incoming = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "50000000000", label: "new-50" }],
    });
    const resp = await postPresign(incoming);
    expect(resp.status).toBe(200);
    expect(resp.json.action).toContain("merged");

    const stored = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const rungsAt7 = marketBundles(stored.bundles, MARKET_ID_A).filter(({ bundle }) => Number(bundle.nonce) === 7);
    expect(rungsAt7).toHaveLength(1);
    // Tier của bản bị dọn (composite) không còn, tier của target (legacy) + tier mới đều còn.
    const labels = rungsAt7[0].bundle.withdrawals.map((w) => w.label).sort();
    expect(labels).toEqual(["new-50", "old-100"]);
  });
});
