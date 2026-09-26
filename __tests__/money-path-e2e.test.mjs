/**
 * DRILL ĐƯỜNG TIỀN XUYÊN 3 TIẾN TRÌNH (audit 2026-09-26, P4).
 *
 * Trước file này, mọi mảnh của đường tiền đều đã được chứng minh RIÊNG: proxy capture
 * (`proxy-capture.test.mjs`), lưu bundle + guard qua HTTP (`presigned-api.test.mjs`), vòng đời
 * claim (`presigned-lifecycle.test.mjs`), tranh nonce giữa hai tiến trình
 * (`two-process-race.test.mjs`). Chưa có gì chạy **cả chuỗi** trên các tiến trình THẬT, nên
 * đúng những seam nằm GIỮA các mảnh là chỗ không cổng nào chạm tới — ví dụ hợp đồng lỗi HTTP
 * (413 không bao giờ tới client, xem D13) hay phí ký lệch nhau giữa các tier.
 *
 * Drill này nối đúng chuỗi đó, trên HTTP thật, không mock tầng nào của production:
 *
 *   1. ví ký một tx `withdraw()` thật (khoá test) → `eth_sendRawTransaction` vào PROXY
 *      (`createProxyRequestHandler` trên http.Server) → qua capture gate thật;
 *   2. `POST /bundle` → proxy ghép tier ↔ signed tx đã capture rồi POST sang WEBAPP
 *      (`createRequestHandler` trên http.Server) → verify calldata + ghi registry qua file lock;
 *   3. broadcaster THẬT (`broadcastEligible`) claim rung ở nonce pending → gửi **đúng byte** đã
 *      ký lên chain giả → receipt có block identity → terminal + expire rung cùng nonce;
 *   4. chu kỳ sau: registry idle, KHÔNG broadcast lần hai.
 *
 * Khẳng định nằm trên ARTIFACT: byte gửi lên chain, file registry trên đĩa, số lần gửi.
 *
 * LƯU Ý VỀ THỨ TỰ IMPORT: `LENDER_ADDRESS` được `shared.mjs` đọc lúc evaluate, nên biến môi
 * trường phải được đặt TRƯỚC khi import handler. Vì vậy hai handler (kéo theo `shared.mjs`)
 * được import ĐỘNG bên dưới; các import tĩnh ở đây chỉ chạm viem / pure rules / store
 * (không có module nào trong số đó đọc env).
 */
import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFunctionData, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeMarketId, MORPHO_WITHDRAW_ABI, verifyPresignedBundle } from "../presign-verify.mjs";
import { bundleKey, readRegistry, updateRegistry } from "../presigned-store.mjs";
import { broadcastEligible } from "../presigned-broadcast.mjs";
import { computeDrainThreshold, shouldBroadcastPresigned } from "../monitor-rules.mjs";

// Khoá test công khai (Hardhat account #1). KHÔNG phải ví thật, không có tiền.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(TEST_KEY);
const LENDER = account.address;

// PHẢI đặt trước khi import hai handler (xem ghi chú đầu file).
process.env.LENDER_ADDRESS = LENDER;

const { createProxyRequestHandler } = await import("../proxy-dispatcher.mjs");
const { createRequestHandler } = await import("../webapp-handler.mjs");
const { LENDER_ADDRESS } = await import("../shared.mjs");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MARKET_PARAMS_A = {
  loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  oracle: "0x" + "3".repeat(40),
  irm: "0x" + "4".repeat(40),
  lltv: 860000000000000000n,
};
const MARKET_PARAMS_B = { ...MARKET_PARAMS_A, oracle: "0x" + "6".repeat(40) };
const MARKET_A = computeMarketId(MARKET_PARAMS_A);
const MARKET_B = computeMarketId(MARKET_PARAMS_B);
const NONCE = 11;
const AMOUNT_WEI = 50_000_000n; // 50 USDC

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

/** Chain giả tối thiểu — đủ cho broadcaster: nonce, gửi raw, receipt MINED. */
function createFakeChain() {
  const sent = [];
  const receipts = new Map();
  return {
    sent,
    /** `pending` = nonce rung đang chờ; `latest`/`blockNumber` = bằng chứng nonce đã tiêu thụ. */
    async getTransactionCount({ blockTag } = {}) {
      if (blockTag === "pending" || blockTag === "latest" || blockTag == null) return BigInt(NONCE);
      return BigInt(NONCE) + 1n;
    },
    async getBlockNumber() {
      return 1_000n;
    },
    async sendRawTransaction({ serializedTransaction }) {
      sent.push(serializedTransaction);
      const hash = keccak256(serializedTransaction);
      // Mined ngay, có block identity (điều kiện để chuyển terminal — invariant #4).
      receipts.set(hash, {
        blockHash: "0x" + "b".repeat(64),
        blockNumber: 999n,
        transactionHash: hash,
        status: "success",
      });
      return hash;
    },
    async getTransactionReceipt({ hash }) {
      return receipts.get(hash) ?? null;
    },
    async waitForTransactionReceipt({ hash }) {
      return receipts.get(hash) ?? null;
    },
  };
}

/** Ký một tx `withdraw()` thật bằng khoá test — cùng ABI mà production verify. */
function signWithdraw(marketParams) {
  return account.signTransaction({
    to: MORPHO,
    data: encodeFunctionData({
      abi: MORPHO_WITHDRAW_ABI,
      functionName: "withdraw",
      args: [marketParams, AMOUNT_WEI, 0n, LENDER, LENDER],
    }),
    nonce: NONCE,
    chainId: 1,
    gas: 200_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    type: "eip1559",
    value: 0n,
  });
}

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

const startServer = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
};

const snapshotFor = (id) => ({
  id,
  market: { liquidity: 1_000_000_000n, totalSupplyAssets: 2_000_000_000n, totalSupplyShares: 2_000_000_000n },
  position: { supplyAssets: 1_000_000_000n },
  suddenDrainMultiplier: 2,
  minLiquidityWei: 1n,
});

describe("đường tiền xuyên 3 tiến trình (proxy → webapp → monitor)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-path-"));
  const registryPath = path.join(dir, "presigned.json");
  const markets = [{ id: MARKET_A }, { id: MARKET_B }];
  const fakeChain = createFakeChain();
  let webapp;
  let proxy;

  afterAll(async () => {
    await new Promise((resolve) => webapp?.server.close(resolve));
    await new Promise((resolve) => proxy?.server.close(resolve));
  });

  it("tự kiểm phép cài đặt: LENDER_ADDRESS phải là ví test (nếu không, drill vô nghĩa)", () => {
    // Guard cho chính test này: nếu một module nào đó đã evaluate `shared.mjs` trước khi ta đặt
    // env (đổi cấu hình vitest sang không-isolate, hoặc import tĩnh bị thêm lại), handler sẽ
    // verify theo địa chỉ khác và drill sẽ "xanh" vì lý do sai.
    expect(LENDER_ADDRESS.toLowerCase()).toBe(LENDER.toLowerCase());
  });

  it("chạy trọn chuỗi: capture → lưu registry → claim → broadcast đúng BYTE đã ký → terminal", async () => {
    // ---- Dựng hai tiến trình THẬT (webapp trước, để proxy biết URL relay) ----
    const webappHandler = createRequestHandler({ presignedPath: registryPath, markets, content: "<html>drill</html>" });
    webapp = await startServer(webappHandler);
    const proxyHandler = createProxyRequestHandler({
      markets,
      lenderAddress: LENDER,
      morphoBlueAddress: MORPHO,
      client: fakeChain,
      capturedTxs: [],
      webappUrl: `http://127.0.0.1:${webapp.port}`,
      logger: silentLogger,
    });
    proxy = await startServer(proxyHandler);
    const rpcUrl = `http://127.0.0.1:${proxy.port}/`;
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;

    // ---- Bước 1: ví "gửi" tx đã ký vào proxy (JSON-RPC thật) ----
    const signedA = await signWithdraw(MARKET_PARAMS_A);
    const signedB = await signWithdraw(MARKET_PARAMS_B);
    const captureA = await postJson(rpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [signedA] });
    expect(captureA.json.result).toBe(keccak256(signedA));
    const captureB = await postJson(rpcUrl, { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: [signedB] });
    expect(captureB.json.result).toBe(keccak256(signedB));

    // ---- Bước 2: webapp gửi metadata tier → proxy ghép → webapp verify + ghi registry ----
    const bundleMeta = (marketId, txHash) => ({
      tiers: [{ amount: "50", amountWei: AMOUNT_WEI.toString(), amountFormatted: "50 USDC", label: "50 USDC", txHash }],
      marketId,
      lenderAddress: LENDER,
      morphoBlueAddress: MORPHO,
      nonce: NONCE,
      gas: "200000",
      maxFeePerGas: "30000000000",
      maxPriorityFeePerGas: "1000000000",
      loanToken: { symbol: "USDC", decimals: 6 },
    });
    // Cùng một nonce cho HAI market: đây là kịch bản tranh nonce thật của multi-market.
    // Mỗi lần /bundle lấy đúng tx đã capture của nó (clearMatchedCaptured xoá sau khi lưu).
    const saveA = await postJson(`${proxyUrl}/bundle`, bundleMeta(MARKET_A, keccak256(signedA)));
    expect(saveA.status, saveA.text).toBe(200);
    expect(saveA.json.ok).toBe(true);
    const saveB = await postJson(`${proxyUrl}/bundle`, bundleMeta(MARKET_B, keccak256(signedB)));
    expect(saveB.json.ok).toBe(true);

    const saved = readRegistry(registryPath);
    expect(saved.version).toBe(3);
    expect(saved.bundles[bundleKey(MARKET_A, NONCE)].status).toBe("pending");
    expect(saved.bundles[bundleKey(MARKET_B, NONCE)].status).toBe("pending");
    // Byte đã ký phải nằm NGUYÊN VẸN trong registry — không có tầng nào ký lại hộ.
    expect(saved.bundles[bundleKey(MARKET_A, NONCE)].withdrawals[0].signedTx).toBe(signedA);

    // ---- Bước 3: monitor THẬT claim rồi broadcast (chain giả) ----
    const snapshots = new Map([[MARKET_A, snapshotFor(MARKET_A)], [MARKET_B, snapshotFor(MARKET_B)]]);
    const runCycle = () =>
      broadcastEligible({
        client: fakeChain,
        lenderAddress: LENDER,
        filePath: registryPath,
        snapshots,
        updateRegistry,
        verifyBundle: (bundle, marketId) => verifyPresignedBundle(bundle, { morphoBlueAddress: MORPHO, lenderAddress: LENDER, marketId }),
        isEligible: (snapshot) =>
          shouldBroadcastPresigned(
            snapshot.market.liquidity,
            computeDrainThreshold(snapshot.position.supplyAssets, snapshot.suddenDrainMultiplier),
            snapshot.minLiquidityWei
          ),
        logger: silentLogger,
      });

    const claim = await runCycle();
    expect(claim.id).toBe(bundleKey(MARKET_A, NONCE)); // markets.json order thắng khi cùng nonce
    // `claim.bundle` là ẢNH CHỤP lúc claim (phase 1 ghi `broadcasting`); trạng thái terminal được
    // ghi ở phase 2 trên một bản registry đọc lại từ đĩa — nên chân lý phải đọc từ FILE bên dưới,
    // không đọc từ object trả về.
    expect(claim.bundle.broadcastingTier).toBe("50 USDC");

    // Đúng MỘT tx lên chain, và nó là đúng byte ví đã ký (không phải bản viết lại).
    expect(fakeChain.sent).toHaveLength(1);
    expect(fakeChain.sent[0]).toBe(signedA);

    const after = readRegistry(registryPath);
    const entryA = after.bundles[bundleKey(MARKET_A, NONCE)];
    const entryB = after.bundles[bundleKey(MARKET_B, NONCE)];
    expect(entryA.status).toBe("submitted");
    expect(entryA.terminalAt).toBeTruthy();
    expect(entryA.rawTx).toBeUndefined(); // byte đã bỏ sau khi terminal
    expect(entryB.status).toBe("expired"); // rung cùng nonce bị receipt tiêu thụ ⇒ hết cửa mine
    expect(after.consumedNonce).toBeGreaterThanOrEqual(NONCE);

    // ---- Bước 4: chu kỳ sau — registry idle, KHÔNG broadcast lần hai ----
    const idle = await runCycle();
    expect(idle.idle).toBe(true);
    expect(fakeChain.sent).toHaveLength(1);
  });
});
