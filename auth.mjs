/**
 * Token/session auth helpers — tách khỏi shared.mjs (audit P1.4).
 *
 * Phụ thuộc DUY NHẤT vào shared config (`WEBAPP_PASSWORD`) và chỉ đọc nó LÚC GỌI,
 * không đọc ở top-level — nên `shared.mjs` không cần import ngược `auth.mjs`: không
 * có vòng import.
 */
import crypto from "node:crypto";
import { WEBAPP_PASSWORD } from "./shared.mjs";

/** Constant-time string compare (hex/utf8). Length mismatch → false. */
export function safeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Create a self-verifiable session token using HMAC-SHA256.
 * Both webapp-server and proxy-rpc can verify tokens independently
 * because they share WEBAPP_PASSWORD as the HMAC secret.
 *
 * Token format: payload.hmac
 *   payload = base64url(address:expiryTimestamp:randomHex)
 *   hmac = hex(HMAC-SHA256(payload, WEBAPP_PASSWORD))
 */
export function createSessionToken(address, expiryMs) {
  const secret = WEBAPP_PASSWORD || "dev-mode-no-secret";
  const random = crypto.randomBytes(16).toString("hex");
  const expiry = Date.now() + expiryMs;
  const payload = Buffer.from(`${address}:${expiry}:${random}`).toString("base64url");
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

/**
 * Verify a self-verifiable session token.
 * Returns { address, expiresAt } or null if invalid/expired.
 */
export function verifySessionToken(token) {
  if (!token) return null;
  const secret = WEBAPP_PASSWORD || "dev-mode-no-secret";
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, hmac] = parts;
  const expectedHmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (!safeEqualString(hmac, expectedHmac)) return null;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    const [address, expiryStr] = decoded.split(":");
    const expiry = parseInt(expiryStr, 10);
    if (isNaN(expiry) || Date.now() > expiry) return null;
    return { address, expiresAt: expiry };
  } catch {
    return null;
  }
}

/**
 * Verify a Bearer token (HMAC-based, verifiable by both webapp-server and proxy-rpc).
 * Returns { address, expiresAt } or null.
 * @param {object} req - Node.js IncomingMessage
 * @param {string} [devAddress="dev"] - address returned in dev mode (no WEBAPP_PASSWORD)
 */
export function verifyToken(req, devAddress = "dev") {
  if (!WEBAPP_PASSWORD) return { address: devAddress, expiresAt: Infinity }; // dev mode
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return verifySessionToken(token);
}

/**
 * Check internal secret (Basic Auth with WEBAPP_PASSWORD).
 * Used for webapp-server ↔ proxy internal communication.
 */
export function checkInternalSecret(req) {
  if (!WEBAPP_PASSWORD) return true;
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Basic ")) return false;
  try {
    const [, encoded] = auth.split(" ");
    const [, pass] = Buffer.from(encoded, "base64").toString("utf-8").split(":");
    return safeEqualString(pass ?? "", WEBAPP_PASSWORD);
  } catch {
    return false;
  }
}

/**
 * Authorize proxy HTTP APIs (/bundle, /captured): internal Basic OR Bearer whose
 * embedded address matches lenderAddress.
 * @returns {{ ok: true, kind: "internal"|"bearer", session?: object } | { ok: false }}
 */
export function requireLenderOrInternal(req, lenderAddress) {
  if (!lenderAddress) return { ok: false };
  if (checkInternalSecret(req)) return { ok: true, kind: "internal" };
  const session = verifyToken(req, lenderAddress);
  if (!session?.address) return { ok: false };
  if (session.address.toLowerCase() !== lenderAddress.toLowerCase()) {
    return { ok: false };
  }
  return { ok: true, kind: "bearer", session };
}
