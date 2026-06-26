import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { mainnet } from "viem/chains";

// ============================================================
// CIRCUIT BREAKER — per-URL failure tracking
// ============================================================

/** @type {Map<string, { failures: number, openUntil: number, backoffMs: number }>} */
const circuits = new Map();

const CB_MAX_FAILURES = 3;
const CB_BASE_BACKOFF_MS = 30_000; // 30s
const CB_MAX_BACKOFF_MS = 120_000; // 2 min

function getCircuit(url) {
  if (!circuits.has(url)) {
    circuits.set(url, { failures: 0, openUntil: 0, backoffMs: CB_BASE_BACKOFF_MS });
  }
  return circuits.get(url);
}

function recordSuccess(url) {
  const c = getCircuit(url);
  if (c.failures > 0 || c.openUntil > 0) {
    console.log(`[rpc] Circuit CLOSED for ${new URL(url).hostname} — recovered`);
  }
  c.failures = 0;
  c.openUntil = 0;
  c.backoffMs = CB_BASE_BACKOFF_MS;
}

function recordFailure(url) {
  const c = getCircuit(url);
  c.failures++;
  if (c.failures >= CB_MAX_FAILURES) {
    c.openUntil = Date.now() + c.backoffMs;
    console.warn(
      `[rpc] Circuit OPEN for ${new URL(url).hostname} — ` +
      `${c.failures} consecutive failures, cooldown ${c.backoffMs / 1000}s`
    );
    c.backoffMs = Math.min(c.backoffMs * 2, CB_MAX_BACKOFF_MS);
  }
}

function isCircuitOpen(url) {
  const c = getCircuit(url);
  if (c.openUntil > 0) {
    if (Date.now() < c.openUntil) return true;
    // Cooldown expired → transition to HALF-OPEN
    c.openUntil = 0;
    console.log(`[rpc] Circuit HALF-OPEN for ${new URL(url).hostname} — probing`);
  }
  return false;
}

// ============================================================
// ERROR CLASSIFICATION
// ============================================================

/**
 * Detect errors that are transient and worth retrying:
 * DNS failures, network down, timeout, rate limits, server errors.
 * Returns false for permanent errors (invalid params, method not found, etc.)
 */
function isTransportError(err) {
  const msg = err?.message || "";
  const detail = err?.details || "";
  const causeMsg = err?.cause?.message || "";
  const combined = `${msg} ${detail} ${causeMsg}`;

  // DNS / network failures — always retryable
  if (/\bEAI_AGAIN\b/i.test(combined)) return true;
  if (/\bENOTFOUND\b/i.test(combined)) return true;
  if (/\bECONNREFUSED\b/i.test(combined)) return true;
  if (/\bECONNRESET\b/i.test(combined)) return true;
  if (/\bETIMEDOUT\b/i.test(combined)) return true;
  if (/\bENETUNREACH\b/i.test(combined)) return true;
  if (/\bENETDOWN\b/i.test(combined)) return true;
  if (/\bfetch failed\b/i.test(combined)) return true;

  // viem TimeoutError
  if (err?.name === "TimeoutError") return true;
  if (err instanceof Error && err.constructor?.name === "TimeoutError") return true;

  // HTTP transient errors
  const status = err?.status;
  if (status === 408 || status === 429 || (status >= 500 && status <= 504)) return true;

  // Rate limit JSON-RPC errors
  if (err?.code === -32005) return true; // Limit exceeded

  return false;
}

// ============================================================
// CIRCUIT-BREAKING HTTP TRANSPORT FACTORY
// ============================================================

/**
 * Returns a transport factory (like viem's http()) that wraps each
 * request with circuit breaker logic. When the circuit is OPEN,
 * requests to this URL fail instantly, allowing viem's fallback
 * transport to move to the next URL.
 *
 * @param {string} url - RPC endpoint URL
 * @param {object} httpOptions - Options forwarded to viem's http()
 * @returns {function} transport factory compatible with viem's fallback()
 */
function circuitHttp(url, httpOptions = {}) {
  return (config) => {
    const baseTransport = http(url, {
      timeout: 15_000,
      retryCount: 2,        // retry individual transport on transient errors
      retryDelay: 300,
      ...httpOptions,
    })(config);

    const originalRequest = baseTransport.request.bind(baseTransport);

    return {
      ...baseTransport,
      request: async (args) => {
        // If circuit is open, fail fast so fallback tries the next URL
        if (isCircuitOpen(url)) {
          const err = new Error(`[rpc] Circuit breaker open for ${new URL(url).hostname}`);
          err.code = -1; // triggers fallback to next transport
          throw err;
        }

        try {
          const result = await originalRequest(args);
          // Only count as success for transport-level errors — RPC errors
          // like "method not found" shouldn't reset the circuit breaker.
          // We only get here if the HTTP request itself succeeded.
          recordSuccess(url);
          return result;
        } catch (err) {
          if (isTransportError(err)) {
            recordFailure(url);
          }
          throw err;
        }
      },
    };
  };
}

// ============================================================
// ROBUST CLIENT FACTORIES
// ============================================================

/**
 * Create a viem public client with fallback across all RPC URLs,
 * circuit breaker per URL, and retry with exponential backoff.
 *
 * @param {string[]} urls - Array of RPC endpoint URLs
 * @returns {import("viem").PublicClient}
 */
export function createRobustPublicClient(urls) {
  if (!urls || urls.length === 0) {
    throw new Error("createRobustPublicClient: urls must be a non-empty array");
  }

  const transports = urls.map((url) => circuitHttp(url));

  return createPublicClient({
    chain: mainnet,
    transport: fallback(transports, {
      // rank: track success/failure per transport and prioritize good ones
      rank: true,
      // retry the entire fallback chain on transient failures
      retryCount: 3,
      retryDelay: 500,
    }),
  });
}

/**
 * Create a viem wallet client with the same robust transport.
 *
 * @param {string[]} urls - Array of RPC endpoint URLs
 * @returns {import("viem").WalletClient}
 */
export function createRobustWalletClient(urls) {
  if (!urls || urls.length === 0) {
    throw new Error("createRobustWalletClient: urls must be a non-empty array");
  }

  const transports = urls.map((url) => circuitHttp(url));

  return createWalletClient({
    chain: mainnet,
    transport: fallback(transports, {
      rank: true,
      retryCount: 3,
      retryDelay: 500,
    }),
  });
}

// ============================================================
// GLOBAL ERROR HANDLERS (defense in depth)
// ============================================================

/**
 * Install global error handlers that prevent the process from
 * crashing on unhandled promise rejections.
 *
 * Call once at startup in every daemon service.
 *
 * @param {string} serviceName - Label for log messages (e.g. "monitor")
 */
export function addGlobalErrorHandlers(serviceName) {
  process.on("unhandledRejection", (reason, promise) => {
    const ts = new Date().toISOString();
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[${ts}] [${serviceName}] UNHANDLED REJECTION: ${msg}`);
    if (reason instanceof Error && reason.stack) {
      // Print stack without the first line (which repeats the message)
      const stackLines = reason.stack.split("\n").slice(1).join("\n");
      console.error(stackLines);
    }
    // Do NOT exit — the service can continue.
    // The next poll cycle or request will retry.
  });

  process.on("uncaughtException", (err) => {
    const ts = new Date().toISOString();
    console.error(`[${ts}] [${serviceName}] UNCAUGHT EXCEPTION: ${err.message}`);
    if (err.stack) console.error(err.stack);
    // For uncaught exceptions, the process state is undefined.
    // We must exit, but the Docker entrypoint will auto-restart.
    console.error(`[${ts}] [${serviceName}] Process will exit and be restarted.`);
    process.exit(1);
  });
}
