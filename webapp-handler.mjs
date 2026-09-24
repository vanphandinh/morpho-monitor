/**
 * Pure HTTP request handler for the presign webapp API.
 * Tách riêng khỏi webapp-server.mjs để test import được production handler
 * mà không kích hoạt loadMarkets/listen. Mọi response đều gửi SAU khi
 * mutation commit (deferred response) — không bao giờ 200 trước khi guard chạy.
 */
import crypto from "node:crypto";
import {
  LENDER_ADDRESS,
  MORPHO_BLUE_ADDRESS,
  PROXY_RPC_URL,
  WEBAPP_PASSWORD,
  MAX_BODY_BYTES,
  SESSION_EXPIRY_MS,
  CHALLENGE_EXPIRY_MS,
  LOCK_STALE,
  recoverSignerAddress,
  createSessionToken,
  verifyToken,
  checkInternalSecret,
  readBodyLimited,
} from "./shared.mjs";
import {
  requireConfiguredMarket,
  MARKET_INPUT_INVALID,
  MARKET_NOT_CONFIGURED,
} from "./market-config.mjs";
import { readRegistry, updateRegistry, registrySummary, ACTIVE_CLAIM_CONFLICT } from "./presigned-store.mjs";
import { verifyPresignedBundle } from "./presign-verify.mjs";

// Rate limit for /api/challenge: max 10 requests per minute per IP
const CHALLENGE_RATE_LIMIT_WINDOW_MS = 60_000;
const CHALLENGE_RATE_LIMIT_MAX = 10;
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;

/** Map a thrown error to an HTTP status (400/404/409/503 for known codes; 500 otherwise). */
export function statusForError(err) {
  if (err?.code === MARKET_INPUT_INVALID) return 400;
  if (err?.code === MARKET_NOT_CONFIGURED) return 404;
  if (err?.code === ACTIVE_CLAIM_CONFLICT) return 409;
  // Stale cross-process lock: the registry cannot be read/written right now.
  if (err?.code === LOCK_STALE) return 503;
  return 500;
}

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Lifecycle fields the browser may never inject into a persisted bundle.
 * POST /api/presign stores verified PENDING data only; the broadcaster owns
 * the broadcasting/submitted/failed lifecycle.
 */
const CLIENT_FORBIDDEN_FIELDS = ["status", "txHash", "rawTx", "broadcastingAt", "broadcastingTier", "minedAt", "submittedAt", "error"];

function sanitizePendingBundle(input) {
  const bundle = { ...input };
  for (const field of CLIENT_FORBIDDEN_FIELDS) delete bundle[field];
  bundle.status = "pending";
  return bundle;
}

/**
 * Build the request handler. Injectable deps keep tests on the production
 * HTTP process instead of copied route logic.
 *
 * @param {object} deps
 * @param {string} deps.presignedPath - registry file path
 * @param {Array<{id: string}>} deps.markets - configured market allow-list
 * @param {string} deps.content - HTML served at "/"
 * @param {string} [deps.proxyUrl] - proxy base URL for /api/bundle relay
 * @param {string} [deps.proxyPassword] - internal secret for proxy relay
 * @param {typeof fetch} [deps.fetchImpl] - injectable fetch for proxy relay
 */
export function createRequestHandler({
  presignedPath,
  markets,
  content,
  proxyUrl = PROXY_RPC_URL.replace(/\/+$/, ""),
  proxyPassword = WEBAPP_PASSWORD,
  fetchImpl = fetch,
} = {}) {
  const requireMarket = (marketId) => requireConfiguredMarket(markets, marketId);

  // Per-handler state (M10): không chia sẻ giữa các test/handler khác nhau.
  const challenges = new Map(); // challenge → { address, createdAt, expiresAt }
  const challengeRateLimit = new Map(); // IP → { count, windowStart }

  /** Drop expired challenges and stale rate-limit windows. */
  const sweepExpired = () => {
    const now = Date.now();
    for (const [key, val] of challenges) {
      if (now > val.expiresAt) challenges.delete(key);
    }
    for (const [ip, entry] of challengeRateLimit) {
      if (now - entry.windowStart > CHALLENGE_RATE_LIMIT_WINDOW_MS) challengeRateLimit.delete(ip);
    }
  };

  const handler = async (req, res) => {
    // Exact pathname routing: `/api/presignXYZ` không còn khớp `/api/presign`.
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    // ---- API: GET /api/challenge ----
    if (req.method === "GET" && pathname === "/api/challenge") {
      // Prefer socket address (X-Forwarded-For spoofable khi không có trusted proxy)
      const ip = req.socket.remoteAddress || "unknown";
      const now = Date.now();
      const rl = challengeRateLimit.get(ip);
      if (rl && now - rl.windowStart < CHALLENGE_RATE_LIMIT_WINDOW_MS) {
        if (rl.count >= CHALLENGE_RATE_LIMIT_MAX) {
          sendJson(res, 429, { ok: false, error: "Too many requests. Try again later." });
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
      sendJson(res, 200, {
        ok: true,
        challenge,
        message: `Morpho Blue Monitor\n\nSign in with address: ${LENDER_ADDRESS}\nNonce: ${challenge}`,
        expiresAt: new Date(now + CHALLENGE_EXPIRY_MS).toISOString(),
      });
      return;
    }

    // ---- API: POST /api/auth ----
    if (req.method === "POST" && pathname === "/api/auth") {
      let body;
      try {
        body = await readBodyLimited(req, MAX_BODY_BYTES);
      } catch (err) {
        sendJson(res, err.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { ok: false, error: err.message });
        return;
      }
      try {
        const { address, signature, challenge: challengeStr } = JSON.parse(body);

        if (!address || !signature || !challengeStr) {
          sendJson(res, 400, { ok: false, error: "Missing address, signature, or challenge" });
          return;
        }

        const challengeData = challenges.get(challengeStr);
        if (!challengeData || Date.now() > challengeData.expiresAt) {
          challenges.delete(challengeStr);
          sendJson(res, 401, { ok: false, error: "Challenge expired or invalid. Request a new one." });
          return;
        }

        if (address.toLowerCase() !== LENDER_ADDRESS.toLowerCase()) {
          challenges.delete(challengeStr);
          sendJson(res, 403, { ok: false, error: `Address ${address} is not the lender (${LENDER_ADDRESS})` });
          return;
        }

        const message = `Morpho Blue Monitor\n\nSign in with address: ${LENDER_ADDRESS}\nNonce: ${challengeStr}`;
        const recovered = await recoverSignerAddress(message, signature);

        if (!recovered || recovered !== LENDER_ADDRESS.toLowerCase()) {
          challenges.delete(challengeStr);
          sendJson(res, 401, { ok: false, error: "Signature verification failed" });
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

        sendJson(res, 200, { ok: true, token, expiresAt });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    // ---- API: GET /api/presign ----
    // ---- API: GET /api/overview — trạng thái bundle của MỌI market ----
    // Auth như /api/presign (đọc registry). Trả summary theo allow-list;
    // market không có bundle → { exists: false }. Nonce on-chain không nằm ở
    // đây (webapp không chạy RPC server-side); browser tự tính cảnh báo
    // trùng nonce từ các nonce của bundle.
    if (req.method === "GET" && pathname === "/api/overview") {
      if (!verifyToken(req, LENDER_ADDRESS)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      try {
        const bundles = readRegistry(presignedPath).bundles;
        sendJson(res, 200, {
          ok: true,
          lenderAddress: LENDER_ADDRESS,
          markets: markets.map((market) => ({ id: market.id, ...registrySummary(bundles[market.id]) })),
        });
      } catch (err) {
        sendJson(res, statusForError(err), { ok: false, error: err.message });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/presign") {
      if (!verifyToken(req, LENDER_ADDRESS)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      try {
        const marketId = requireMarket(new URL(req.url, "http://localhost").searchParams.get("market"));
        const summary = registrySummary(readRegistry(presignedPath).bundles[marketId]);
        sendJson(res, 200, { ok: true, ...summary });
      } catch (err) {
        sendJson(res, statusForError(err), { ok: false, exists: false, error: err.message });
      }
      return;
    }

    // ---- API: POST /api/bundle — relay metadata từ frontend sang proxy ----
    if (req.method === "POST" && pathname === "/api/bundle") {
      if (!verifyToken(req, LENDER_ADDRESS)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      let body;
      try {
        body = await readBodyLimited(req, MAX_BODY_BYTES);
      } catch (err) {
        sendJson(res, err.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { ok: false, error: err.message });
        return;
      }
      try {
        const authHeader = proxyPassword
          ? "Basic " + Buffer.from(":" + proxyPassword).toString("base64")
          : null;
        const proxyResp = await fetchImpl(`${proxyUrl}/bundle`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { "Authorization": authHeader } : {}),
          },
          body,
        });
        const result = await proxyResp.json();
        sendJson(res, proxyResp.status, result);
      } catch (err) {
        sendJson(res, 502, { ok: false, error: "Proxy unreachable: " + err.message });
      }
      return;
    }

    // ---- Block access to sensitive files ----
    const blockedPatterns = [/\.(json|env|log|tar)$/i];
    if (req.method === "GET" && blockedPatterns.some(p => p.test(pathname))) {
      sendJson(res, 403, { ok: false, error: "Forbidden" });
      return;
    }

    // ---- API: DELETE /api/presign ----
    if (req.method === "DELETE" && pathname === "/api/presign") {
      if (!verifyToken(req, LENDER_ADDRESS)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      const urlObj = new URL(req.url, "http://localhost");
      const tierIdx = urlObj.searchParams.get("tier");

      try {
        const marketId = requireMarket(urlObj.searchParams.get("market"));
        let outcome;
        await updateRegistry(presignedPath, (registry) => {
          const bundle = registry.bundles[marketId];
          if (tierIdx !== null && bundle) {
            const idx = parseInt(tierIdx, 10);
            if (isNaN(idx) || idx < 0 || idx >= (bundle.withdrawals?.length || 0)) {
              throw Object.assign(new Error(`Invalid tier index: ${tierIdx}`), { code: MARKET_INPUT_INVALID });
            }
            const removed = bundle.withdrawals.splice(idx, 1)[0];
            console.log(
              `[${new Date().toISOString()}] 🗑️  Removed tier "${removed.label}" from presigned bundle (${bundle.withdrawals.length} remaining)`
            );
            outcome = { ok: true, removed: removed.label, remaining: bundle.withdrawals.length };
          } else {
            const deleted = bundle ? 1 : 0;
            delete registry.bundles[marketId];
            console.log(
              `[${new Date().toISOString()}] 🗑️  Presigned bundle deleted for market ${marketId.slice(0, 12)}… (${deleted} bundle)`
            );
            outcome = { ok: true, deleted };
          }
        }, { origin: "user" });
        // Response only after the mutation committed (guard passed).
        sendJson(res, 200, outcome);
      } catch (err) {
        sendJson(res, statusForError(err), { ok: false, error: err.message });
      }
      return;
    }

    // ---- API: POST /api/presign ----
    if (req.method === "POST" && pathname === "/api/presign") {
      const session = verifyToken(req, LENDER_ADDRESS);
      const isInternal = checkInternalSecret(req);
      if (!session && !isInternal) {
        console.warn(
          `[${new Date().toISOString()}] 🔒 POST /api/presign rejected: invalid credentials`
        );
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      let body;
      try {
        body = await readBodyLimited(req, MAX_BODY_BYTES);
      } catch (err) {
        sendJson(res, err.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { ok: false, error: err.message });
        return;
      }

      try {
        let outcome;
        await updateRegistry(presignedPath, async (registry) => {
          let parsed;
          try { parsed = JSON.parse(body); } catch (err) {
            throw Object.assign(new Error(`Invalid JSON body: ${err.message}`), { code: MARKET_INPUT_INVALID });
          }
          if (!parsed.withdrawals || parsed.withdrawals.length === 0) {
            throw Object.assign(new Error("Invalid bundle: withdrawals empty"), { code: MARKET_INPUT_INVALID });
          }

          // Fail-closed: verify Morpho withdraw calldata trước khi persist
          const marketId = requireMarket(parsed.marketId);
          if (parsed.version !== 2) {
            throw Object.assign(new Error("Presigned bundle must use version 2"), { code: MARKET_INPUT_INVALID });
          }
          const incoming = sanitizePendingBundle(parsed);
          const verified = await verifyPresignedBundle(incoming, {
            morphoBlueAddress: MORPHO_BLUE_ADDRESS,
            lenderAddress: LENDER_ADDRESS,
            marketId,
          });
          if (!verified.ok) {
            throw Object.assign(new Error(`Calldata verify failed: ${verified.error}`), { code: MARKET_INPUT_INVALID });
          }

          let merged = incoming;
          let action = "saved";

          {
            try {
              const old = registry.bundles[marketId];
              if (old && old.withdrawals && old.withdrawals.length > 0 && !["broadcasting", "submitted", "failed"].includes(old.status)) {
                if (old.nonce === incoming.nonce) {
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
                  for (const w of incoming.withdrawals) {
                    const key = getMergeKey(w);
                    if (!key) continue;
                    if (map.has(key)) replaced++; else added++;
                    map.set(key, w);
                  }
                  merged = {
                    ...incoming,
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
            } catch { /* malformed prior bundle — overwrite */ }
          }

          // Re-verify sau merge — tier cũ giữ lại cũng phải hợp lệ
          const mergedVerified = await verifyPresignedBundle(merged, {
            morphoBlueAddress: MORPHO_BLUE_ADDRESS,
            lenderAddress: LENDER_ADDRESS,
            marketId,
          });
          if (!mergedVerified.ok) {
            throw Object.assign(new Error(`Merged bundle verify failed: ${mergedVerified.error}`), { code: MARKET_INPUT_INVALID });
          }

          registry.bundles[marketId] = merged;

          console.log(
            `[${new Date().toISOString()}] 📝 Presigned bundle ${action}: ` +
              `${merged.withdrawals.length} tiers, nonce=${incoming.nonce}`
          );
          outcome = { ok: true, tiers: merged.withdrawals.length, action };
        }, { origin: "user" });
        // Response only after the mutation committed (guard passed).
        sendJson(res, 200, outcome);
      } catch (err) {
        sendJson(res, statusForError(err), { ok: false, error: err.message });
      }
      return;
    }

    // ---- Unknown API route: JSON 404, không rơi vào SPA HTML 200 ----
    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: `Unknown API route: ${req.method} ${pathname}` });
      return;
    }

    // ---- Static webapp ----
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
    res.end(content);
  };

  // Cleanup timer do bootstrap (webapp-server.mjs) tạo — test import handler
  // không để lại interval treo (M10).
  handler.sweepExpired = sweepExpired;
  handler.startCleanupTimer = (intervalMs = CLEANUP_INTERVAL_MS) => {
    const timer = setInterval(sweepExpired, intervalMs);
    timer.unref?.();
    handler.stopCleanupTimer = () => clearInterval(timer);
    return timer;
  };
  handler.stopCleanupTimer = () => {};
  return handler;
}
