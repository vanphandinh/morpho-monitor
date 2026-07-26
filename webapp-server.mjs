import http from "node:http";
import https from "node:https";
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
  MORPHO_BLUE_ADDRESS,
  SESSION_EXPIRY_MS,
  CHALLENGE_EXPIRY_MS,
  USE_SSL,
  SSL_CERT_PATH,
  SSL_KEY_PATH,
  MAX_BODY_BYTES,
  recoverSignerAddress,
  createSessionToken,
  verifyToken,
  checkInternalSecret,
  readBodyLimited,
  withFileLock,
} from "./shared.mjs";
import { addGlobalErrorHandlers } from "./rpc-client.mjs";
import { verifyPresignedBundle } from "./presign-verify.mjs";

// Global error handlers — prevent crashes from unhandled rejections
addGlobalErrorHandlers("webapp-server");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = WEBAPP_PORT;
const WEBAPP_FILE = path.join(__dirname, "webapp.html");
const PRESIGNED_PATH = path.join(__dirname, PRESIGNED_FILE);
const PRESIGNED_LOCK_PATH = PRESIGNED_PATH + ".lock";

// Read the HTML file once at startup
let htmlContent = null;
try {
  htmlContent = fs.readFileSync(WEBAPP_FILE, "utf-8");
} catch {
  console.error(`❌ Không tìm thấy ${WEBAPP_FILE}. Hãy tạo file webapp.html trước.`);
  process.exit(1);
}

// Inject config via JSON.stringify — tránh XSS break-out từ env values
// Escape `<` → `\u003c` để chặn `</script>` trong PROXY_RPC_URL / env poison
htmlContent = htmlContent.replace(
  "</head>",
  `<script>window.MORPHO_CONFIG=${JSON.stringify({
    marketId: MARKET_ID,
    lenderAddress: LENDER_ADDRESS,
    proxyRpcUrl: PROXY_RPC_URL,
  }).replace(/</g, "\\u003c")}</script></head>`
);

// ============================================================
// AUTH STATE (in-memory)
// ============================================================
const challenges = new Map(); // challenge → { address, createdAt, expiresAt }

// In-process write serialization + cross-process file lock for presigned.json
let writeLock = Promise.resolve();

function withPresignedWrite(fn) {
  const run = () => withFileLock(PRESIGNED_LOCK_PATH, fn);
  const p = writeLock.then(run, run);
  writeLock = p.catch(() => {});
  return p;
}

// Rate limit for /api/challenge: max 10 requests per minute per IP
const challengeRateLimit = new Map(); // IP → { count, windowStart }

// Clean up expired challenges and rate limit entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of challenges) {
    if (now > val.expiresAt) challenges.delete(key);
  }
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

const createServer = (handler) =>
  sslOptions ? https.createServer(sslOptions, handler) : http.createServer(handler);

const server = createServer(async (req, res) => {
  // ---- API: GET /api/challenge ----
  if (req.method === "GET" && req.url === "/api/challenge") {
    // Prefer socket address (X-Forwarded-For spoofable khi không có trusted proxy)
    const ip = req.socket.remoteAddress || "unknown";
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

  // ---- API: POST /api/auth ----
  if (req.method === "POST" && req.url === "/api/auth") {
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
      const { address, signature, challenge: challengeStr } = JSON.parse(body);

      if (!address || !signature || !challengeStr) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Missing address, signature, or challenge" }));
        return;
      }

      const challengeData = challenges.get(challengeStr);
      if (!challengeData || Date.now() > challengeData.expiresAt) {
        challenges.delete(challengeStr);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Challenge expired or invalid. Request a new one." }));
        return;
      }

      if (address.toLowerCase() !== LENDER_ADDRESS.toLowerCase()) {
        challenges.delete(challengeStr);
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `Address ${address} is not the lender (${LENDER_ADDRESS})` }));
        return;
      }

      const message = `Morpho Blue Monitor\n\nSign in with address: ${LENDER_ADDRESS}\nNonce: ${challengeStr}`;
      const recovered = await recoverSignerAddress(message, signature);

      if (!recovered || recovered !== LENDER_ADDRESS.toLowerCase()) {
        challenges.delete(challengeStr);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Signature verification failed" }));
        return;
      }

      challenges.delete(challengeStr);
      const token = createSessionToken(recovered, SESSION_EXPIRY_MS);
      const now = Date.now();
      const expiresAt = new Date(now + SESSION_EXPIRY_MS).toISOString();

      console.log(
        `[${new Date().toISOString()}] 🔑 New session for ${recovered} ` +
          `(expires ${new Date(now + SESSION_EXPIRY_MS).toLocaleString("vi-VN")})`
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, token, expiresAt }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ---- API: GET /api/presign ----
  if (req.method === "GET" && req.url === "/api/presign") {
    if (!verifyToken(req, LENDER_ADDRESS)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }
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
          tiers: (bundle.withdrawals || []).map(w => {
            const t = {
              label: w.label,
              amountFormatted: w.amountFormatted,
              amountWei: w.amountWei,
            };
            if (w.type === "all-shares") {
              t.type = w.type;
              t.sharesWei = w.sharesWei;
            }
            return t;
          }),
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
    return;
  }

  // ---- Block access to sensitive files ----
  const blockedPatterns = [/\.(json|env|log|tar)(\?|$)/i];
  if (req.method === "GET" && blockedPatterns.some(p => p.test(req.url))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  // ---- API: DELETE /api/presign ----
  if (req.method === "DELETE" && req.url.startsWith("/api/presign")) {
    if (!verifyToken(req, LENDER_ADDRESS)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    const urlObj = new URL(req.url, "http://localhost");
    const tierIdx = urlObj.searchParams.get("tier");

    try {
      await withPresignedWrite(() => {
        if (tierIdx !== null && fs.existsSync(PRESIGNED_PATH)) {
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
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }
    return;
  }

  // ---- API: POST /api/presign ----
  if (req.method === "POST" && req.url === "/api/presign") {
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
      await withPresignedWrite(async () => {
        const newBundle = JSON.parse(body);
        if (!newBundle.withdrawals || newBundle.withdrawals.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid bundle: withdrawals empty" }));
          return;
        }

        // Fail-closed: verify Morpho withdraw calldata trước khi persist
        const verified = await verifyPresignedBundle(newBundle, {
          morphoBlueAddress: MORPHO_BLUE_ADDRESS,
          lenderAddress: LENDER_ADDRESS,
          marketId: MARKET_ID,
        });
        if (!verified.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `Calldata verify failed: ${verified.error}` }));
          return;
        }

        let merged = newBundle;
        let action = "saved";

        if (fs.existsSync(PRESIGNED_PATH)) {
          try {
            const old = JSON.parse(fs.readFileSync(PRESIGNED_PATH, "utf-8"));
            if (old.withdrawals && old.withdrawals.length > 0) {
              if (old.nonce === newBundle.nonce) {
                const getMergeKey = (w) => {
                  if (w.type === "all-shares") return `__all_shares__`;
                  return w.amountWei || null;
                };
                const map = new Map();
                let added = 0, replaced = 0;
                for (const w of old.withdrawals) {
                  const key = getMergeKey(w);
                  if (key) map.set(key, w);
                }
                for (const w of newBundle.withdrawals) {
                  const key = getMergeKey(w);
                  if (!key) continue;
                  if (map.has(key)) replaced++; else added++;
                  map.set(key, w);
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
                action = "replaced (new nonce)";
              }
            }
          } catch { /* corrupt — overwrite */ }
        }

        // Re-verify sau merge — tier cũ giữ lại cũng phải hợp lệ
        const mergedVerified = await verifyPresignedBundle(merged, {
          morphoBlueAddress: MORPHO_BLUE_ADDRESS,
          lenderAddress: LENDER_ADDRESS,
          marketId: MARKET_ID,
        });
        if (!mergedVerified.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            error: `Merged bundle verify failed: ${mergedVerified.error}`,
          }));
          return;
        }

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
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }
    return;
  }

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  res.on("error", (err) => {
    if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
      console.error(`[${new Date().toISOString()}] ⚠️ Response error:`, err.message);
    }
  });

  res.writeHead(200);
  res.end(htmlContent);
});

const proto = sslOptions ? "https" : "http";
server.listen(PORT, "0.0.0.0", () => {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Morpho Blue - Withdrawal Webapp Server               ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  🌐 Webapp đang chạy tại: ${proto}://0.0.0.0:${PORT}`);
  console.log(`  📱 Local:               ${proto}://localhost:${PORT}`);
  if (sslOptions) console.log(`  🔒 SSL enabled — cert: ${SSL_CERT_PATH}`);
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Nhấn Ctrl+C để dừng");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

const shutdown = (signal) => {
  console.log(`\n🛑 Nhận ${signal}, đang dừng server...`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
