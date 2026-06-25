import http from "node:http";
import { createPublicClient, http as httpTransport, keccak256, toHex } from "viem";
import { mainnet } from "viem/chains";
import {
  RPC_URLS,
  PROXY_PORT,
  WEBAPP_URL,
  WEBAPP_PASSWORD,
  verifySessionToken,
} from "./shared.mjs";

const PORT = PROXY_PORT || 8545;

// ============================================================
// STATE
// ============================================================
const capturedTxs = []; // [{ hash: "0x...", signedTx: "0x...", capturedAt: ISO }]

// ============================================================
// FAKE RESPONSES
// ============================================================

// Public client for forwarding eth_getTransactionCount + startup block fetch
const publicClient = createPublicClient({
  chain: mainnet,
  transport: httpTransport(RPC_URLS[0]),
});

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
      const txHash = keccak256(signedTx); // real tx hash — dùng để match tier sau này
      capturedTxs.push({
        hash: txHash,
        signedTx,
        capturedAt: new Date().toISOString(),
      });
      console.log(
        `[proxy] 📝 Captured signed tx #${capturedTxs.length}: ${txHash.slice(0, 10)}...`
      );
      return txHash;
    }

    // === METHODS MOCKED FOR METAMASK ===
    case "eth_chainId":
      return "0x1";

    case "eth_blockNumber":
      return blockNumber;

    case "eth_getBalance":
      // Trả về 10 ETH (0x8AC7230489E80000) để ví không báo "insufficient balance"
      return "0x8AC7230489E80000";

    case "eth_gasPrice": {
      // Return current base fee * 1.5 as gas price
      const gasPrice = (baseFee * 150n) / 100n;
      return "0x" + gasPrice.toString(16);
    }

    case "eth_maxPriorityFeePerGas":
      return "0x" + (1_000_000_000n).toString(16); // 1 gwei

    case "eth_feeHistory": {
      // Return minimal fee history
      return {
        oldestBlock: blockNumber,
        baseFeePerGas: ["0x" + baseFee.toString(16), "0x" + baseFee.toString(16)],
        reward: [["0x" + (1_000_000_000n).toString(16)]],
      };
    }

    case "eth_estimateGas":
      return "0x" + (200000n).toString(16); // 200k gas for Morpho withdraw

    case "eth_getCode":
      return "0x";

    case "eth_call": {
      return "0x";
    }

    case "eth_getBlockByNumber": {
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

    case "eth_getTransactionReceipt":
      return null;

    case "eth_getLogs":
      return [];

    case "eth_getTransactionByHash":
      return null;

    case "eth_getTransactionCount": {
      // Forward to real RPC để ví lấy nonce thực tế on-chain
      try {
        const address = params[0];
        const blockTag = params[1] || "latest";
        const count = await publicClient.getTransactionCount({ address, blockTag });
        return "0x" + count.toString(16);
      } catch {
        return "0x0";
      }
    }

    case "eth_getStorageAt":
      return "0x" + "00".repeat(32);

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

/**
 * Verify a Bearer token (HMAC-based, verifiable by both webapp-server and proxy-rpc).
 * Returns { address, expiresAt } or null.
 */
function verifyToken(req) {
  if (!WEBAPP_PASSWORD) return { address: "dev", expiresAt: Infinity }; // dev mode
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return verifySessionToken(token);
}

/**
 * Check internal secret (Basic Auth with WEBAPP_PASSWORD).
 * Used for webapp-server → proxy internal communication.
 */
function checkInternalSecret(req) {
  if (!WEBAPP_PASSWORD) return true;
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Basic ")) return false;
  try {
    const [, encoded] = auth.split(" ");
    const [, pass] = Buffer.from(encoded, "base64").toString("utf-8").split(":");
    return pass === WEBAPP_PASSWORD;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
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
    // Accept either internal secret (webapp→proxy) or Bearer token (user→proxy)
    const session = verifyToken(req);
    const isInternal = checkInternalSecret(req);
    if (!session && !isInternal) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const meta = JSON.parse(body);
        if (capturedTxs.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "No captured transactions" }));
          return;
        }

        // Match captured txs with tier metadata by txHash
        const txMap = new Map(capturedTxs.map(tx => [tx.hash, tx.signedTx]));
        const withdrawals = meta.tiers.map((tier) => {
          const signedTx = tier.txHash ? txMap.get(tier.txHash) : null;
          if (!signedTx) return null;
          return {
            label: tier.label || `${tier.amount} ${meta.loanToken?.symbol || "tokens"}`,
            amountWei: tier.amountWei,
            amountFormatted: tier.amountFormatted,
            nonce: meta.nonce,
            signedTx,
          };
        }).filter(Boolean);

        if (withdrawals.length < meta.tiers.length) {
          console.warn(
            `[proxy] ⚠️  ${meta.tiers.length - withdrawals.length}/${meta.tiers.length} tiers ` +
            `không match được txHash (proxy đã restart?).`
          );
        }

        const bundle = {
          version: 1,
          createdAt: new Date().toISOString(),
          chainId: 1,
          morphoBlueAddress: meta.morphoBlueAddress,
          marketId: meta.marketId,
          lenderAddress: meta.lenderAddress,
          nonce: meta.nonce,
          gas: meta.gas || "200000",
          maxFeePerGas: meta.maxFeePerGas,
          maxPriorityFeePerGas: meta.maxPriorityFeePerGas,
          loanToken: meta.loanToken || { symbol: "USDC", decimals: 6 },
          withdrawals,
          status: "pending",
        };

        // POST to webapp server (internal, same Basic Auth)
        const serverUrl = meta.serverUrl || (WEBAPP_URL || "http://localhost:3000").replace(/\/+$/, "");
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
        const postResult = await postResp.json();

        if (postResult.ok) {
          console.log(`[proxy] ✅ Bundle sent to server: ${withdrawals.length} tiers`);
          // Clear captured txs after successful bundle
          capturedTxs.length = 0;
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
    });
    return;
  }

  // ---- API: GET /captured — xem danh sách tx đã capture ----
  if (req.method === "GET" && req.url === "/captured") {
    const session = verifyToken(req);
    const isInternal = checkInternalSecret(req);
    if (!session && !isInternal) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: capturedTxs.length, txs: capturedTxs.map(t => ({ capturedAt: t.capturedAt })) }));
    return;
  }

  // ---- API: DELETE /captured — xóa tất cả tx đã capture ----
  if (req.method === "DELETE" && req.url === "/captured") {
    const session = verifyToken(req);
    const isInternal = checkInternalSecret(req);
    if (!session && !isInternal) {
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
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      res.setHeader("Content-Type", "application/json");

      let request;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
        return;
      }

      // Handle batch
      if (Array.isArray(request)) {
        const responses = await Promise.all(request.map(async (r) => {
          const result = await handleRpc(r.method, r.params);
          if (result instanceof Error) {
            return jsonRpcError(r.id, -32603, result.message);
          }
          return jsonRpcResult(r.id, result);
        }));
        res.writeHead(200);
        res.end(JSON.stringify(responses));
        return;
      }

      // Single request
      const result = await handleRpc(request.method, request.params);
      if (result instanceof Error) {
        res.writeHead(200);
        res.end(JSON.stringify(jsonRpcError(request.id, -32603, result.message)));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(jsonRpcResult(request.id, result)));
    });
    return;
  }

  // ---- Anything else ----
  res.writeHead(404);
  res.end("proxy-rpc: use POST for JSON-RPC");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Morpho Blue — RPC Proxy (Capture Signed Tx)          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  🔌 Proxy:    http://127.0.0.1:${PORT}`);
  console.log(`  📊 Status:   http://127.0.0.1:${PORT}/captured`);
  console.log(`  🔗 Bundle:   POST http://127.0.0.1:${PORT}/bundle`);
  console.log("");
  console.log("  📋 Hướng dẫn MetaMask:");
  console.log(`     1. Settings → Networks → Add Network`);
  console.log(`     2. RPC URL: http://127.0.0.1:${PORT}`);
  console.log(`     3. Chain ID: 1`);
  console.log(`     4. Symbol: ETH`);
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Nhấn Ctrl+C để dừng");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
});
