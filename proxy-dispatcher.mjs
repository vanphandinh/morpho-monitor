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
  readBodyLimited,
} from "./shared.mjs";
import { requireLenderOrInternal } from "./auth.mjs";
import {
  verifyPresignedBundle,
  matchTiersToCaptured,
  resolveBundleServerUrl,
  clearMatchedCaptured,
  assertCaptureTx,
  assertNonceNotConsumed,
  computeMarketId,
  NONCE_MISMATCH,
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

  /**
   * Nonce on-chain `pending` của lender (D20), `null` khi không đọc được.
   *
   * Proxy là nơi duy nhất thấy CẢ signed tx LẪN trạng thái nonce on-chain, nên đây là chỗ đúng để
   * từ chối chữ ký ở nonce đã chết. Không đọc được ⇒ trả `null` + warn (caller fail OPEN: thiếu bằng
   * chứng không phải bằng chứng nonce đã chết — và D16/D17 vẫn dọn được phía sau).
   */
  async function readPendingNonce() {
    try {
      const value = await client.getTransactionCount({ address: lenderAddress, blockTag: "pending" });
      return value ?? null;
    } catch (err) {
      warn(
        `[proxy] ⚠️  không đọc được nonce on-chain của ${String(lenderAddress).slice(0, 10)}…: ${err.message} — ` +
        `bỏ qua kiểm nonce (fail open; registry vẫn bị D16/D17 dọn phía sau)`
      );
      return null;
    }
  }

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
        // D20: từ chối chữ ký ở nonce đã tiêu thụ NGAY TẠI PROXY. Trước fix, nonce không được hỏi
        // ở đây: một client khác (script tự viết, ví tự thêm nonce, tab cũ) vẫn capture được chữ ký
        // ở nonce đã chết, rồi /bundle ghép nó vào registry (lúc đó chỉ còn D16/D17 dọn sau).
        const onChainPendingNonce = await readPendingNonce();
        const nonceCheck = assertNonceNotConsumed({
          txNonce: check.decoded.nonce,
          onChainPendingNonce,
        });
        if (!nonceCheck.ok) {
          warn(`[proxy] ❌ Từ chối capture ở nonce đã tiêu thụ: ${nonceCheck.error}`);
          return new Error(nonceCheck.error);
        }
        const txHash = keccak256(signedTx); // real tx hash — dùng để match tier sau này
        if (capturedTxs.length >= MAX_CAPTURED_TXS) {
          capturedTxs.shift();
        }
        capturedTxs.push({
          hash: txHash,
          signedTx,
          capturedAt: new Date().toISOString(),
          nonce: check.decoded.nonce,          // D20: bằng chứng dùng lại ở cổng /bundle
          nonceOnChain: onChainPendingNonce,   // nguyên trạng lúc capture (null = không đọc được)
        });
        log(
          `[proxy] 📝 Captured signed tx #${capturedTxs.length}: ${txHash.slice(0, 10)}... (from ${check.from.slice(0, 10)}..., ` +
          `nonce=${check.decoded.nonce ?? "?"}, on-chain pending=${onChainPendingNonce ?? "không đọc được"})`
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
          // viem RpcRequestError nén chi tiết thật vào `details`/`cause` còn
          // shortMessage luôn là "RPC Request failed." — nếu log shortMessage
          // thì sim revert bình thường (thường gặp với Ambire deployless sim)
          // bị ngộ nhận là lỗi mạng. Lộ chi tiết thật ra lỗi trả về ví.
          const msg = err?.details || err?.cause?.message || err?.shortMessage || err?.message || String(err);
          const hasStateOverride = params?.[2] != null;
          const to = (params?.[0] || {}).to;

          // Log hygiene (phân tích log VPS 2026-09-25):
          // - "execution reverted" là kết quả sim hợp lệ; lỗi đã passthrough
          //   cho ví nên warn thêm chỉ là noise.
          // - eth_call KHÔNG có `to` (deployless sim) bị nhiều provider từ chối
          //   ("Transaction creation failed." / "Missing or invalid parameters.")
          //   — nén thành 1 dòng gọn thay vì format đầy đủ.
          if (to == null) {
            warn(`[proxy] eth_call no-to (deployless sim) bị từ chối: ${msg}`);
          } else if (!/revert/i.test(msg)) {
            warn(
              `[proxy] eth_call forwarding failed${hasStateOverride ? " (stateOverride)" : ""} → ${to}: ${msg}`
            );
          }
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
      // Debug probe thủ công (từ 2026-09-24 webapp không còn gọi — cổng
      // preflight H5 đã gỡ): trả về server "morpho-proxy" để xác nhận nhanh
      // "RPC này có phải proxy của mình không" qua curl. Node thật/public sẽ
      // trả "method not found" ⇒ phân biệt được proxy với node khác.
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

  return { handleRpc, capturedTxs, blockFallback, readPendingNonce };
}

/**
 * Tập method tối thiểu cho một VÍ dùng proxy như node của nó (audit vòng 5, O2).
 *
 * Chỉ áp dụng khi bật `PROXY_ALLOW_PUBLIC_RPC=1` (opt-in) — mặc định không giới hạn gì.
 * Đây là công tắc CHÍNH SÁCH, không phải hàng rào chống lạm dụng: hàng rào thật là
 * `PROXY_RPC_RATE_LIMIT` (đếm request theo IP).
 */
export const RPC_METHOD_ALLOW_LIST = [
  "eth_accounts", "eth_requestAccounts", "eth_chainId", "net_version",
  "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_createAccessList", "debug_traceCall",
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getProof",
  "eth_getBlockByNumber", "eth_getTransactionCount", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_getLogs", "eth_sendRawTransaction",
  "eth_syncing", "net_listening", "net_peerCount",
  "web3_clientVersion", "eth_subscribe", "eth_unsubscribe",
];

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
 * @param {number} [deps.rpcRateLimit] - request/phút/IP cho nhánh JSON-RPC; 0 = không giới hạn
 * @param {string[]|null} [deps.rpcMethodAllowList] - null = không giới hạn method
 * @param {() => number} [deps.now]
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
  rpcRateLimit = 0,
  rpcRateLimitWindowMs = 60_000,
  rpcMethodAllowList = null,
  now = () => Date.now(),
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

  // ---- O2: giới hạn nhánh JSON-RPC (mặc định TẮT ⇒ hành vi y hệt trước) ----
  const rateLimitMax = Number(rpcRateLimit) > 0 ? Number(rpcRateLimit) : 0;
  const rateWindowMs = Number(rpcRateLimitWindowMs) > 0 ? Number(rpcRateLimitWindowMs) : 60_000;
  const allowedMethods = Array.isArray(rpcMethodAllowList) && rpcMethodAllowList.length > 0
    ? new Set(rpcMethodAllowList)
    : null;
  /** ip → { count, windowStart }. Chỉ tăng theo số IP thực sự gọi. */
  const rateByIp = new Map();
  const clientIp = (req) => req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown";
  /** Dọn entry cũ khi map phình ra — giữ chi phí O(1) bình thường. */
  const sweepRateMap = (t) => {
    if (rateByIp.size <= 1024) return;
    for (const [ip, entry] of rateByIp) if (t - entry.windowStart >= rateWindowMs) rateByIp.delete(ip);
  };
  /** true nếu request này vượt ngưỡng của IP nó. */
  const isRateLimited = (req) => {
    if (!rateLimitMax) return false;
    const ip = clientIp(req);
    const t = now();
    const entry = rateByIp.get(ip);
    if (!entry || t - entry.windowStart >= rateWindowMs) {
      rateByIp.set(ip, { count: 1, windowStart: t });
      sweepRateMap(t);
      return false;
    }
    entry.count += 1;
    return entry.count > rateLimitMax;
  };
  const methodBlocked = (method) => allowedMethods !== null && !allowedMethods.has(method);

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
            // Lệch nonce (chẩn đoán 2026-09-26): mã RIÊNG + hai số thật để webapp chỉ đúng đường
            // phục hồi. Ca này trước fix chỉ là 400 với chuỗi "tx nonce M !== bundle nonce N":
            // webapp không phân biệt được với bundle hỏng nên rơi vào nhánh "Lỗi proxy: …" chung,
            // bấm Lưu lặp đúng 400 đó, còn chữ ký ví (ở nonce ví tự chọn) thì nằm nguyên trong
            // buffer capture. Trả 409 như các cổng nonce khác (NONCE_CONSUMED / NONCE_NOT_CLAIMABLE).
            if (verified.nonceMismatch) {
              logger?.warn?.(
                `[proxy] ❌ Từ chối lưu bundle ở nonce ${meta.nonce}: ${verified.error}`
              );
              // Một tier lệch ⇒ một cặp số; trộn nonce giữa các tier ⇒ danh sách nonce tìm thấy.
              const { txNonce, txNonces, bundleNonce } = verified.nonceMismatch;
              res.writeHead(409, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                ok: false,
                error: `Calldata verify failed: ${verified.error}`,
                code: NONCE_MISMATCH,
                bundleNonce: bundleNonce ?? meta.nonce,
                ...(verified.index != null ? { index: verified.index } : {}),
                ...(txNonces ? { txNonces } : { txNonce }),
              }));
              return;
            }
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `Calldata verify failed: ${verified.error}` }));
            return;
          }

          // D20: cổng nonce thứ hai — giữa capture và lưu, nonce có thể bị tiêu thụ (market khác rút
          // trước, hoặc một tx khác chiếm mất nonce). Đọc MỘT lần cho cả bundle: mọi tier trong một
          // bundle dùng CÙNG một nonce (`verifyPresignedBundle` đã ghim `tx.nonce === bundle.nonce`).
          const nonceAtSave = await dispatcher.readPendingNonce();
          const capturedByHash = new Map(
            capturedTxs.map((tx) => [tx.hash?.toLowerCase(), tx])
          );
          for (const hash of matched.matchedHashes) {
            const entry = capturedByHash.get(hash?.toLowerCase());
            const gate = assertNonceNotConsumed({
              // Thiếu nonce ghi lúc capture (buffer dựng tay) ⇒ dùng meta: verify ở trên đã đối chiếu
              // chính `meta.nonce` với từng tx trong bundle.
              txNonce: entry?.nonce ?? meta.nonce,
              onChainPendingNonce: nonceAtSave,
            });
            if (!gate.ok) {
              logger?.warn?.(`[proxy] ❌ Từ chối lưu bundle: ${gate.error}`);
              res.writeHead(409, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: gate.error, code: gate.code }));
              return;
            }
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
            // Mã lỗi của server phải XUYÊN QUA relay (audit D15–D20): webapp dựa vào `code` để tự
            // phục hồi (vd `NONCE_NOT_CLAIMABLE` của D16 ⇒ lấy lại nonce + vô hiệu chữ ký ở nonce đã
            // chết). Trước fix, code bị nuốt ở đây nên client chỉ còn chuỗi lỗi để đọc.
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: false,
              error: "Server rejected: " + (postResult.error || "unknown"),
              ...(postResult.code ? { code: postResult.code } : {}),
            }));
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
      // Không trả signedTx — chỉ metadata + hash để debug.
      // `nonce`/`nonceOnChain` (chẩn đoán 2026-09-26): nonce của tx CHỈ nằm trong byte đã ký, mà
      // webapp không bao giờ giữ signedTx ⇒ đây là nguồn DUY NHẤT để webapp dò xem ví có tôn trọng
      // nonce nó gửi hay không. Trước fix hai trường này bị bỏ, nên "ví ký sai nonce" chỉ lộ ra ở
      // bước Lưu dưới dạng 400 trần. Nonce là dữ liệu công khai on-chain, không phải bí mật.
      res.end(JSON.stringify({
        count: capturedTxs.length,
        // `Number(...)` chứ không trả nguyên giá trị: `readPendingNonce()` có thể là BigInt (client
        // bọc/thử nghiệm), mà `JSON.stringify` ném "Do not know how to serialize a BigInt" — lỗi
        // rơi SAU writeHead nên response không bao giờ kết thúc (test treo 5s thay vì đọc được JSON).
        txs: capturedTxs.map(t => ({
          hash: t.hash,
          capturedAt: t.capturedAt,
          nonce: t.nonce == null ? null : Number(t.nonce),
          nonceOnChain: t.nonceOnChain == null ? null : Number(t.nonceOnChain),
        })),
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

      // O2: chặn theo IP trước khi forward sang RPC_URLS của operator. Trả lỗi JSON-RPC
      // (HTTP 200) để ví hiểu là lỗi RPC, không phải mạng chết — ví không đọc HTTP status
      // của JSON-RPC, và 429 sẽ khiến nó thử lại như lỗi tạm thời.
      if (isRateLimited(req)) {
        logger?.warn?.(
          `[proxy] rate limit: ${clientIp(req)} vượt ${rateLimitMax} req/${Math.round(rateWindowMs / 1000)}s — trả -32005`
        );
        res.writeHead(200);
        res.end(safeStringify(jsonRpcError(Array.isArray(request) ? null : request.id, -32005,
          `Rate limit exceeded: ${rateLimitMax} requests per ${Math.round(rateWindowMs / 1000)}s per IP (PROXY_RPC_RATE_LIMIT)`)));
        return;
      }

      // Handle batch
      if (Array.isArray(request)) {
        const responses = await Promise.all(request.map(async (r) => {
          if (methodBlocked(r.method)) {
            return jsonRpcError(r.id, -32601, `Method not allowed on this proxy: ${r.method} (PROXY_ALLOW_PUBLIC_RPC)`);
          }
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
      if (methodBlocked(request.method)) {
        res.writeHead(200);
        res.end(safeStringify(jsonRpcError(request.id, -32601,
          `Method not allowed on this proxy: ${request.method} (PROXY_ALLOW_PUBLIC_RPC)`)));
        return;
      }
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
