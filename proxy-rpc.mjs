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
} from "./shared.mjs";
import { createRobustPublicClient, addGlobalErrorHandlers } from "./rpc-client.mjs";
import { loadMarkets } from "./market-config.mjs";
import { createProxyRequestHandler, defaultBlockFallback } from "./proxy-dispatcher.mjs";

// Install global error handlers so unhandled RPC rejections don't crash the process
addGlobalErrorHandlers("proxy-rpc");

const PORT = PROXY_PORT || 8545;
const BIND_HOST = PROXY_HOST || "127.0.0.1";

// Market allow-list first: config errors must fail fast with an actionable message.
const configuredMarkets = loadMarkets(MARKETS_FILE);

// Robust public client with round-robin across all RPC URLs,
// retry with backoff, and circuit breaker per URL.
// Used for forwarding eth_getTransactionCount + startup block fetch.
const publicClient = createRobustPublicClient(RPC_URLS);
console.log(`[proxy] Khởi tạo với ${RPC_URLS.length} RPC endpoint(s)`);

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
  client: publicClient,
  capturedTxs,
  blockFallback,
  webappUrl: WEBAPP_URL,
  webappPassword: WEBAPP_PASSWORD,
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
