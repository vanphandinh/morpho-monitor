/**
 * D20 (chẩn đoán 2026-09-26, tiếp D19) — proxy từ chối chữ ký ở nonce đã bị tiêu thụ.
 *
 * Vì sao cần lớp này: D19 chặn ở PHÍA BROWSER (`nonceStillSignable()`), nhưng bất kỳ client nào
 * khác (script tự viết, ví tự thêm nonce, tab cũ còn mở) vẫn gửi được một tx ký ở nonce đã chết vào
 * proxy. Proxy là nơi DUY NHẤT thấy cả signed tx lẫn `getTransactionCount(pending)`, nên nó là chỗ
 * đúng để từ chối; nếu không, chữ ký chết vẫn vào registry (lúc đó chỉ còn D16/D17 dọn ở phía sau).
 *
 * Đỏ-trước (chạy trên cây trước fix, cùng đoạn code dưới):
 *   on-chain pending = 8, tx nonce = 7
 *   kết quả eth_sendRawTransaction: 0x9c82f75a…     ← KHÔNG phải Error: proxy vẫn capture
 *   buffer capture: 1 {"hash":"0x9c82f75a…","nonce":null}
 *   đúng hash ký? true
 * Tức không cổng nào ở proxy hỏi nonce, và tx ở nonce đã chết đi thẳng vào buffer (rồi vào registry
 * khi /bundle ghép). Sau fix: `Error: nonce 7 đã bị tiêu thụ (on-chain pending 8) …` + buffer rỗng.
 *
 * Luật (giữ đúng ngữ nghĩa D19): chỉ chặn khi on-chain pending **vượt qua** nonce của tx. Nonce CAO
 * HƠN on-chain vẫn hợp lệ — đó là xếp hàng có chủ đích (bậc thang nonce). Khi KHÔNG đọc được nonce
 * on-chain thì fail OPEN + warn: thiếu bằng chứng không phải bằng chứng nonce đã chết, và D16/D17 +
 * vòng expire của monitor vẫn dọn được rồi.
 */
import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { encodeFunctionData, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createProxyRequestHandler, createRpcDispatcher } from "../proxy-dispatcher.mjs";
import { NONCE_CONSUMED, assertNonceNotConsumed, computeMarketId, MORPHO_WITHDRAW_ABI } from "../presign-verify.mjs";

// Khoá test công khai (Hardhat account #0) — không phải ví thật, không có tiền.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);
const LENDER = account.address;
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const MARKET_PARAMS = {
  loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  oracle: "0x" + "3".repeat(40),
  irm: "0x" + "4".repeat(40),
  lltv: 860000000000000000n,
};
const MARKET_ID = computeMarketId(MARKET_PARAMS);

const AMOUNT_WEI = 50_000_000n;

function signWithdrawTx({ nonce = 7 } = {}) {
  return account.signTransaction({
    to: MORPHO,
    data: encodeFunctionData({
      abi: MORPHO_WITHDRAW_ABI,
      functionName: "withdraw",
      args: [MARKET_PARAMS, AMOUNT_WEI, 0n, LENDER, LENDER],
    }),
    nonce,
    chainId: 1,
    gas: 200_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    type: "eip1559",
    value: 0n,
  });
}

/**
 * Chain giả MUTABLE: `state.pending` là nonce on-chain, `state.down` làm mọi lần đọc nonce ném lỗi
 * (ca fail-open). Mọi method khác không cần cho hai cổng nonce.
 */
function makeChain({ pending = 7, down = false } = {}) {
  const state = { pending, down };
  return {
    state,
    async getTransactionCount() {
      if (state.down) throw new Error("upstream RPC down");
      return BigInt(state.pending);
    },
  };
}

function makeLogger() {
  const logs = { warn: [], log: [], error: [] };
  return {
    logs,
    log: (m) => logs.log.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.error.push(String(m)),
  };
}

function makeDispatcher({ chain, capturedTxs = [], logger = makeLogger() } = {}) {
  return createRpcDispatcher({
    markets: [{ id: MARKET_ID }],
    lenderAddress: LENDER,
    morphoBlueAddress: MORPHO,
    client: chain,
    capturedTxs,
    logger,
  });
}

describe("assertNonceNotConsumed (hàm thuần)", () => {
  it("bằng nhau / cao hơn ⇒ hợp lệ; thấp hơn ⇒ NONCE_CONSUMED; thiếu bằng chứng ⇒ checked: false", () => {
    expect(assertNonceNotConsumed({ txNonce: 7, onChainPendingNonce: 7 })).toMatchObject({ ok: true, checked: true });
    expect(assertNonceNotConsumed({ txNonce: 9, onChainPendingNonce: 7 })).toMatchObject({ ok: true, checked: true });
    expect(assertNonceNotConsumed({ txNonce: 7, onChainPendingNonce: "0x8" })).toMatchObject({
      ok: false,
      code: NONCE_CONSUMED,
    });
    expect(assertNonceNotConsumed({ txNonce: 7, onChainPendingNonce: 8n }).error).toMatch(/nonce 7 .*8/);
    // Không có nonce on-chain (RPC lỗi / không hỗ trợ) ⇒ không kết luận được, người gọi quyết định.
    expect(assertNonceNotConsumed({ txNonce: 7, onChainPendingNonce: null })).toMatchObject({ ok: true, checked: false });
    expect(assertNonceNotConsumed({ txNonce: null, onChainPendingNonce: 8 })).toMatchObject({ ok: true, checked: false });
  });
});

describe("capture gate — eth_sendRawTransaction", () => {
  it("(đỏ-trước) nonce đã tiêu thụ ⇒ TỪ CHỐI, không vào buffer", async () => {
    const capturedTxs = [];
    const chain = makeChain({ pending: 8 });
    const { handleRpc } = makeDispatcher({ chain, capturedTxs });
    const result = await handleRpc("eth_sendRawTransaction", [await signWithdrawTx({ nonce: 7 })]);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/nonce 7 .*đã bị tiêu thụ/);
    expect(capturedTxs).toHaveLength(0);
  });

  it("nonce bằng on-chain pending ⇒ capture như cũ, có ghi nonce vào entry", async () => {
    const capturedTxs = [];
    const { handleRpc } = makeDispatcher({ chain: makeChain({ pending: 7 }), capturedTxs });
    const signedTx = await signWithdrawTx({ nonce: 7 });
    expect(await handleRpc("eth_sendRawTransaction", [signedTx])).toBe(keccak256(signedTx));
    expect(capturedTxs).toHaveLength(1);
    expect(capturedTxs[0]).toMatchObject({ hash: keccak256(signedTx), nonce: 7 });
  });

  it("nonce CAO HƠN on-chain (xếp hàng có chủ đích) ⇒ vẫn capture", async () => {
    const capturedTxs = [];
    const { handleRpc } = makeDispatcher({ chain: makeChain({ pending: 7 }), capturedTxs });
    const signedTx = await signWithdrawTx({ nonce: 9 });
    expect(await handleRpc("eth_sendRawTransaction", [signedTx])).toBe(keccak256(signedTx));
    expect(capturedTxs).toHaveLength(1);
  });

  it("không đọc được nonce on-chain ⇒ fail OPEN + warn (D16/D17 vẫn dọn phía sau)", async () => {
    const capturedTxs = [];
    const logger = makeLogger();
    const { handleRpc } = makeDispatcher({ chain: makeChain({ down: true }), capturedTxs, logger });
    const signedTx = await signWithdrawTx({ nonce: 7 });
    expect(await handleRpc("eth_sendRawTransaction", [signedTx])).toBe(keccak256(signedTx));
    expect(capturedTxs).toHaveLength(1);
    expect(logger.logs.warn.join("\n")).toMatch(/không đọc được nonce on-chain/);
  });
});

// ---- HTTP: /bundle cũng phải từ chối khi nonce đã tiêu thụ GIỮA capture và lưu ----
const relays = [];
const chain = makeChain({ pending: 7 });
const capturedTxs = [];
const handler = createProxyRequestHandler({
  markets: [{ id: MARKET_ID }],
  lenderAddress: LENDER,
  morphoBlueAddress: MORPHO,
  client: chain,
  capturedTxs,
  logger: makeLogger(),
  fetchImpl: async (url, init) => {
    relays.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  },
});
const server = http.createServer(handler);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
afterAll(() => new Promise((resolve) => server.close(resolve)));

const postJson = async (url, body) => {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* không phải JSON */ }
  return { status: resp.status, json, text };
};

const bundleMeta = (txHash) => ({
  tiers: [{ amount: "50", amountWei: AMOUNT_WEI.toString(), amountFormatted: "50 USDC", label: "50 USDC", txHash }],
  marketId: MARKET_ID,
  lenderAddress: LENDER,
  morphoBlueAddress: MORPHO,
  nonce: 7,
  gas: "200000",
  maxFeePerGas: "30000000000",
  maxPriorityFeePerGas: "1000000000",
  loanToken: { symbol: "USDC", decimals: 6 },
});

describe("/bundle — nonce tươi tại thời điểm lưu", () => {
  it("nonce bị tiêu thụ giữa capture và lưu ⇒ 409, KHÔNG relay sang webapp", async () => {
    capturedTxs.length = 0;
    relays.length = 0;
    const signedTx = await signWithdrawTx({ nonce: 7 });
    const capture = await postJson(`http://127.0.0.1:${port}/`, {
      jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [signedTx],
    });
    expect(capture.json.result).toBe(keccak256(signedTx));
    expect(capturedTxs).toHaveLength(1);

    chain.state.pending = 8; // nonce 7 bị tiêu thụ trong lúc chờ lưu
    const save = await postJson(`http://127.0.0.1:${port}/bundle`, bundleMeta(keccak256(signedTx)));
    expect(save.status).toBe(409);
    expect(save.json.error).toMatch(/nonce 7 .*đã bị tiêu thụ/);
    expect(relays, "không được đẩy bundle chết sang webapp").toHaveLength(0);
    expect(capturedTxs, "buffer không được xoá khi bị từ chối").toHaveLength(1);
  });

  it("nonce còn tươi ⇒ vẫn relay đúng bundle (không hồi quy)", async () => {
    chain.state.pending = 7; // ca trước vừa mô phỏng "nonce bị tiêu thụ"; đây là ca nonce còn sống
    const save = await postJson(`http://127.0.0.1:${port}/bundle`, bundleMeta(capturedTxs[0].hash));
    expect(save.status, save.text).toBe(200);
    expect(save.json).toMatchObject({ ok: true, saved: true });
    expect(relays).toHaveLength(1);
    expect(relays[0].url).toMatch(/\/api\/presign$/);
    expect(relays[0].body.withdrawals[0].signedTx).toBeTruthy();
    expect(capturedTxs, "lưu thành công thì buffer được dọn").toHaveLength(0);
  });

  it("không đọc được nonce on-chain ⇒ vẫn relay (fail open)", async () => {
    capturedTxs.length = 0;
    relays.length = 0;
    const signedTx = await signWithdrawTx({ nonce: 8 });
    chain.state.pending = 8;
    await postJson(`http://127.0.0.1:${port}/`, {
      jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: [signedTx],
    });
    expect(capturedTxs).toHaveLength(1);

    chain.state.down = true;
    const save = await postJson(`http://127.0.0.1:${port}/bundle`, { ...bundleMeta(keccak256(signedTx)), nonce: 8 });
    expect(save.status, save.text).toBe(200);
    expect(relays).toHaveLength(1);
  });
});
