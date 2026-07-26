import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { keccak256, toHex } from "viem";
import {
  RPC_URLS,
  PROXY_PORT,
  PROXY_HOST,
  WEBAPP_URL,
  WEBAPP_PASSWORD,
  USE_SSL,
  SSL_CERT_PATH,
  SSL_KEY_PATH,
  MARKET_ID,
  LENDER_ADDRESS,
  MORPHO_BLUE_ADDRESS,
  MAX_BODY_BYTES,
  requireLenderOrInternal,
  readBodyLimited,
} from "./shared.mjs";
import { createRobustPublicClient, addGlobalErrorHandlers } from "./rpc-client.mjs";
import {
  verifyPresignedBundle,
  matchTiersToCaptured,
  resolveBundleServerUrl,
  clearMatchedCaptured,
  assertCaptureTx,
} from "./presign-verify.mjs";

// Install global error handlers so unhandled RPC rejections don't crash the process
addGlobalErrorHandlers("proxy-rpc");

const PORT = PROXY_PORT || 8545;
const BIND_HOST = PROXY_HOST || "127.0.0.1";
const MAX_CAPTURED_TXS = 50;

// ============================================================
// STATE
// ============================================================
const capturedTxs = []; // [{ hash: "0x...", signedTx: "0x...", capturedAt: ISO }]
let bundleInProgress = false; // mutex for POST /bundle — prevents concurrent race on capturedTxs

// ============================================================
// FAKE RESPONSES
// ============================================================

// Robust public client with round-robin across all RPC URLs,
// retry with backoff, and circuit breaker per URL.
// Used for forwarding eth_getTransactionCount + startup block fetch.
const publicClient = createRobustPublicClient(RPC_URLS);
console.log(`[proxy] Khởi tạo với ${RPC_URLS.length} RPC endpoint(s)`);

// Fetch real block number once at startup for realistic mock
let blockNumber = "0x1400000";
let blockHash = "0x" + "00".repeat(32);
let baseFee = 10_000_000_000n; // 10 gwei fallback
{
  try {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    blockNumber = "0x" + block.number.toString(16);
    blockHash = block.hash ?? blockHash;
    baseFee = block.baseFeePerGas ?? baseFee;
    console.log(`[proxy] Connected to real RPC — block #${block.number.toString()}, baseFee=${(baseFee / 1_000_000_000n).toString()} Gwei`);
  } catch {
    // Generate realistic-looking block hash from block number
    blockHash = keccak256(toHex(parseInt(blockNumber, 16)));
    console.log(`[proxy] RPC unreachable — using mock block data`);
  }
}

console.log(`[proxy] Block: ${parseInt(blockNumber, 16)} (${blockHash.slice(0, 10)}...)`);

// ============================================================
// JSON-RPC HANDLER
// ============================================================
async function handleRpc(method, params) {
  switch (method) {
    // === THE CAPTURE ===
    case "eth_sendRawTransaction": {
      const signedTx = params[0];
      const check = await assertCaptureTx(signedTx, {
        morphoBlueAddress: MORPHO_BLUE_ADDRESS,
        lenderAddress: LENDER_ADDRESS,
        marketId: MARKET_ID,
      });
      if (!check.ok) {
        console.warn(`[proxy] ❌ Từ chối capture: ${check.error}`);
        return new Error(check.error);
      }
      const txHash = keccak256(signedTx); // real tx hash — dùng để match tier sau này
      if (capturedTxs.length >= MAX_CAPTURED_TXS) {
        // Drop oldest to bound memory / DoS surface
        capturedTxs.shift();
      }
      capturedTxs.push({
        hash: txHash,
        signedTx,
        capturedAt: new Date().toISOString(),
      });
      console.log(
        `[proxy] 📝 Captured signed tx #${capturedTxs.length}: ${txHash.slice(0, 10)}... (from ${check.from.slice(0, 10)}...)`
      );
      return txHash;
    }

    // === METHODS MOCKED FOR METAMASK ===
    case "eth_chainId":
      return "0x1";

    case "eth_blockNumber":
      try {
        return await publicClient.getBlockNumber();
      } catch (err) {
        console.warn(`[proxy] eth_blockNumber forwarding failed: ${err.message}`);
        return blockNumber;
      }

    case "eth_getBalance":
      // Trả về 10 ETH (0x8AC7230489E80000) để ví không báo "insufficient balance"
      return "0x8AC7230489E80000";

    case "eth_gasPrice": {
      try {
        return await publicClient.getGasPrice();
      } catch (err) {
        console.warn(`[proxy] eth_gasPrice forwarding failed: ${err.message}`);
        const gasPrice = (baseFee * 150n) / 100n;
        return "0x" + gasPrice.toString(16);
      }
    }

    case "eth_maxPriorityFeePerGas":
      try {
        return await publicClient.estimateMaxPriorityFeePerGas();
      } catch (err) {
        console.warn(`[proxy] eth_maxPriorityFeePerGas forwarding failed: ${err.message}`);
        return "0x" + (1_000_000_000n).toString(16); // 1 gwei fallback
      }

    case "eth_feeHistory": {
      try {
        const blockCount = typeof params[0] === "number" ? params[0] : parseInt(String(params[0] || "0x4"), 16);
        const newestBlock = params[1] || "latest";
        const rewardPercentiles = params[2] || [25, 50, 75];
        return await publicClient.getFeeHistory({ blockCount, newestBlock, rewardPercentiles });
      } catch (err) {
        console.warn(`[proxy] eth_feeHistory forwarding failed: ${err.message}`);
        return {
          oldestBlock: blockNumber,
          baseFeePerGas: ["0x" + baseFee.toString(16), "0x" + baseFee.toString(16)],
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
        return await publicClient.getCode({ address, blockTag });
      } catch (err) {
        console.warn(`[proxy] eth_getCode forwarding failed: ${err.message}`);
        return "0x";
      }

    case "eth_call": {
      try {
        const callParams = params[0] || {};
        const blockTag = params[1] || "latest";
        return await publicClient.call({ ...callParams, blockTag });
      } catch (err) {
        console.warn(`[proxy] eth_call forwarding failed: ${err.message}`);
        return "0x";
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
        return await publicClient.getBlock(blockParams);
      } catch (err) {
        console.warn(`[proxy] eth_getBlockByNumber forwarding failed: ${err.message}`);
        return {
          number: blockNumber,
          hash: blockHash,
          parentHash: keccak256(toHex(parseInt(blockNumber, 16) - 1)),
          timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
          baseFeePerGas: "0x" + baseFee.toString(16),
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
        return await publicClient.getTransactionReceipt({ hash: params[0] });
      } catch {
        return null;
      }
    }

    case "eth_getLogs": {
      try {
        const filter = params[0] || {};
        return await publicClient.getLogs(filter);
      } catch (err) {
        console.warn(`[proxy] eth_getLogs forwarding failed: ${err.message}`);
        return [];
      }
    }

    case "eth_getTransactionByHash": {
      try {
        return await publicClient.getTransaction({ hash: params[0] });
      } catch {
        return null;
      }
    }

    case "eth_getTransactionCount": {
      // Forward to real RPC to get the actual on-chain nonce.
      const address = params[0];
      const blockTag = params[1] || "latest";
      const count = await publicClient.getTransactionCount({ address, blockTag });
      console.log(
        `[proxy] eth_getTransactionCount: address=${address.slice(0, 10)}..., blockTag=${blockTag}, nonce=${count}`
      );
      return "0x" + count.toString(16);
    }

    case "eth_getStorageAt": {
      try {
        const address = params[0];
        const slot = params[1];
        const blockTag = params[2] || "latest";
        return await publicClient.getStorageAt({ address, slot, blockTag });
      } catch (err) {
        console.warn(`[proxy] eth_getStorageAt forwarding failed: ${err.message}`);
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
      console.warn(`[proxy] ⚠️  Unhandled method: ${method} — returning null`);
      return null;
  }
}

// ============================================================
// HTTP SERVER
// ============================================================
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

// Auth helper (requireLenderOrInternal) imported from shared.mjs

// ---- SSL/TLS setup ----
let sslOptions = null;
if (USE_SSL) {
  try {
    sslOptions = {
      cert: fs.readFileSync(SSL_CERT_PATH, "utf-8"),
      key: fs.readFileSync(SSL_KEY_PATH, "utf-8"),
    };
  } catch (err) {
    console.error(`❌ Không đọc được chứng chỉ SSL: ${err.message}`);
    process.exit(1);
  }
}

// Conditional server: HTTPS nếu có cert, HTTP nếu không
const createServer = (handler) =>
  sslOptions ? https.createServer(sslOptions, handler) : http.createServer(handler);

const server = createServer(async (req, res) => {
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
    const authz = requireLenderOrInternal(req, LENDER_ADDRESS);
    if (!authz.ok) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    // Mutex: only one bundle operation at a time to prevent concurrent
    // requests from racing on the shared capturedTxs buffer.
    if (bundleInProgress) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Bundle operation already in progress" }));
      return;
    }
    bundleInProgress = true;

    try {
      let body;
      try {
        body = await readBodyLimited(req, MAX_BODY_BYTES);
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
          version: 1,
          createdAt: new Date().toISOString(),
          chainId: 1,
          morphoBlueAddress: meta.morphoBlueAddress || MORPHO_BLUE_ADDRESS,
          marketId: meta.marketId || MARKET_ID,
          lenderAddress: meta.lenderAddress || LENDER_ADDRESS,
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
          morphoBlueAddress: MORPHO_BLUE_ADDRESS,
          lenderAddress: LENDER_ADDRESS,
          marketId: MARKET_ID,
        });
        if (!verified.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `Calldata verify failed: ${verified.error}` }));
          return;
        }

        // Luôn dùng WEBAPP_URL — không bao giờ tin meta.serverUrl (SSRF)
        const serverUrl = resolveBundleServerUrl(meta, WEBAPP_URL);
        const authHeader = WEBAPP_PASSWORD
          ? "Basic " + Buffer.from(":" + WEBAPP_PASSWORD).toString("base64")
          : null;
        const postResp = await fetch(`${serverUrl}/api/presign`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { "Authorization": authHeader } : {}),
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
          console.log(`[proxy] ✅ Bundle sent to server: ${withdrawals.length} tiers`);
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
    const authz = requireLenderOrInternal(req, LENDER_ADDRESS);
    if (!authz.ok) {
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
    const authz = requireLenderOrInternal(req, LENDER_ADDRESS);
    if (!authz.ok) {
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
      body = await readBodyLimited(req, MAX_BODY_BYTES);
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
          const result = await handleRpc(r.method, r.params);
          if (result instanceof Error) {
            return jsonRpcError(r.id, -32603, result.message);
          }
          return jsonRpcResult(r.id, result);
        } catch (err) {
          console.error(`[proxy] RPC error (${r.method}): ${err.message}`);
          return jsonRpcError(r.id, -32603, `RPC error: ${err.message}`);
        }
      }));
      res.writeHead(200);
      res.end(safeStringify(responses));
      return;
    }

    // Single request
    try {
      const result = await handleRpc(request.method, request.params);
      if (result instanceof Error) {
        res.writeHead(200);
        res.end(safeStringify(jsonRpcError(request.id, -32603, result.message)));
        return;
      }
      res.writeHead(200);
      res.end(safeStringify(jsonRpcResult(request.id, result)));
    } catch (err) {
      console.error(`[proxy] RPC error (${request.method}): ${err.message}`);
      res.writeHead(200);
      res.end(safeStringify(jsonRpcError(request.id, -32603, `RPC error: ${err.message}`)));
    }
    return;
  }

  // ---- Anything else ----
  res.writeHead(404);
  res.end("proxy-rpc: use POST for JSON-RPC");
});

const proto = sslOptions ? "https" : "http";
server.listen(PORT, BIND_HOST, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Morpho Blue — RPC Proxy (Capture Signed Tx)          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  🔌 Proxy:    ${proto}://${BIND_HOST}:${PORT}`);
  console.log(`  📊 Status:   ${proto}://127.0.0.1:${PORT}/captured`);
  console.log(`  🔗 Bundle:   POST ${proto}://127.0.0.1:${PORT}/bundle`);
  console.log(`  👛 Capture chỉ chấp nhận tx from=${LENDER_ADDRESS?.slice(0, 10)}... (Morpho withdraw)`);
  if (BIND_HOST !== "127.0.0.1" && BIND_HOST !== "localhost") {
    console.warn(`  ⚠️  Proxy bind ${BIND_HOST} (public). JSON-RPC không auth — gate bằng sender=lender.`);
    if (!WEBAPP_PASSWORD) {
      console.warn(`  ⚠️  WEBAPP_PASSWORD trống — /bundle và /captured mở (dev mode). Nên đặt mật khẩu khi public.`);
    }
  }
  if (sslOptions) console.log(`  🔒 SSL enabled — cert: ${SSL_CERT_PATH}`);
  console.log("");
  console.log("  📋 Hướng dẫn MetaMask:");
  console.log(`     1. Settings → Networks → Add Network`);
  const hintHost = (BIND_HOST === "0.0.0.0" || BIND_HOST === "::") ? "<your-host>" : BIND_HOST;
  console.log(`     2. RPC URL: ${proto}://${hintHost}:${PORT}`);
  console.log(`     3. Chain ID: 1`);
  console.log(`     4. Symbol: ETH`);
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Nhấn Ctrl+C để dừng");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
});
