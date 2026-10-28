/**
 * Proxy RPC bootstrap — capture MetaMask `eth_sendRawTransaction` trước khi
 * giao dịch được broadcast thật.
 *
 * Toàn bộ method JSON-RPC + HTTP handler nằm trong `proxy-dispatcher.mjs`
 * (import được, có test). File này chỉ còn: cấu hình, SSL, dữ liệu block
 * fallback, khởi tạo `capturedTxs` và `listen`.
 */
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
  MARKETS_FILE,
  LENDER_ADDRESS,
  MORPHO_BLUE_ADDRESS,
  CHAIN_ID,
  CHAIN_NAME,
  CHAIN,
  PROXY_RPC_RATE_LIMIT,
  PROXY_ALLOW_PUBLIC_RPC,
} from "./shared.mjs";
import { createChainBoundPublicClient, addGlobalErrorHandlers } from "./rpc-client.mjs";
import { loadMarkets } from "./market-config.mjs";
import { retryStartup } from "./startup-retry.mjs";
import { createProxyRequestHandler, defaultBlockFallback, RPC_METHOD_ALLOW_LIST } from "./proxy-dispatcher.mjs";
import { assertProxyAuthConfig } from "./webapp-config.mjs";

// Install global error handlers so unhandled RPC rejections don't crash the process
addGlobalErrorHandlers("proxy-rpc");

const PORT = PROXY_PORT || 8545;
const BIND_HOST = PROXY_HOST || "127.0.0.1";

// Auth policy TRƯỚC khi mở port (R3): bind public mà thiếu WEBAPP_PASSWORD thì
// /captured và DELETE /captured mở cho mọi người (dev mode). Fail-fast giống
// webapp-server, trừ khi deployment chấp nhận rủi ro bằng WEBAPP_ALLOW_INSECURE=1.
try {
  const authMode = assertProxyAuthConfig({
    host: BIND_HOST,
    rpcRateLimit: PROXY_RPC_RATE_LIMIT,
    allowPublicRpc: PROXY_ALLOW_PUBLIC_RPC,
  });
  if (authMode.warning) console.warn(authMode.warning);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Market allow-list next: config errors must fail fast with an actionable message.
const configuredMarkets = loadMarkets(MARKETS_FILE);

// Public client chỉ dùng các URL đã probe đúng CHAIN_ID. Mỗi URL sai chain bị
// loại trước khi bất kỳ eth_call/eth_getLogs/nonce nào được gửi tới nó.
// Used for forwarding eth_getTransactionCount + startup block fetch.
let publicClient;
let activeRpcCount = 0;
// Lúc container vừa lên, RPC có thể chưa sẵn sàng — thử lại có giới hạn. Sai
// chain là FATAL (retryStartup ném ngay), lỗi mạng mới được thử lại; nếu bỏ
// ngoài retry thì proxy chết ngay cả khi block fallback vẫn dùng được.
try {
  await retryStartup(async () => {
    const bound = await createChainBoundPublicClient(RPC_URLS);
    publicClient = bound.client;
    activeRpcCount = bound.urls.length;
  }, { label: "proxy" });
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
console.log(`[proxy] Chain: ${CHAIN_NAME} (${CHAIN_ID}) — Khởi tạo với ${activeRpcCount}/${RPC_URLS.length} RPC endpoint(s)`);

// Fetch real block number once at startup for realistic mock
const blockFallback = defaultBlockFallback();
{
  try {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    blockFallback.number = "0x" + block.number.toString(16);
    blockFallback.hash = block.hash ?? blockFallback.hash;
    blockFallback.baseFee = block.baseFeePerGas ?? blockFallback.baseFee;
    console.log(`[proxy] Connected to real RPC — block #${block.number.toString()}, baseFee=${(blockFallback.baseFee / 1_000_000_000n).toString()} Gwei`);
  } catch {
    // Generate realistic-looking block hash from block number
    blockFallback.hash = keccak256(toHex(parseInt(blockFallback.number, 16)));
    console.log(`[proxy] RPC unreachable — using mock block data`);
  }
}

console.log(`[proxy] Block: ${parseInt(blockFallback.number, 16)} (${blockFallback.hash.slice(0, 10)}...)`);

// ---- STATE ----
const capturedTxs = []; // [{ hash: "0x...", signedTx: "0x...", capturedAt: ISO }]

const handler = createProxyRequestHandler({
  markets: configuredMarkets,
  lenderAddress: LENDER_ADDRESS,
  morphoBlueAddress: MORPHO_BLUE_ADDRESS,
  chainId: CHAIN_ID,
  client: publicClient,
  capturedTxs,
  blockFallback,
  webappUrl: WEBAPP_URL,
  webappPassword: WEBAPP_PASSWORD,
  // O2: mặc định 0/null ⇒ hành vi y hệt trước khi thêm hai tuỳ chọn này.
  rpcRateLimit: PROXY_RPC_RATE_LIMIT,
  rpcMethodAllowList: PROXY_ALLOW_PUBLIC_RPC ? RPC_METHOD_ALLOW_LIST : null,
});

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
const createServer = (requestHandler) =>
  sslOptions ? https.createServer(sslOptions, requestHandler) : http.createServer(requestHandler);

const server = createServer(handler);

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
    console.warn(`  ⚠️  Proxy bind ${BIND_HOST} (public). JSON-RPC không auth — gate bằng sender=lender + market allow-list.`);
  }
  if (sslOptions) console.log(`  🔒 SSL enabled — cert: ${SSL_CERT_PATH}`);
  console.log("");
  console.log("  📋 Hướng dẫn MetaMask:");
  console.log(`     1. Settings → Networks → Add Network`);
  const hintHost = (BIND_HOST === "0.0.0.0" || BIND_HOST === "::") ? "<your-host>" : BIND_HOST;
  console.log(`     2. RPC URL: ${proto}://${hintHost}:${PORT}`);
  console.log(`     3. Chain ID: ${CHAIN_ID}`);
  console.log(`     4. Symbol: ${CHAIN.chain.nativeCurrency.symbol}`);
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Nhấn Ctrl+C để dừng");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
});
