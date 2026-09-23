/**
 * Importable JSON-RPC dispatcher + HTTP request handler cho capture proxy.
 *
 * Tách khỏi proxy-rpc.mjs vì module đó có top-level await (fetch block lúc
 * khởi động) và gọi `server.listen` — không thể import trong test. Nhờ vậy
 * production logic được test trực tiếp với fake client, không copy code.
 *
 * Audit 2026-09-23 (C1): `eth_sendRawTransaction` trước đây gọi biến
 * `configuredMarketIds` đã bị xoá ⇒ mọi capture ném ReferenceError. Nay đi
 * qua `requireConfiguredMarket` (assertConfiguredMarket) và được test.
 */
import { keccak256, toHex } from "viem";
import {
  MAX_BODY_BYTES,
  requireLenderOrInternal,
  readBodyLimited,
} from "./shared.mjs";
import {
  verifyPresignedBundle,
  matchTiersToCaptured,
  resolveBundleServerUrl,
  clearMatchedCaptured,
  assertCaptureTx,
  computeMarketId,
} from "./presign-verify.mjs";
import { requireConfiguredMarket } from "./market-config.mjs";

/** Bound the in-memory capture buffer (drop oldest) to cap memory/DoS surface. */
export const MAX_CAPTURED_TXS = 50;

/** Realistic mock block data used only when the upstream RPC is unreachable. */
export function defaultBlockFallback() {
  return {
    number: "0x1400000",
    hash: "0x" + "00".repeat(32),
    baseFee: 10_000_000_000n, // 10 gwei
  };
}

/**
 * Build the JSON-RPC method table. Same methods, mock values and error shapes
 * as the original inline handler.
 *
 * @param {object} deps
 * @param {Array<{id: string}>} deps.markets - configured market allow-list
 * @param {string} deps.lenderAddress - only this sender may be captured
 * @param {string} deps.morphoBlueAddress - Morpho Blue contract
 * @param {object} deps.client - viem public client (robust round-robin)
 * @param {Array} [deps.capturedTxs] - shared capture buffer (mutated in place)
 * @param {{ number: string, hash: string, baseFee: bigint }} [deps.blockFallback]
 * @param {object} [deps.logger] - console-like sink
 */
export function createRpcDispatcher({
  markets,
  lenderAddress,
  morphoBlueAddress,
  client,
  capturedTxs = [],
  blockFallback = defaultBlockFallback(),
  logger = console,
}) {
  const warn = (msg) => logger?.warn?.(msg);
  const log = (msg) => logger?.log?.(msg);
  const assertConfiguredMarket = (marketId) => requireConfiguredMarket(markets, marketId);

  async function handleRpc(method, params) {
    switch (method) {
      // === THE CAPTURE ===
      case "eth_sendRawTransaction": {
        const signedTx = params[0];
        const check = await assertCaptureTx(signedTx, {
          morphoBlueAddress,
          lenderAddress,
        });
        if (!check.ok) {
          warn(`[proxy] ❌ Từ chối capture: ${check.error}`);
          return new Error(check.error);
        }
        const capturedMarketId = computeMarketId(check.decoded.marketParams).toLowerCase();
        try {
          assertConfiguredMarket(capturedMarketId);
        } catch (err) {
          // Market isolation: never capture a tx for a market we do not monitor.
          warn(`[proxy] ❌ Từ chối capture: market ${capturedMarketId} không được cấu hình`);
          throw err;
        }
        const txHash = keccak256(signedTx); // real tx hash — dùng để match tier sau này
        if (capturedTxs.length >= MAX_CAPTURED_TXS) {
          capturedTxs.shift();
        }
        capturedTxs.push({
          hash: txHash,
          signedTx,
          capturedAt: new Date().toISOString(),
        });
        log(
          `[proxy] 📝 Captured signed tx #${capturedTxs.length}: ${txHash.slice(0, 10)}... (from ${check.from.slice(0, 10)}...)`
        );
        return txHash;
      }

      // === METHODS MOCKED FOR METAMASK ===
      case "eth_chainId":
        return "0x1";

      case "eth_blockNumber":
        try {
          return await client.getBlockNumber();
        } catch (err) {
          warn(`[proxy] eth_blockNumber forwarding failed: ${err.message}`);
          return blockFallback.number;
        }

      case "eth_getBalance":
        // Trả về 10 ETH (0x8AC7230489E80000) để ví không báo "insufficient balance"
        return "0x8AC7230489E80000";

      case "eth_gasPrice": {
        try {
          return await client.getGasPrice();
        } catch (err) {
          warn(`[proxy] eth_gasPrice forwarding failed: ${err.message}`);
          const gasPrice = (blockFallback.baseFee * 150n) / 100n;
          return "0x" + gasPrice.toString(16);
        }
      }

      case "eth_maxPriorityFeePerGas":
        try {
          return await client.estimateMaxPriorityFeePerGas();
        } catch (err) {
          warn(`[proxy] eth_maxPriorityFeePerGas forwarding failed: ${err.message}`);
          return "0x" + (1_000_000_000n).toString(16); // 1 gwei fallback
        }

      case "eth_feeHistory": {
        try {
          const blockCount = typeof params[0] === "number" ? params[0] : parseInt(String(params[0] || "0x4"), 16);
          const newestBlock = params[1] || "latest";
          const rewardPercentiles = params[2] || [25, 50, 75];
          return await client.getFeeHistory({ blockCount, newestBlock, rewardPercentiles });
        } catch (err) {
          warn(`[proxy] eth_feeHistory forwarding failed: ${err.message}`);
          return {
            oldestBlock: blockFallback.number,
            baseFeePerGas: ["0x" + blockFallback.baseFee.toString(16), "0x" + blockFallback.baseFee.toString(16)],
            reward: [["0x" + (1_000_000_000n).toString(16)]],
          };
        }
      }

      case "eth_estimateGas":
        return "0x" + (200000n).toString(16); // 200k gas for Morpho withdraw

      case "eth_getCode":
        try {
          const address = params[0];
          const blockTag = params[1] || "latest";
          // viem may return undefined for EOAs — JSON-RPC requires "0x"
          return (await client.getCode({ address, blockTag })) || "0x";
        } catch (err) {
          warn(`[proxy] eth_getCode forwarding failed: ${err.message}`);
          return "0x";
        }

      case "eth_call": {
        try {
          // Forward raw JSON-RPC so `from` (Ambire spoof origin) + state overrides (params[2])
          // are preserved. viem publicClient.call() drops `from` (expects `account`) and
          // never receives params[2] — causing SV_SPOOF_ORIGIN.
          // Round-robin transport already retries across all RPC URLs on any failure
          // (including execution revert), so Ambire deployless sims that fail on one
          // provider (e.g. Ankr) can still succeed on another.
          return await client.request({ method: "eth_call", params });
        } catch (err) {
          const msg = err?.shortMessage || err?.message || String(err);
          const hasStateOverride = params?.[2] != null;
          const to = (params?.[0] || {}).to || "?";
          warn(
            `[proxy] eth_call forwarding failed${hasStateOverride ? " (stateOverride)" : ""} → ${to}: ${msg}`
          );
          // Không trả "0x" giả — Ambire hiểu nhầm là success và parse sai portfolio.
          // HTTP handler sẽ emit jsonRpcError khi nhận Error.
          return new Error(msg);
        }
      }

      case "eth_getBlockByNumber": {
        try {
          const rawTag = params[0] || "latest";
          const fullTxObjects = params[1] === true || params[1] === "true";
          const blockParams = { includeTransactions: fullTxObjects };
          // Phân biệt block tag ("latest", "pending"...) với block number (hex)
          if (rawTag === "latest" || rawTag === "earliest" || rawTag === "pending" || rawTag === "safe" || rawTag === "finalized") {
            blockParams.blockTag = rawTag;
          } else {
            blockParams.blockNumber = BigInt(rawTag);
          }
          return await client.getBlock(blockParams);
        } catch (err) {
          warn(`[proxy] eth_getBlockByNumber forwarding failed: ${err.message}`);
          return {
            number: blockFallback.number,
            hash: blockFallback.hash,
            parentHash: keccak256(toHex(parseInt(blockFallback.number, 16) - 1)),
            timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
            baseFeePerGas: "0x" + blockFallback.baseFee.toString(16),
            gasLimit: "0x" + (30_000_000n).toString(16),
            gasUsed: "0x" + (10_000_000n).toString(16),
            miner: "0x95222290DD7278Aa3Ddd389Cc1E1d165CC4BAfe5",
            mixHash: "0x" + "00".repeat(32),
            nonce: "0x0000000000000000",
            receiptsRoot: keccak256(toHex(0)),
            sha3Uncles: keccak256(toHex(0)),
            size: "0x10000",
            stateRoot: keccak256(toHex(1)),
            totalDifficulty: "0x0",
            transactionsRoot: keccak256(toHex(2)),
            uncles: [],
            transactions: [],
            logsBloom: "0x" + "00".repeat(256),
            extraData: "0x",
            difficulty: "0x0",
          };
        }
      }

      case "eth_getTransactionReceipt": {
        try {
          return await client.getTransactionReceipt({ hash: params[0] });
        } catch {
          return null;
        }
      }

      case "eth_getLogs": {
        try {
          const filter = params[0] || {};
          return await client.getLogs(filter);
        } catch (err) {
          warn(`[proxy] eth_getLogs forwarding failed: ${err.message}`);
          return [];
        }
      }

      case "eth_getTransactionByHash": {
        try {
          return await client.getTransaction({ hash: params[0] });
        } catch {
          return null;
        }
      }

      case "eth_getTransactionCount": {
        // Forward to real RPC to get the actual on-chain nonce.
        const address = params[0];
        const blockTag = params[1] || "latest";
        const count = await client.getTransactionCount({ address, blockTag });
        log(
          `[proxy] eth_getTransactionCount: address=${address.slice(0, 10)}..., blockTag=${blockTag}, nonce=${count}`
        );
        return "0x" + count.toString(16);
      }

      case "eth_getStorageAt": {
        try {
          const address = params[0];
          const slot = params[1];
          const blockTag = params[2] || "latest";
          return await client.getStorageAt({ address, slot, blockTag });
        } catch (err) {
          warn(`[proxy] eth_getStorageAt forwarding failed: ${err.message}`);
          return "0x" + "00".repeat(32);
        }
      }

      case "eth_getProof":
        return null;

      case "eth_createAccessList": {
        // Rabby gọi để tạo access list trước khi simulate — trả về rỗng
        return { accessList: [], gasUsed: "0x" + (150000n).toString(16) };
      }

      case "debug_traceCall": {
        // Rabby gọi để trace/simulate — trả về rỗng
        return { failed: false, gas: 150000, returnValue: "0x", structLogs: [] };
      }

      case "eth_syncing":
        return false;

      case "eth_accounts":
        return [];

      case "eth_requestAccounts":
        return [];

      case "web3_clientVersion":
        return "MorphoProxy/v1";

      // === PROXY IDENTITY (B2) ===
      // Webapp preflight: chỉ khi ví trỏ vào proxy thì method này mới trả về
      // server "morpho-proxy". Node thật sẽ trả "method not found" hoặc giá
      // trị khác ⇒ chặn ký để không broadcast thật lên mainnet.
      case "morpho_proxyInfo":
        return { server: "morpho-proxy", chainId: 1 };

      case "web3_sha3":
        return params[0] ? "0x" + "00".repeat(32) : null;

      case "eth_subscribe":
        return "0x0";

      case "eth_unsubscribe":
        return true;

      // === NET METHODS ===
      case "net_version":
        return "1";

      case "net_listening":
        return true;

      case "net_peerCount":
        return "0x0";

      // === FALLBACK ===
      default:
        warn(`[proxy] ⚠️  Unhandled method: ${method} — returning null`);
        return null;
    }
  }

  return { handleRpc, capturedTxs, blockFallback };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function safeStringify(obj) {
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === "bigint") return "0x" + value.toString(16);
    return value;
  });
}

/**
 * Full HTTP request handler: CORS, /bundle, /captured, DELETE /captured and
 * JSON-RPC (single + batch). Injectable deps keep tests on production code.
 *
 * @param {object} deps
 * @param {Array<{id: string}>} deps.markets
 * @param {string} deps.lenderAddress
 * @param {string} deps.morphoBlueAddress
 * @param {object} deps.client
 * @param {Array} deps.capturedTxs
 * @param {string} [deps.webappUrl] - base URL of the webapp (SSRF-safe relay target)
 * @param {string} [deps.webappPassword] - internal Basic secret
 * @param {number} [deps.maxBodyBytes]
 * @param {object} [deps.logger]
 * @param {typeof globalThis.fetch} [deps.fetchImpl]
 */
export function createProxyRequestHandler({
  markets,
  lenderAddress,
  morphoBlueAddress,
  client,
  capturedTxs = [],
  blockFallback,
  webappUrl,
  webappPassword = "",
  maxBodyBytes = MAX_BODY_BYTES,
  logger = console,
  fetchImpl = fetch,
}) {
  const dispatcher = createRpcDispatcher({
    markets,
    lenderAddress,
    morphoBlueAddress,
    client,
    capturedTxs,
    blockFallback,
    logger,
  });
  const authz = (req) => requireLenderOrInternal(req, lenderAddress);
  // Mutex: only one bundle operation at a time to prevent concurrent
  // requests from racing on the shared capturedTxs buffer.
  let bundleInProgress = false;

  return async (req, res) => {
    // CORS: mirror request origin (required for credentialed requests)
    const origin = req.headers["origin"];
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- API: POST /bundle — webapp gửi metadata, proxy ghép bundle → POST server ----
    if (req.method === "POST" && req.url === "/bundle") {
      if (!authz(req).ok) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }

      if (bundleInProgress) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Bundle operation already in progress" }));
        return;
      }
      bundleInProgress = true;

      try {
        let body;
        try {
          body = await readBodyLimited(req, maxBodyBytes);
        } catch (err) {
          const status = err.code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
          return;
        }

        try {
          const meta = JSON.parse(body);
          if (!Array.isArray(meta.tiers) || meta.tiers.length === 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "tiers empty" }));
            return;
          }
          if (capturedTxs.length === 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "No captured transactions" }));
            return;
          }

          const matched = matchTiersToCaptured(meta.tiers, capturedTxs);
          if (!matched.ok) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: false,
              error: matched.error,
              unmatched: matched.unmatched || null,
            }));
            return;
          }

          const withdrawals = matched.withdrawals.map((w) => ({
            ...w,
            label: w.label || `${meta.loanToken?.symbol || "tokens"}`,
            nonce: meta.nonce,
          }));

          const bundle = {
            version: 2,
            createdAt: new Date().toISOString(),
            chainId: 1,
            morphoBlueAddress: meta.morphoBlueAddress || morphoBlueAddress,
            marketId: requireConfiguredMarket(markets, meta.marketId),
            lenderAddress: meta.lenderAddress || lenderAddress,
            nonce: meta.nonce,
            gas: meta.gas || "200000",
            maxFeePerGas: meta.maxFeePerGas,
            maxPriorityFeePerGas: meta.maxPriorityFeePerGas,
            loanToken: meta.loanToken || { symbol: "USDC", decimals: 6 },
            withdrawals,
            status: "pending",
          };

          // Verify Morpho withdraw calldata trước khi POST sang webapp
          const verified = await verifyPresignedBundle(bundle, {
            morphoBlueAddress,
            lenderAddress,
            marketId: requireConfiguredMarket(markets, meta.marketId),
          });
          if (!verified.ok) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `Calldata verify failed: ${verified.error}` }));
            return;
          }

          // Luôn dùng WEBAPP_URL — không bao giờ tin meta.serverUrl (SSRF)
          const serverUrl = resolveBundleServerUrl(meta, webappUrl);
          const authHeader = webappPassword
            ? "Basic " + Buffer.from(":" + webappPassword).toString("base64")
            : null;
          const postResp = await fetchImpl(`${serverUrl}/api/presign`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(authHeader ? { Authorization: authHeader } : {}),
            },
            body: JSON.stringify(bundle),
          });

          let postResult;
          const respText = await postResp.text();
          try {
            postResult = JSON.parse(respText);
          } catch {
            postResult = { ok: false, error: `Non-JSON response (${postResp.status}): ${respText.slice(0, 200)}` };
          }

          if (postResult.ok) {
            logger?.log?.(`[proxy] ✅ Bundle sent to server: ${withdrawals.length} tiers`);
            clearMatchedCaptured(capturedTxs, matched.matchedHashes);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, tiers: withdrawals.length, saved: true }));
          } else {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Server rejected: " + (postResult.error || "unknown") }));
          }
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      } finally {
        bundleInProgress = false;
      }
      return;
    }

    // ---- API: GET /captured — xem danh sách tx đã capture ----
    if (req.method === "GET" && req.url === "/captured") {
      if (!authz(req).ok) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      // Không trả signedTx — chỉ metadata + hash để debug
      res.end(JSON.stringify({
        count: capturedTxs.length,
        txs: capturedTxs.map(t => ({ hash: t.hash, capturedAt: t.capturedAt })),
      }));
      return;
    }

    // ---- API: DELETE /captured — xóa tất cả tx đã capture ----
    if (req.method === "DELETE" && req.url === "/captured") {
      if (!authz(req).ok) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }
      const count = capturedTxs.length;
      capturedTxs.length = 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, deleted: count }));
      return;
    }

    // ---- JSON-RPC ----
    if (req.method === "POST") {
      let body;
      try {
        body = await readBodyLimited(req, maxBodyBytes);
      } catch (err) {
        const status = err.code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(safeStringify(jsonRpcError(null, -32700, err.message)));
        return;
      }
      res.setHeader("Content-Type", "application/json");

      let request;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(safeStringify(jsonRpcError(null, -32700, "Parse error")));
        return;
      }

      // Handle batch
      if (Array.isArray(request)) {
        const responses = await Promise.all(request.map(async (r) => {
          try {
            const result = await dispatcher.handleRpc(r.method, r.params);
            if (result instanceof Error) {
              return jsonRpcError(r.id, -32603, result.message);
            }
            return jsonRpcResult(r.id, result);
          } catch (err) {
            logger?.error?.(`[proxy] RPC error (${r.method}): ${err.message}`);
            return jsonRpcError(r.id, -32603, `RPC error: ${err.message}`);
          }
        }));
        res.writeHead(200);
        res.end(safeStringify(responses));
        return;
      }

      // Single request
      try {
        const result = await dispatcher.handleRpc(request.method, request.params);
        if (result instanceof Error) {
          res.writeHead(200);
          res.end(safeStringify(jsonRpcError(request.id, -32603, result.message)));
          return;
        }
        res.writeHead(200);
        res.end(safeStringify(jsonRpcResult(request.id, result)));
      } catch (err) {
        logger?.error?.(`[proxy] RPC error (${request.method}): ${err.message}`);
        res.writeHead(200);
        res.end(safeStringify(jsonRpcError(request.id, -32603, `RPC error: ${err.message}`)));
      }
      return;
    }

    // ---- Anything else ----
    res.writeHead(404);
    res.end("proxy-rpc: use POST for JSON-RPC");
  };
}
