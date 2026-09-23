/**
 * Tests cho proxy-dispatcher.mjs (production) — trước đây KHÔNG có test nào
 * import proxy-rpc.mjs vì top-level await + listen, nên lỗi C1 (gọi biến
 * `configuredMarketIds` đã bị xoá) lọt ra tới production.
 *
 * Bao phủ:
 *   (a) market không cấu hình → reject rõ ràng (MARKET_NOT_CONFIGURED)
 *   (b) withdraw hợp lệ của lender → trả keccak256(signedTx) + vào buffer
 *   (c) đường dispatch chạy sạch (không còn ReferenceError) qua cả HTTP
 *   (d) buffer cap 50 + semantics DELETE /captured
 */
import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import { encodeFunctionData, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRpcDispatcher, createProxyRequestHandler, MAX_CAPTURED_TXS } from "../proxy-dispatcher.mjs";
import { computeMarketId, MORPHO_WITHDRAW_ABI } from "../presign-verify.mjs";
import { MARKET_NOT_CONFIGURED } from "../market-config.mjs";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);
const LENDER = account.address;

const MARKET_PARAMS = {
  loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  oracle: "0x3333333333333333333333333333333333333333",
  irm: "0x4444444444444444444444444444444444444444",
  lltv: 860000000000000000n,
};
const MARKET_ID = computeMarketId(MARKET_PARAMS);

async function signWithdrawTx({ nonce = 7, to = MORPHO } = {}) {
  const data = encodeFunctionData({
    abi: MORPHO_WITHDRAW_ABI,
    functionName: "withdraw",
    args: [MARKET_PARAMS, 50_000_000n, 0n, LENDER, LENDER],
  });
  return account.signTransaction({
    to,
    data,
    nonce,
    chainId: 1,
    gas: 200_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    type: "eip1559",
    value: 0n,
  });
}

/** Fake viem public client — chỉ đủ cho các method dispatcher gọi tới. */
const fakeClient = {
  getBlockNumber: async () => 0x1400000n,
  getGasPrice: async () => 10_000_000_000n,
  estimateMaxPriorityFeePerGas: async () => 1_000_000_000n,
  getTransactionCount: async () => 7,
  getBlock: async () => ({ number: 0x1400000n, hash: "0x" + "ab".repeat(32), baseFeePerGas: 10_000_000_000n }),
};

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeDispatcher({ markets = [{ id: MARKET_ID }], capturedTxs = [] } = {}) {
  return createRpcDispatcher({
    markets,
    lenderAddress: LENDER,
    morphoBlueAddress: MORPHO,
    client: fakeClient,
    capturedTxs,
    logger: silentLogger,
  });
}

describe("createRpcDispatcher — capture gate", () => {
  it("(a) từ chối rõ ràng tx thuộc market không được cấu hình", async () => {
    const capturedTxs = [];
    const { handleRpc } = makeDispatcher({ markets: [], capturedTxs });
    const signedTx = await signWithdrawTx();
    await expect(handleRpc("eth_sendRawTransaction", [signedTx])).rejects.toMatchObject({
      code: MARKET_NOT_CONFIGURED,
    });
    await expect(handleRpc("eth_sendRawTransaction", [signedTx])).rejects.toThrow(/not configured/);
    expect(capturedTxs).toHaveLength(0); // fail closed: không capture gì
  });

  it("(b) capture withdraw hợp lệ của lender: trả keccak256(signedTx) và vào buffer", async () => {
    const capturedTxs = [];
    const { handleRpc } = makeDispatcher({ capturedTxs });
    const signedTx = await signWithdrawTx();
    const result = await handleRpc("eth_sendRawTransaction", [signedTx]);
    expect(result).toBe(keccak256(signedTx));
    expect(capturedTxs).toHaveLength(1);
    expect(capturedTxs[0]).toMatchObject({ hash: keccak256(signedTx), signedTx });
    expect(typeof capturedTxs[0].capturedAt).toBe("string");
  });

  it("(b2) từ chối tx không phải Morpho withdraw (sender/shape sai)", async () => {
    const capturedTxs = [];
    const { handleRpc } = makeDispatcher({ capturedTxs });
    const signedTx = await signWithdrawTx({ to: "0x2222222222222222222222222222222222222222" });
    const result = await handleRpc("eth_sendRawTransaction", [signedTx]);
    expect(result).toBeInstanceOf(Error);
    expect(capturedTxs).toHaveLength(0);
  });
});

describe("createRpcDispatcher — method surface (C1 regression)", () => {
  it("(c) các method mock chạy sạch, không còn ReferenceError", async () => {
    const { handleRpc } = makeDispatcher();
    const cases = [
      ["eth_chainId", "0x1"],
      ["eth_getBalance", "0x8AC7230489E80000"],
      ["eth_estimateGas", "0x30d40"],
      ["eth_syncing", false],
      ["net_version", "1"],
      ["net_listening", true],
      ["eth_accounts", []],
      ["web3_clientVersion", "MorphoProxy/v1"],
      ["eth_subscribe", "0x0"],
    ];
    for (const [method, expected] of cases) {
      const value = await handleRpc(method, []);
      expect(value, method).toEqual(expected);
    }
    // Capture path cũng phải chạy — đây chính là dòng từng ném ReferenceError.
    const signedTx = await signWithdrawTx();
    const result = await handleRpc("eth_sendRawTransaction", [signedTx]);
    expect(String(result)).not.toMatch(/ReferenceError|configuredMarketIds/);
    expect(result).toBe(keccak256(signedTx));
  });

  it("(c2) morpho_proxyInfo nhận diện proxy (B2); web3_clientVersion giữ nguyên", async () => {
    const { handleRpc } = makeDispatcher();
    expect(await handleRpc("morpho_proxyInfo", [])).toEqual({ server: "morpho-proxy", chainId: 1 });
    expect(await handleRpc("web3_clientVersion", [])).toBe("MorphoProxy/v1");
  });

  it("(c3) chuyển tiếp lỗi RPC thành Error (jsonRpcError -32603 ở HTTP layer)", async () => {
    const client = { ...fakeClient, request: async () => { throw new Error("upstream down"); } };
    const { handleRpc } = createRpcDispatcher({
      markets: [{ id: MARKET_ID }],
      lenderAddress: LENDER,
      morphoBlueAddress: MORPHO,
      client,
      capturedTxs: [],
      logger: silentLogger,
    });
    const result = await handleRpc("eth_call", [{ to: MORPHO }]);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/upstream down/);
  });
});

// ---- HTTP server trên production handler (top-level await như presigned-api.test.mjs) ----
const httpCapturedTxs = [];
const httpServer = http.createServer(
  createProxyRequestHandler({
    markets: [{ id: MARKET_ID }],
    lenderAddress: LENDER,
    morphoBlueAddress: MORPHO,
    client: fakeClient,
    capturedTxs: httpCapturedTxs,
    webappUrl: "http://127.0.0.1:1",
    webappPassword: "",
    logger: silentLogger,
  })
);
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const port = httpServer.address().port;
afterAll(() => new Promise((resolve) => httpServer.close(resolve)));

describe("createProxyRequestHandler — HTTP semantics", () => {
  const capturedTxs = httpCapturedTxs;

  const rpc = async (method, params = []) => {
    const resp = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return resp.json();
  };

  it("(c4) JSON-RPC qua HTTP: capture thành công + market lạ trả -32603", async () => {
    const signedTx = await signWithdrawTx();
    const ok = await rpc("eth_sendRawTransaction", [signedTx]);
    expect(ok.result).toBe(keccak256(signedTx));

    // eth_call đi qua client.request — fakeClient không có ⇒ lỗi mềm thành -32603
    const bad = await rpc("eth_call", [{ to: MORPHO }]);
    expect(bad.error.code).toBe(-32603);
    expect(bad.error.message).toMatch(/client\.request is not a function/);
  });

  it("(d) buffer cap 50: capture mới nhất đẩy entry cũ nhất ra", async () => {
    capturedTxs.length = 0;
    for (let i = 0; i < MAX_CAPTURED_TXS; i++) {
      capturedTxs.push({ hash: "0xold" + i, signedTx: "0x00", capturedAt: "2026-01-01T00:00:00.000Z" });
    }
    const signedTx = await signWithdrawTx({ nonce: 9 });
    const result = await rpc("eth_sendRawTransaction", [signedTx]);
    expect(result.result).toBe(keccak256(signedTx));
    expect(capturedTxs).toHaveLength(MAX_CAPTURED_TXS);
    expect(capturedTxs[0].hash).toBe("0xold1"); // oldest dropped
    expect(capturedTxs.at(-1).hash).toBe(keccak256(signedTx));
  });

  it("(d2) GET /captured trả metadata (không signedTx); DELETE /captured xoá sạch", async () => {
    const before = await (await fetch(`http://127.0.0.1:${port}/captured`)).json();
    expect(before.count).toBe(MAX_CAPTURED_TXS);
    expect(before.txs[0]).not.toHaveProperty("signedTx");
    expect(before.txs[0]).toHaveProperty("hash");

    const del = await fetch(`http://127.0.0.1:${port}/captured`, { method: "DELETE" });
    expect(await del.json()).toEqual({ ok: true, deleted: MAX_CAPTURED_TXS });
    const after = await (await fetch(`http://127.0.0.1:${port}/captured`)).json();
    expect(after).toEqual({ count: 0, txs: [] });
  });
});
