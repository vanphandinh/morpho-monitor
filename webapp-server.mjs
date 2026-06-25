import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEBAPP_PORT, PRESIGNED_FILE, PROXY_RPC_URL, WEBAPP_PASSWORD } from "./shared.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = WEBAPP_PORT;
const WEBAPP_FILE = path.join(__dirname, "webapp.html");
const PRESIGNED_PATH = path.join(__dirname, PRESIGNED_FILE);

// Read the HTML file once at startup
let htmlContent = null;
try {
  htmlContent = fs.readFileSync(WEBAPP_FILE, "utf-8");
} catch {
  console.error(`❌ Không tìm thấy ${WEBAPP_FILE}. Hãy tạo file webapp.html trước.`);
  process.exit(1);
}

// Inject proxy URL into HTML (not a secret — just tells frontend where proxy is)
htmlContent = htmlContent.replace(
  '<meta name="presigned-proxy-url" content="REPLACE_AT_RUNTIME">',
  `<meta name="presigned-proxy-url" content="${PROXY_RPC_URL}">`
);

// Log presign configuration
if (WEBAPP_PASSWORD) {
  console.log(`[presign] ✅ Presign endpoints configured. Proxy URL: ${PROXY_RPC_URL}`);
} else {
  console.warn("[presign] ⚠️  WEBAPP_PASSWORD chưa được cấu hình. Tất cả endpoint sẽ không được bảo vệ.");
}

/**
 * Check if the request has valid HTTP Basic Auth credentials.
 * Returns true if WEBAPP_PASSWORD is set and the password matches.
 */
function checkBasicAuth(req) {
  if (!WEBAPP_PASSWORD) return false;
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

const server = http.createServer((req, res) => {
  // ---- Basic Auth cho webapp (không áp dụng cho API routes) ----
  if (WEBAPP_PASSWORD && !req.url.startsWith("/api/")) {
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Basic ")) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Morpho Blue"',
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Unauthorized");
      return;
    }
    const [, encoded] = auth.split(" ");
    const [user, pass] = Buffer.from(encoded, "base64").toString("utf-8").split(":");
    if (pass !== WEBAPP_PASSWORD) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Morpho Blue"',
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Unauthorized");
      return;
    }
  }

  // ---- API: GET /api/presign — trả về summary bundle hiện tại (không signedTx) ----
  if (req.method === "GET" && req.url === "/api/presign") {
    if (!checkBasicAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }
    // Trả về summary — không bao gồm signedTx hex
    try {
      if (fs.existsSync(PRESIGNED_PATH)) {
        const raw = fs.readFileSync(PRESIGNED_PATH, "utf-8");
        const bundle = JSON.parse(raw);
        const summary = {
          ok: true,
          exists: true,
          status: bundle.status || "unknown",
          nonce: bundle.nonce,
          createdAt: bundle.createdAt,
          tiers: (bundle.withdrawals || []).map(w => ({
            label: w.label,
            amountFormatted: w.amountFormatted,
            amountWei: w.amountWei,
          })),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summary));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, exists: false }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, exists: false, error: err.message }));
    }
    return;
  }

  // ---- API: POST /api/bundle — relay metadata từ frontend sang proxy ----
  if (req.method === "POST" && req.url === "/api/bundle") {
    if (!checkBasicAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const proxyUrl = PROXY_RPC_URL.replace(/\/+$/, "");
        const authHeader = WEBAPP_PASSWORD
          ? "Basic " + Buffer.from(":" + WEBAPP_PASSWORD).toString("base64")
          : null;
        const proxyResp = await fetch(`${proxyUrl}/bundle`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { "Authorization": authHeader } : {}),
          },
          body,
        });
        const result = await proxyResp.json();
        res.writeHead(proxyResp.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Proxy unreachable: " + err.message }));
      }
    });
    return;
  }

  // ---- Block access to sensitive files (.json, .env, etc.) ----
  const blockedPatterns = [/\.json$/i, /\.env$/i, /\.log$/i, /\.tar$/i];
  if (req.method === "GET" && blockedPatterns.some(p => p.test(req.url))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  // ---- API: DELETE /api/presign — xóa toàn bộ bundle hoặc 1 tier (?tier=N) ----
  if (req.method === "DELETE" && req.url.startsWith("/api/presign")) {
    if (!checkBasicAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    // Parse ?tier=N
    const urlObj = new URL(req.url, "http://localhost");
    const tierIdx = urlObj.searchParams.get("tier");

    try {
      if (tierIdx !== null && fs.existsSync(PRESIGNED_PATH)) {
        // Xóa 1 tier
        const raw = fs.readFileSync(PRESIGNED_PATH, "utf-8");
        const bundle = JSON.parse(raw);
        const idx = parseInt(tierIdx, 10);
        if (isNaN(idx) || idx < 0 || idx >= (bundle.withdrawals?.length || 0)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `Invalid tier index: ${tierIdx}` }));
          return;
        }
        const removed = bundle.withdrawals.splice(idx, 1)[0];
        fs.writeFileSync(PRESIGNED_PATH, JSON.stringify(bundle, null, 2));
        try { fs.chmodSync(PRESIGNED_PATH, 0o600); } catch {}
        console.log(
          `[${new Date().toISOString()}] 🗑️  Removed tier "${removed.label}" from presigned bundle (${bundle.withdrawals.length} remaining)`
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, removed: removed.label, remaining: bundle.withdrawals.length }));
      } else {
        // Xóa toàn bộ
        let deleted = 0;
        for (const p of [PRESIGNED_PATH, PRESIGNED_PATH.replace(".json", ".used.json"), PRESIGNED_PATH.replace(".json", ".tmp.json")]) {
          if (fs.existsSync(p)) { fs.unlinkSync(p); deleted++; }
        }
        console.log(
          `[${new Date().toISOString()}] 🗑️  Presigned bundle deleted (${deleted} files)`
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, deleted }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ---- API: POST /api/presign — nhận signed bundle từ webapp (merge với bundle cũ) ----
  if (req.method === "POST" && req.url === "/api/presign") {
    if (!checkBasicAuth(req)) {
      console.warn(
        `[${new Date().toISOString()}] 🔒 POST /api/presign rejected: invalid credentials`
      );
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const newBundle = JSON.parse(body);
        if (!newBundle.withdrawals || newBundle.withdrawals.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid bundle: withdrawals empty" }));
          return;
        }

        // Merge hoặc replace dựa trên nonce
        let merged = newBundle;
        let action = "saved";

        if (fs.existsSync(PRESIGNED_PATH)) {
          try {
            const old = JSON.parse(fs.readFileSync(PRESIGNED_PATH, "utf-8"));
            if (old.withdrawals && old.withdrawals.length > 0) {
              if (old.nonce === newBundle.nonce) {
                // Cùng nonce → merge: thêm tier mới, thay tier trùng amountWei
                const map = new Map();
                let added = 0, replaced = 0;
                for (const w of old.withdrawals) {
                  if (w.amountWei) map.set(w.amountWei, w);
                }
                for (const w of newBundle.withdrawals) {
                  if (!w.amountWei) continue;
                  if (map.has(w.amountWei)) replaced++; else added++;
                  map.set(w.amountWei, w);
                }
                merged = {
                  ...newBundle,
                  createdAt: old.createdAt,
                  updatedAt: new Date().toISOString(),
                  withdrawals: [...map.values()],
                };
                const parts = [];
                if (added > 0) parts.push(`${added} new`);
                if (replaced > 0) parts.push(`${replaced} updated`);
                if (map.size - added - replaced > 0) parts.push(`${map.size - added - replaced} kept`);
                action = `merged (${parts.join(", ")})`;
              } else {
                // Khác nonce → thay toàn bộ (phiên ký mới)
                action = "replaced (new nonce)";
              }
            }
          } catch { /* corrupt — overwrite */ }
        }

        // Atomic write
        const tmpPath = PRESIGNED_PATH.replace(".json", ".tmp.json");
        fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
        fs.renameSync(tmpPath, PRESIGNED_PATH);
        try { fs.chmodSync(PRESIGNED_PATH, 0o600); } catch {}

        console.log(
          `[${new Date().toISOString()}] 📝 Presigned bundle ${action}: ` +
            `${merged.withdrawals.length} tiers, nonce=${newBundle.nonce}`
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, tiers: merged.withdrawals.length, action }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

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
