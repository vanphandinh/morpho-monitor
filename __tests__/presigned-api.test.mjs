/**
 * Production-backed HTTP route tests for the presign webapp API.
 * Exercises the REAL createRequestHandler on a live http.Server —
 * không có bản copy route logic. Dev mode (không WEBAPP_PASSWORD) nên
 * verifyToken chấp nhận mọi request trong quá trình test.
 */
import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequestHandler, statusForError } from "../webapp-handler.mjs";
import { MARKET_INPUT_INVALID, MARKET_NOT_CONFIGURED } from "../market-config.mjs";
import { ACTIVE_CLAIM_CONFLICT } from "../presigned-store.mjs";
import { LOCK_STALE } from "../shared.mjs";
import { stringToHex, keccak256 } from "viem";

const MARKET_A = "0x" + "a".repeat(64);
const MARKET_B = "0x" + "b".repeat(64);
const markets = [{ id: MARKET_A }, { id: MARKET_B }];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-api-"));
const registryPath = path.join(dir, "presigned.json");
const content = "<html>test</html>";

function seedRegistry(bundles) {
  fs.writeFileSync(registryPath, JSON.stringify({ version: 2, bundles }));
}

const server = http.createServer(createRequestHandler({
  presignedPath: registryPath,
  markets,
  content,
}));
const port = 3457;
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

afterAll(() => new Promise((resolve) => server.close(resolve)));

async function api(method, urlPath, body) {
  const resp = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML response */ }
  return { status: resp.status, json, text };
}

const broadcastingBundle = () => ({
  nonce: 7,
  status: "broadcasting",
  broadcastingAt: new Date().toISOString(),
  broadcastingTier: "small",
  rawTx: stringToHex("x"),
  txHash: keccak256(stringToHex("x")),
  withdrawals: [{ label: "small", amountWei: "50", signedTx: stringToHex("x") }],
});

describe("presign API (production handler over real HTTP)", () => {
  it("GET / serves the injected webapp HTML", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("test</html>");
  });

  it("GET /api/presign returns 400 for a malformed market and 404 for an unconfigured one", async () => {
    expect((await api("GET", `/api/presign?market=not-a-hash`)).status).toBe(400);
    const missing = await api("GET", `/api/presign?market=${"0x" + "c".repeat(64)}`);
    expect(missing.status).toBe(404);
  });

  it("DELETE is market-scoped: it never deletes another market's bundle", async () => {
    seedRegistry({ [MARKET_A]: { nonce: 5, status: "pending", withdrawals: [{ label: "t1", amountWei: "10", signedTx: "0x01" }] }, [MARKET_B]: { nonce: 5, status: "pending", withdrawals: [{ label: "t1", amountWei: "10", signedTx: "0x01" }] } });
    const resp = await api("DELETE", `/api/presign?market=${MARKET_A}`);
    expect(resp.status).toBe(200);
    const stored = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    expect(stored.bundles[MARKET_A]).toBeUndefined();
    expect(stored.bundles[MARKET_B].status).toBe("pending");
  });

  it("DELETE without market returns 400 and touches nothing", async () => {
    seedRegistry({ [MARKET_A]: { nonce: 5, status: "pending", withdrawals: [] } });
    const resp = await api("DELETE", `/api/presign`);
    expect(resp.status).toBe(400);
    expect(JSON.parse(fs.readFileSync(registryPath, "utf8")).bundles[MARKET_A]).toBeDefined();
  });

  it("DELETE of a whole broadcasting bundle is rejected with 409 and the registry is unchanged", async () => {
    seedRegistry({ [MARKET_A]: broadcastingBundle() });
    const before = fs.readFileSync(registryPath, "utf8");
    const resp = await api("DELETE", `/api/presign?market=${MARKET_A}`);
    expect(resp.status).toBe(409);
    expect(JSON.parse(fs.readFileSync(registryPath, "utf8")).bundles[MARKET_A].status).toBe("broadcasting");
    expect(fs.readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("M1: DELETE of a terminal (submitted) bundle succeeds so history can be cleared", async () => {
    seedRegistry({ [MARKET_A]: { nonce: 7, status: "submitted", txHash: keccak256(stringToHex("mined")), terminalAt: "2026-09-23T00:00:00.000Z", withdrawals: [] } });
    const resp = await api("DELETE", `/api/presign?market=${MARKET_A}`);
    expect(resp.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(registryPath, "utf8")).bundles[MARKET_A]).toBeUndefined();
  });

  it("GET /api/presign exposes terminalAt on terminal records", async () => {
    seedRegistry({ [MARKET_A]: { nonce: 7, status: "submitted", txHash: keccak256(stringToHex("mined")), terminalAt: "2026-09-23T00:00:00.000Z", withdrawals: [] } });
    const resp = await api("GET", `/api/presign?market=${MARKET_A}`);
    expect(resp.status).toBe(200);
    expect(resp.json.terminalAt).toBe("2026-09-23T00:00:00.000Z");
  });

  it("DELETE of a tier from a broadcasting bundle is rejected with 409", async () => {
    seedRegistry({ [MARKET_A]: broadcastingBundle() });
    const resp = await api("DELETE", `/api/presign?market=${MARKET_A}&tier=0`);
    expect(resp.status).toBe(409);
    expect(JSON.parse(fs.readFileSync(registryPath, "utf8")).bundles[MARKET_A].withdrawals).toHaveLength(1);
  });

  it("DELETE of a tier from a pending bundle works and reports remaining tiers", async () => {
    seedRegistry({ [MARKET_A]: { nonce: 5, status: "pending", withdrawals: [{ label: "t1", amountWei: "10", signedTx: "0x01" }, { label: "t2", amountWei: "20", signedTx: "0x02" }] } });
    const resp = await api("DELETE", `/api/presign?market=${MARKET_A}&tier=0`);
    expect(resp.status).toBe(200);
    expect(resp.json.remaining).toBe(1);
  });

  // AUDIT F3 (2026-09-24): `tier` không kèm `nonce` trên market có ladder (v3)
  // trước fix luôn sửa rung nonce THẤP NHẤT — có thể khác rung user đang xem.
  it("F3: DELETE tier thiếu nonce trên market có ladder bị từ chối 400, registry nguyên vẹn", async () => {
    seedRegistry({
      [`${MARKET_A}@7`]: { marketId: MARKET_A, nonce: 7, status: "pending", withdrawals: [{ label: "a7", amountWei: "10", signedTx: "0x01" }] },
      [`${MARKET_A}@8`]: { marketId: MARKET_A, nonce: 8, status: "pending", withdrawals: [{ label: "a8", amountWei: "20", signedTx: "0x02" }] },
    });
    const before = fs.readFileSync(registryPath, "utf8");
    const resp = await api("DELETE", `/api/presign?market=${MARKET_A}&tier=0`);
    expect(resp.status).toBe(400);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("F3: DELETE tier kèm nonce sửa ĐÚNG rung; nonce không tồn tại → 400", async () => {
    seedRegistry({
      [`${MARKET_A}@7`]: { marketId: MARKET_A, nonce: 7, status: "pending", withdrawals: [{ label: "a7", amountWei: "10", signedTx: "0x01" }] },
      [`${MARKET_A}@8`]: { marketId: MARKET_A, nonce: 8, status: "pending", withdrawals: [{ label: "a8", amountWei: "20", signedTx: "0x02" }] },
    });
    const resp = await api("DELETE", `/api/presign?market=${MARKET_A}&tier=0&nonce=8`);
    expect(resp.status).toBe(200);
    expect(resp.json).toMatchObject({ ok: true, removed: "a8", remaining: 0 });
    const stored = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    expect(stored.bundles[`${MARKET_A}@7`].withdrawals).toHaveLength(1); // rung khác không bị đụng
    expect(stored.bundles[`${MARKET_A}@8`].withdrawals).toHaveLength(0);

    const missing = await api("DELETE", `/api/presign?market=${MARKET_A}&tier=0&nonce=99`);
    expect(missing.status).toBe(400);
  });

  it("POST /api/presign strips client-supplied lifecycle fields", async () => {
    seedRegistry({});
    // verifyPresignedBundle sẽ fail trên signedTx giả, nhưng field lifecycle
    // phải bị strip trước đó — response error không bao giờ là "lifecycle".
    const resp = await api("POST", `/api/presign`, {
      version: 2,
      marketId: MARKET_A,
      nonce: 7,
      lenderAddress: "0x0000000000000000000000000000000000000000",
      morphoBlueAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
      withdrawals: [{ label: "t1", amountWei: "10", signedTx: "0x01" }],
      status: "broadcasting",
      txHash: "0xhack",
      rawTx: "0xhack",
    });
    expect(resp.status).toBe(400); // calldata verify fails on the fake tx — expected
    const stored = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    expect(stored.bundles[MARKET_A]).toBeUndefined(); // nothing persisted on failure
  });

  it("error status mapping is total", () => {
    expect(statusForError({ code: MARKET_INPUT_INVALID })).toBe(400);
    expect(statusForError({ code: MARKET_NOT_CONFIGURED })).toBe(404);
    expect(statusForError({ code: ACTIVE_CLAIM_CONFLICT })).toBe(409);
    // H4/B3: lock kẹt là lỗi tạm thời của server, không phải lỗi phía client.
    expect(statusForError({ code: LOCK_STALE })).toBe(503);
    expect(statusForError(new Error("boom"))).toBe(500);
  });

  it("M10: route phải khớp CHÍNH XÁC — /api/presignXYZ không phải /api/presign", async () => {
    const getResp = await api("GET", "/api/presignXYZ?market=" + MARKET_A);
    expect(getResp.status).toBe(404);
    expect(getResp.json.ok).toBe(false);
    const deleteResp = await api("DELETE", "/api/presignXYZ?market=" + MARKET_A);
    expect(deleteResp.status).toBe(404);
    expect(deleteResp.json.error).toMatch(/Unknown API route/);
  });

  it("M10: /api/* lạ trả JSON 404, path tĩnh lạ vẫn là SPA HTML", async () => {
    const unknownApi = await api("POST", "/api/whatever", { hello: 1 });
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.json).toMatchObject({ ok: false });
    const unknownPage = await api("GET", "/some/spa/path");
    expect(unknownPage.status).toBe(200);
    expect(unknownPage.text).toContain("test</html>");
  });

  // ---- GET /api/overview — ladder mọi market (v3) ----
  it("GET /api/overview trả ladder theo allow-list; market không có bundle → ladder rỗng", async () => {
    seedRegistry({
      [MARKET_A]: { marketId: MARKET_A, nonce: 5, status: "pending", withdrawals: [{ label: "t1", amountWei: "10", signedTx: "0x01" }] },
      [MARKET_B]: { marketId: MARKET_B, nonce: 9, status: "submitted", terminalAt: "2026-09-24T00:00:00.000Z", withdrawals: [] },
    });
    const resp = await api("GET", "/api/overview");
    expect(resp.status).toBe(200);
    expect(resp.json.ok).toBe(true);
    expect(resp.json.markets).toHaveLength(2);
    const a = resp.json.markets.find((m) => m.id === MARKET_A);
    const b = resp.json.markets.find((m) => m.id === MARKET_B);
    expect(a.ladder).toHaveLength(1);
    expect(a.ladder[0]).toMatchObject({ status: "pending", nonce: 5 });
    expect(a.ladder[0].tiers).toHaveLength(1);
    expect(b.ladder[0]).toMatchObject({ status: "submitted", nonce: 9 });
    // rounds: nhóm theo nonce, mỗi entry mang marketId + summary
    const round9 = resp.json.rounds.find((r) => r.nonce === 9);
    expect(round9.markets[0]).toMatchObject({ id: MARKET_B, status: "submitted" });
  });

  it("GET /api/overview: cùng nonce 2 market → 1 round 2 entry (race view)", async () => {
    seedRegistry({
      [MARKET_A]: { marketId: MARKET_A, nonce: 7, status: "pending", withdrawals: [] },
      [MARKET_B]: { marketId: MARKET_B, nonce: 7, status: "pending", withdrawals: [] },
    });
    const resp = await api("GET", "/api/overview");
    expect(resp.status).toBe(200);
    const round7 = resp.json.rounds.find((r) => r.nonce === 7);
    expect(round7.markets).toHaveLength(2);
  });

  it("GET /api/overview trên registry rỗng: ladder rỗng, rounds rỗng", async () => {
    seedRegistry({});
    const resp = await api("GET", "/api/overview");
    expect(resp.status).toBe(200);
    expect(resp.json.markets.every((m) => m.ladder.length === 0)).toBe(true);
    expect(resp.json.rounds).toEqual([]);
  });

  it("v3 ladder: cùng market nhiều nonce → GET /api/presign trả ladder đầy đủ, head = nonce thấp nhất", async () => {
    seedRegistry({
      [`${MARKET_A}@7`]: { marketId: MARKET_A, nonce: 7, status: "submitted", withdrawals: [] },
      [`${MARKET_A}@8`]: { marketId: MARKET_A, nonce: 8, status: "pending", withdrawals: [{ label: "t1", amountWei: "10", signedTx: "0x01" }] },
    });
    const resp = await api("GET", `/api/presign?market=${MARKET_A}`);
    expect(resp.status).toBe(200);
    expect(resp.json.ladder).toHaveLength(2);
    expect(resp.json.ladder[0].nonce).toBe(7); // head = nonce thấp nhất
    expect(resp.json.ladder[1].nonce).toBe(8);
    expect(resp.json.status).toBe("submitted"); // head back-compat
  });

  it("M10: state challenge là per-handler (không chia sẻ giữa các handler)", async () => {
    // Handler thứ hai có state riêng: challenge của handler này không hợp lệ ở handler kia.
    const isolated = createRequestHandler({ presignedPath: registryPath, markets, content });
    const other = http.createServer(isolated);
    await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherPort = other.address().port;
    try {
      const challenge = await (await fetch(`http://127.0.0.1:${otherPort}/api/challenge`)).json();
      expect(challenge.ok).toBe(true);
      const resp = await fetch(`http://127.0.0.1:${port}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: "0x0000000000000000000000000000000000000000", signature: "0x00", challenge: challenge.challenge }),
      });
      expect(resp.status).toBe(401); // challenge không tồn tại ở handler này
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });
});
