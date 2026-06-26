import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WEBAPP_PORT,
  PRESIGNED_FILE,
  PROXY_RPC_URL,
  WEBAPP_PASSWORD,
  MARKET_ID,
  LENDER_ADDRESS,
  SESSION_EXPIRY_MS,
  CHALLENGE_EXPIRY_MS,
  recoverSignerAddress,
  createSessionToken,
  verifyToken,
  checkInternalSecret,
} from "./shared.mjs";
import { addGlobalErrorHandlers } from "./rpc-client.mjs";

// Global error handlers — prevent crashes from unhandled rejections
addGlobalErrorHandlers("webapp-server");

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

// Inject config into HTML via a single <script> block before </head>
htmlContent = htmlContent.replace(
  "</head>",
  `<script>window.MORPHO_CONFIG={marketId:"${MARKET_ID}",lenderAddress:"${LENDER_ADDRESS}",proxyRpcUrl:"${PROXY_RPC_URL}"}</script></head>`
);

// ============================================================
// AUTH STATE (in-memory)
// ============================================================
const challenges = new Map(); // challenge → { address, createdAt, expiresAt }

// Write lock for POST /api/presign — serializes concurrent reads/writes to presigned.json
let writeLock = Promise.resolve();

// Rate limit for /api/challenge: max 10 requests per minute per IP
const challengeRateLimit = new Map(); // IP → { count, windowStart }

// Clean up expired challenges and rate limit entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of challenges) {
    if (now > val.expiresAt) challenges.delete(key);
  }
  // Clean stale rate limit entries (older than 1 minute)
  for (const [ip, entry] of challengeRateLimit) {
    if (now - entry.windowStart > 60_000) challengeRateLimit.delete(ip);
  }
}, 2 * 60 * 1000);

// Log configuration
if (WEBAPP_PASSWORD) {
  console.log(`[presign] ✅ Presign endpoints configured. Proxy URL: ${PROXY_RPC_URL}`);
  console.log(`[presign] 🔐 Auth mode: wallet signature (Bearer token). Internal secret: configured.`);
} else {
  console.warn("[presign] ⚠️  WEBAPP_PASSWORD chưa được cấu hình. Tất cả endpoint sẽ không được bảo vệ (ai cũng truy cập được).");
}
console.log(`[presign] 👛 Lender address: ${LENDER_ADDRESS}`);

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

// Auth helpers (verifyToken, checkInternalSecret) imported from shared.mjs.
// verifyToken is called with LENDER_ADDRESS as devAddress so dev mode returns the correct lender.

const server = http.createServer((req, res) => {
  // ---- Auth: static HTML page is now public (auth via wallet in JS) ----
  // No Basic Auth prompt on page load — the frontend handles sign-in.

  // ---- API: GET /api/challenge — tạo challenge để user ký (không cần auth) ----
  if (req.method === "GET" && req.url === "/api/challenge") {
    // Rate limit: max 10 challenges per minute per IP
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
               req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const rl = challengeRateLimit.get(ip);
    if (rl && now - rl.windowStart < 60_000) {
      if (rl.count >= 10) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Too many requests. Try again later." }));
        return;
      }
      rl.count++;
    } else {
      challengeRateLimit.set(ip, { count: 1, windowStart: now });
    }

    const challenge = crypto.randomBytes(16).toString("hex");
    challenges.set(challenge, {
      address: LENDER_ADDRESS,
      createdAt: now,
      expiresAt: now + CHALLENGE_EXPIRY_MS,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      challenge,
      message: `Morpho Blue Monitor\n\nSign in with address: ${LENDER_ADDRESS}\nNonce: ${challenge}`,
      expiresAt: new Date(now + CHALLENGE_EXPIRY_MS).toISOString(),
    }));
    return;
  }

  // ---- API: POST /api/auth — verify signature + issue session token (không cần auth) ----
  if (req.method === "POST" && req.url === "/api/auth") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("error", (err) => {
      console.error(`[webapp] Request stream error on /api/auth: ${err.message}`);
    });
    req.on("end", async () => {
      try {
        const { address, signature, challenge: challengeStr } = JSON.parse(body);

        if (!address || !signature || !challengeStr) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing address, signature, or challenge" }));
          return;
        }

        // Verify challenge
        const challengeData = challenges.get(challengeStr);
        if (!challengeData || Date.now() > challengeData.expiresAt) {
          challenges.delete(challengeStr);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Challenge expired or invalid. Request a new one." }));
          return;
        }

        // Verify address matches lender
        if (address.toLowerCase() !== LENDER_ADDRESS.toLowerCase()) {
          challenges.delete(challengeStr);
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `Address ${address} is not the lender (${LENDER_ADDRESS})` }));
          return;
        }

        // Recover signer from signature
        const message = `Morpho Blue Monitor\n\nSign in with address: ${LENDER_ADDRESS}\nNonce: ${challengeStr}`;
        const recovered = await recoverSignerAddress(message, signature);

        if (!recovered || recovered !== LENDER_ADDRESS.toLowerCase()) {
          challenges.delete(challengeStr);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Signature verification failed" }));
          return;
        }

        // Issue session token (HMAC-based — verifiable by both webapp and proxy)
        challenges.delete(challengeStr);
        const token = createSessionToken(recovered, SESSION_EXPIRY_MS);
        const now = Date.now();
        const expiresAt = new Date(now + SESSION_EXPIRY_MS).toISOString();

        console.log(
          `[${new Date().toISOString()}] 🔑 New session for ${recovered} ` +
            `(expires ${new Date(now + SESSION_EXPIRY_MS).toLocaleString("vi-VN")})`
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          token,
          expiresAt,
        }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // ---- API: GET /api/presign — trả về summary bundle hiện tại (không signedTx) ----
  if (req.method === "GET" && req.url === "/api/presign") {
    if (!verifyToken(req, LENDER_ADDRESS)) {
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
    if (!verifyToken(req, LENDER_ADDRESS)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("error", (err) => {
      console.error(`[webapp] Request stream error on /api/bundle: ${err.message}`);
    });
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
  // Match sensitive extensions even when followed by query string (e.g. /.env?foo)
  const blockedPatterns = [/\.(json|env|log|tar)(\?|$)/i];
  if (req.method === "GET" && blockedPatterns.some(p => p.test(req.url))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  // ---- API: DELETE /api/presign — xóa toàn bộ bundle hoặc 1 tier (?tier=N) ----
  if (req.method === "DELETE" && req.url.startsWith("/api/presign")) {
    if (!verifyToken(req, LENDER_ADDRESS)) {
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

  // ---- API: POST /api/presign — nhận signed bundle từ proxy (internal) hoặc user (Bearer) ----
  if (req.method === "POST" && req.url === "/api/presign") {
    // Accept either internal secret (proxy→webapp) or Bearer token (user→webapp)
    const session = verifyToken(req, LENDER_ADDRESS);
    const isInternal = checkInternalSecret(req);
    if (!session && !isInternal) {
      console.warn(
        `[${new Date().toISOString()}] 🔒 POST /api/presign rejected: invalid credentials`
      );
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("error", (err) => {
      console.error(`[webapp] Request stream error on /api/presign: ${err.message}`);
    });
    req.on("end", () => {
      // Serialize writes to presigned.json: chain onto the previous write's
      // promise so concurrent requests don't race on file reads/writes.
      const doWrite = () => {
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
      };

      // Chain onto write lock to serialize concurrent presigned.json access
      writeLock = writeLock.then(doWrite, doWrite);
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
