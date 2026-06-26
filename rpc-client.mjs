import { createPublicClient, createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";

// ============================================================
// CIRCUIT BREAKER — per-URL failure tracking
// ============================================================

/**
 * @typedef {{ failures: number, openUntil: number, backoffMs: number, probing: boolean }} CircuitState
 * @type {Map<string, CircuitState>}
 */
const circuits = new Map();

const CB_MAX_FAILURES = 3;
const CB_BASE_BACKOFF_MS = 30_000; // 30s
const CB_MAX_BACKOFF_MS = 120_000; // 2 min
const CB_JITTER = 0.2; // ±20% jitter to prevent thundering herd

/** Add ±20% jitter to prevent synchronized backoff across URLs. */
function applyJitter(backoffMs) {
  const jitter = Math.floor(backoffMs * CB_JITTER * (Math.random() * 2 - 1));
  return backoffMs + jitter;
}

function getCircuit(url) {
  if (!circuits.has(url)) {
    circuits.set(url, { failures: 0, openUntil: 0, backoffMs: CB_BASE_BACKOFF_MS, probing: false });
  }
  return circuits.get(url);
}

function recordSuccess(url) {
  const c = getCircuit(url);
  if (c.probing) {
    // Successful HALF-OPEN probe — circuit has recovered
    c.probing = false;
    c.failures = 0;
    c.openUntil = 0;
    c.backoffMs = CB_BASE_BACKOFF_MS;
    console.log(`[rpc] Circuit CLOSED for ${new URL(url).hostname} — recovered`);
    return;
  }
  // Normal success in CLOSED state — decrement to smooth out transient failures.
  // Don't reset to 0: a single stale in-flight success must not close a circuit
  // that was just opened by concurrent failures.
  if (c.failures > 0) {
    c.failures--;
  }
}

/**
 * Record a transport failure for a URL.
 * @param {string} url
 * @param {{ isRateLimit?: boolean }} [opts]
 */
function recordFailure(url, opts = {}) {
  const c = getCircuit(url);
  c.failures++;

  if (c.probing) {
    // HALF-OPEN probe failed — re-open the circuit with doubled backoff
    c.probing = false;
    c.backoffMs = Math.min(c.backoffMs * 2, CB_MAX_BACKOFF_MS);
    c.openUntil = Date.now() + applyJitter(c.backoffMs);
    console.warn(
      `[rpc] Circuit OPEN for ${new URL(url).hostname} — ` +
      `HALF-OPEN probe failed, cooldown ${c.backoffMs / 1000}s`
    );
    return;
  }

  // Rate limit (HTTP 429) is a clear signal — open the circuit immediately
  // after 1 failure instead of waiting for CB_MAX_FAILURES.
  const threshold = opts.isRateLimit ? 1 : CB_MAX_FAILURES;

  // Only open if not already open (guards against concurrent failures
  // that all arrive after the threshold was already crossed)
  if (c.failures >= threshold && c.openUntil === 0) {
    c.backoffMs = Math.min(c.backoffMs * 2, CB_MAX_BACKOFF_MS);
    c.openUntil = Date.now() + applyJitter(c.backoffMs);
    const reason = opts.isRateLimit ? "rate limit (429)" : `${c.failures} consecutive failures`;
    console.warn(
      `[rpc] Circuit OPEN for ${new URL(url).hostname} — ` +
      `${reason}, cooldown ${c.backoffMs / 1000}s`
    );
  }
}

function isCircuitOpen(url) {
  const c = getCircuit(url);
  if (c.openUntil > 0) {
    if (Date.now() < c.openUntil) return true;
    // Cooldown expired → transition to HALF-OPEN.
    // Only log once per OPEN→HALF-OPEN transition to reduce noise.
    const wasAlreadyProbing = c.probing;
    c.openUntil = 0;
    c.probing = true;
    if (!wasAlreadyProbing) {
      console.log(`[rpc] Circuit HALF-OPEN for ${new URL(url).hostname} — probing`);
    }
  }
  return false;
}

// Exported for testing
export { recordSuccess, recordFailure, isCircuitOpen, getCircuit, circuits };

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
 * requests to this URL fail instantly (code=-1), allowing the
 * round-robin transport to skip to the next URL.
 *
 * @param {string} url - RPC endpoint URL
 * @param {object} httpOptions - Options forwarded to viem's http()
 * @returns {function} transport factory compatible with createRoundRobinTransport
 */
function circuitHttp(url, httpOptions = {}) {
  return (config) => {
    const baseTransport = http(url, {
      timeout: 15_000,
      retryCount: 1,        // 1 retry = 2 total attempts per URL.
      retryDelay: 300,      // With 9 URLs in rotation, retrying the same URL
      ...httpOptions,       // is less valuable than moving to the next one.
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
            // Rate limits are a clear signal — trigger immediate circuit open.
            // Also catch JSON-RPC rate-limit code -32005.
            const isRateLimit =
              err?.status === 429 || err?.code === -32005;
            recordFailure(url, { isRateLimit });
          }
          throw err;
        }
      },
    };
  };
}

// ============================================================
// ROUND-ROBIN TRANSPORT — cycles through healthy URLs each request
// ============================================================

/**
 * Creates a viem-compatible transport that round-robins across URLs.
 * Each request starts at the next URL in rotation, distributing load
 * evenly across all providers. Circuit-breaker OPEN URLs are skipped
 * automatically.
 *
 * @param {string[]} urls - Array of RPC endpoint URLs
 * @param {{ retryCount?: number, retryDelay?: number }} [opts]
 * @returns {function} transport factory compatible with viem createPublicClient / createWalletClient
 */
export function createRoundRobinTransport(urls, opts = {}) {
  const { retryCount = 1, retryDelay = 500 } = opts;
  // Random starting position so each process distributes load differently
  let roundRobinIndex = Math.floor(Math.random() * urls.length);

  return (config) => {
    const transports = urls.map((url) => circuitHttp(url)(config));

    async function tryAllUrls(args, startIdx) {
      let lastError;
      for (let i = 0; i < urls.length; i++) {
        const idx = (startIdx + i) % urls.length;
        try {
          const result = await transports[idx].request(args);
          // Success — advance round-robin for the next request
          roundRobinIndex = (idx + 1) % urls.length;
          return result;
        } catch (_err) {
          lastError = _err;
          // err.code === -1 (circuit OPEN) or transport error → try next URL
        }
      }
      throw lastError;
    }

    return {
      config: transports[0].config,
      request: async (args) => {
        let lastError;
        for (let attempt = 0; attempt <= retryCount; attempt++) {
          try {
            return await tryAllUrls(args, roundRobinIndex % urls.length);
          } catch (err) {
            lastError = err;
            if (attempt < retryCount) {
              await new Promise((r) => setTimeout(r, retryDelay));
            }
          }
        }
        throw lastError;
      },
      get value() {
        return transports[0].value;
      },
    };
  };
}

// ============================================================
// ROBUST CLIENT FACTORIES
// ============================================================

/**
 * Create a viem public client with round-robin across all RPC URLs,
 * circuit breaker per URL, and retry with exponential backoff.
 *
 * @param {string[]} urls - Array of RPC endpoint URLs
 * @returns {import("viem").PublicClient}
 */
export function createRobustPublicClient(urls) {
  if (!urls || urls.length === 0) {
    throw new Error("createRobustPublicClient: urls must be a non-empty array");
  }

  return createPublicClient({
    chain: mainnet,
    transport: createRoundRobinTransport(urls, {
      // 1 retry = 2 total passes through the full URL rotation.
      // The per-URL retry is handled inside circuitHttp (retryCount=1).
      retryCount: 1,
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

  return createWalletClient({
    chain: mainnet,
    transport: createRoundRobinTransport(urls, {
      retryCount: 1,
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
