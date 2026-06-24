import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEBAPP_PORT } from "./shared.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = WEBAPP_PORT;
const WEBAPP_FILE = path.join(__dirname, "webapp.html");

// Read the HTML file once at startup
let htmlContent = null;
try {
  htmlContent = fs.readFileSync(WEBAPP_FILE, "utf-8");
} catch {
  console.error(`❌ Không tìm thấy ${WEBAPP_FILE}. Hãy tạo file webapp.html trước.`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  // Handle response stream errors (e.g., client disconnects mid-write)
  // Without this, EPIPE/ECONNRESET crash the server.
  res.on("error", (err) => {
    if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
      console.error(`[${new Date().toISOString()}] ⚠️ Response error:`, err.message);
    }
  });

  // Only serve webapp.html at any path (SPA-style — query params pass through)
  res.writeHead(200);
  res.end(htmlContent);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Morpho Blue - Withdrawal Webapp Server               ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  🌐 Webapp đang chạy tại: http://0.0.0.0:${PORT}`);
  console.log(`  📱 Local:               http://localhost:${PORT}`);
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Nhấn Ctrl+C để dừng");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`\n🛑 Nhận ${signal}, đang dừng server...`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
