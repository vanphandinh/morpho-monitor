/**
 * Webapp server bootstrap.
 *
 * Chỉ còn: load cấu hình, đọc webapp.html, inject `window.MORPHO_CONFIG`
 * (derive từ shared.mjs), SSL, gắn handler từ webapp-handler.mjs, listen.
 * Business logic nằm trong webapp-handler.mjs để test import được mà không
 * kích hoạt listen.
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WEBAPP_PORT,
  PRESIGNED_FILE,
  MARKETS_FILE,
  USE_SSL,
  SSL_CERT_PATH,
  SSL_KEY_PATH,
} from "./shared.mjs";
import { addGlobalErrorHandlers } from "./rpc-client.mjs";
import { loadMarkets } from "./market-config.mjs";
import { createRequestHandler } from "./webapp-handler.mjs";
import { buildWebappConfig, injectWebappConfig, assertWebappAuthConfig } from "./webapp-config.mjs";

// Global error handlers — prevent crashes from unhandled rejections
addGlobalErrorHandlers("webapp-server");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = WEBAPP_PORT;
const WEBAPP_FILE = path.join(__dirname, "webapp.html");
// Audit A.1: script chính là module riêng (được lint + test) chứ không còn inline
// trong webapp.html, nên nó phải được phục vụ như một file tĩnh.
const WEBAPP_APP_FILE = path.join(__dirname, "webapp-app.mjs");
// Audit A.1b: logic thuần dùng chung cho browser và test. webapp-app.mjs import
// nó qua `./webapp-logic.mjs` nên nó cũng phải được phục vụ như file tĩnh.
const WEBAPP_LOGIC_FILE = path.join(__dirname, "webapp-logic.mjs");
// Audit P2.7: module browser tách tiếp từ webapp-app.mjs — app import chúng nên
// chúng cũng phải được phục vụ như file tĩnh (xem handler `scripts`).
const WEBAPP_RENDER_FILE = path.join(__dirname, "webapp-render.mjs");
const WEBAPP_WALLET_FILE = path.join(__dirname, "webapp-wallet.mjs");
const PRESIGNED_PATH = path.join(__dirname, PRESIGNED_FILE);

const configuredMarkets = loadMarkets(path.join(__dirname, MARKETS_FILE));

// Read the HTML file once at startup
let htmlContent;
try {
  htmlContent = fs.readFileSync(WEBAPP_FILE, "utf-8");
} catch {
  console.error(`❌ Không tìm thấy ${WEBAPP_FILE}. Hãy tạo file webapp.html trước.`);
  process.exit(1);
}

// Inject config via JSON.stringify — tránh XSS break-out từ env values.
// Fail-fast khi thiếu LENDER_ADDRESS / PROXY_RPC_URL (C3) thay vì để browser
// rơi về http://127.0.0.1:8545 (sai hoàn toàn trên VPS/HTTPS).
let webappConfig;
try {
  webappConfig = buildWebappConfig({ markets: configuredMarkets });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
htmlContent = injectWebappConfig(htmlContent, webappConfig);

// Đọc module app một lần lúc khởi động, fail-fast cùng kiểu với webapp.html:
// thiếu file này thì trang tải được nhưng KHÔNG có JS nào chạy (UI chết lặng).
let appScript;
try {
  appScript = fs.readFileSync(WEBAPP_APP_FILE, "utf-8");
} catch {
  console.error(`❌ Không tìm thấy ${WEBAPP_APP_FILE}. Đây là script chính của webapp.`);
  process.exit(1);
}

// Thiếu file này thì import `./webapp-logic.mjs` của app trả 404 và UI chết lặng
// (không handler nào tồn tại) ⇒ fail-fast cùng kiểu với webapp.html.
let logicScript;
try {
  logicScript = fs.readFileSync(WEBAPP_LOGIC_FILE, "utf-8");
} catch {
  console.error(`❌ Không tìm thấy ${WEBAPP_LOGIC_FILE}. webapp-app.mjs import file này.`);
  process.exit(1);
}

// Audit P2.7: cùng lý do — thiếu file thì import trong app trả 404 ⇒ UI chết lặng.
const readBrowserModule = (file, importedBy) => {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    console.error(`❌ Không tìm thấy ${file}. ${importedBy} import file này.`);
    process.exit(1);
  }
};
const renderScript = readBrowserModule(WEBAPP_RENDER_FILE, "webapp-app.mjs");
const walletScript = readBrowserModule(WEBAPP_WALLET_FILE, "webapp-app.mjs");

// Fail closed khi thiếu WEBAPP_PASSWORD (audit 2026-09-24 P1): không password
// thì MỌI request (kể cả DELETE bundle đã ký) đều được coi là đã xác thực.
// Dev local chủ đích tắt bằng WEBAPP_ALLOW_INSECURE=1 (kèm cảnh báo đỏ).
let authMode;
try {
  authMode = assertWebappAuthConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (authMode.warning) console.warn(authMode.warning);

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

const createServer = (requestHandler) =>
  sslOptions ? https.createServer(sslOptions, requestHandler) : http.createServer(requestHandler);

const handler = createRequestHandler({
  presignedPath: PRESIGNED_PATH,
  markets: configuredMarkets,
  content: htmlContent,
  appScript,
  logicScript,
  scripts: {
    "webapp-render.mjs": renderScript,
    "webapp-wallet.mjs": walletScript,
  },
});

// Challenge/rate-limit state nằm trong closure của handler (M10); vòng dọn
// định kỳ do bootstrap sở hữu và được cancel khi shutdown.
const cleanupTimer = handler.startCleanupTimer();

const server = createServer(handler);

const proto = sslOptions ? "https" : "http";
server.listen(PORT, "0.0.0.0", () => {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Morpho Blue - Withdrawal Webapp Server               ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  🌐 Webapp đang chạy tại: ${proto}://0.0.0.0:${PORT}`);
  console.log(`  📱 Local:               ${proto}://localhost:${PORT}`);
  console.log(`  🔌 Proxy RPC (browser): ${webappConfig.proxyRpcUrl}`);
  console.log(`  📡 Browser RPC URLs:    ${webappConfig.rpcUrls.length} endpoint(s)`);
  console.log(`  👛 Lender:              ${webappConfig.lenderAddress}`);
  if (sslOptions) console.log(`  🔒 SSL enabled — cert: ${SSL_CERT_PATH}`);
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Nhấn Ctrl+C để dừng");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

const shutdown = (signal) => {
  console.log(`\n🛑 Nhận ${signal}, đang dừng server...`);
  if (cleanupTimer) clearInterval(cleanupTimer);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
