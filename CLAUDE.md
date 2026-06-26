# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Morpho Blue liquidity monitor + pre-signed withdrawal tool. Monitors a specific Morpho Blue market on Ethereum mainnet, sends ntfy.sh push notifications when liquidity appears, and can broadcast pre-signed withdrawal transactions. Includes a browser webapp for signing withdrawals through a local RPC proxy that captures transactions before they reach the network.

Pure JavaScript ESM (`"type": "module"`). No TypeScript. Vietnamese-language UI/comments.

## Commands

```bash
# Run all three services concurrently (monitor + webapp + proxy)
npm run dev

# Run individual services (all require .env)
npm run monitor      # Liquidity polling daemon
npm run webapp       # HTTP server on port 3000
npm run proxy        # RPC proxy on port 8545

# CLI tools (require .env)
npm start            # Fetch and display market + position info
node --env-file=.env verify-presigned.mjs [path/to/presigned.json]

# Tests
npm test             # vitest run (all 160 tests)
npx vitest run       # same
npx vitest           # watch mode
npx vitest run __tests__/shared.test.mjs  # single file
```

## Architecture: three long-running processes

```
.env ──→ shared.mjs (config, formatting, anti-spam shouldNotify(), HMAC auth)
              │
    ┌─────────┼─────────┐
    │         │         │
monitor.mjs  webapp-   proxy-rpc.mjs
(polling)    server.mjs (port 8545)
             (port 3000)
    │            │         │
    └────── rpc-client.mjs ─┘
         (circuit breaker + round-robin RPC transport)
```

- **`shared.mjs`** — Single source of truth for all config (read from `.env` via `env()`/`envNum()`). Exports formatting helpers, HMAC session token create/verify, anti-spam `shouldNotify()` pure function, and auth middleware (`verifyToken`, `checkInternalSecret`).
- **`rpc-client.mjs`** — Circuit breaker per RPC URL (CLOSED→OPEN→HALF-OPEN→CLOSED), round-robin transport across 9 URLs, `createRobustPublicClient()`/`createRobustWalletClient()` factories. Module-level `circuits` Map persists across all clients. Exports `addGlobalErrorHandlers()` for daemon resilience.
- **`monitor.mjs`** — Polls Morpho Blue market on `setInterval`. Uses `shouldNotify()` for anti-spam (threshold, 0→positive transition, cycle dedup, cooldown, daily limit). Sends ntfy.sh push notifications. Broadcasts pre-signed bundles when liquidity ≥ tier amount. Expires stale bundles by checking on-chain nonce.
- **`webapp-server.mjs`** — HTTP server serving `webapp.html` (SPA). REST API: `GET/POST/DELETE /api/presign`, `POST /api/bundle` (relay to proxy), `GET /api/challenge` + `POST /api/auth` (wallet sign-in → HMAC session token). Write-locked presigned.json access.
- **`proxy-rpc.mjs`** — Fake Ethereum JSON-RPC endpoint. Captures `eth_sendRawTransaction` signed tx hex. Mocks most methods (chainId, gas, blockNumber). Forwards only `eth_getTransactionCount` to real RPC. `POST /bundle` matches captured txs with tier metadata. Mutex-guarded `capturedTxs` buffer.
- **`index.mjs`** — Standalone CLI: fetches and pretty-prints market state + lender position.
- **`verify-presigned.mjs`** — Standalone CLI: parses signed transactions from a bundle JSON, decodes calldata, verifies it's a valid Morpho `withdraw()` call with matching amounts.

## Key design patterns

### Pre-signed withdrawal flow
1. User adds proxy RPC (`http://127.0.0.1:8545`) to MetaMask
2. User connects wallet to webapp, signs in (challenge→signature→HMAC token)
3. User configures tier amounts, clicks "Sign All" → MetaMask prompts for each tier
4. MetaMask sends `eth_sendRawTransaction` to proxy → proxy captures signedTx hex + computes txHash
5. Browser POSTs tier metadata (txHashes + amounts) to proxy `/bundle` → proxy matches with captured txs
6. Proxy POSTs assembled bundle to webapp `/api/presign` → saved to `presigned.json`
7. Monitor detects liquidity → selects best tier (largest amountWei ≤ liquidity) → broadcasts via `sendRawTransaction`

### Auth: two-tier
- **Webapp ↔ Browser:** Wallet signature challenge-response → HMAC-SHA256 session token (Bearer). Self-verifiable by both webapp and proxy since they share `WEBAPP_PASSWORD` as HMAC secret.
- **Proxy ↔ Webapp (internal):** HTTP Basic Auth with `WEBAPP_PASSWORD`. Both use `verifyToken()` and `checkInternalSecret()` from shared.mjs.
- **Dev mode:** When `WEBAPP_PASSWORD` is empty, all auth is bypassed.

### Circuit breaker (rpc-client.mjs)
- CLOSED → OPEN after 3 consecutive failures (or 1 rate-limit/HTTP 429)
- OPEN → HALF-OPEN after jittered exponential backoff (base 30s, ×2 each probe failure, cap 120s, ±20% jitter)
- HALF-OPEN → CLOSED on successful probe; → OPEN on failed probe
- Guard: concurrent failures don't re-open or re-double backoff if circuit already OPEN
- `recordSuccess` in CLOSED state decrements (doesn't reset), preventing stale in-flight success from closing a freshly-opened circuit

### Anti-spam (shared.mjs `shouldNotify()`)
Pure function tested independently. Five checks in order: threshold, 0→positive transition, cycle dedup, cooldown, daily limit with day-roll detection. Monitor only updates state on successful ntfy delivery (failures don't burn quota).

### Write serialization (webapp-server.mjs)
POST /api/presign uses a promise chain (`writeLock = writeLock.then(doWrite, doWrite)`) to serialize concurrent reads/writes to presigned.json. Atomic write via tmp file + rename. DELETE /api/presign also touches the file without the lock — but typically runs when no concurrent POSTs are expected.

## Conventions

- **Tests duplicate pure functions** rather than importing from source. This is intentional — avoids module-level side effects (top-level awaits, RPC connections) that would fire on import. See comments in `presign-broadcast.test.mjs` and `expire-bundle.test.mjs`.
- **Vietnamese comments and log messages** throughout. UI is in Vietnamese.
- **`--env-file=.env`** flag required for all `node` commands. The `.env` file is gitignored; `.env.example` is the template.
- **Port conventions:** webapp=3000, proxy=8545. Proxy URL is auto-derived from `WEBAPP_URL` host + `PROXY_PORT`.
- **Docker:** `docker-compose.yml` runs all three services under a supervisor shell script that auto-restarts crashed processes.

## Sharp edges

- `WEBAPP_PASSWORD` doubles as both HTTP Basic Auth secret AND HMAC key for session tokens. Changing it invalidates all existing sessions.
- `proxy-rpc.mjs` has a top-level `await` for the initial block fetch. The module won't finish loading until that resolves or times out.
- `capturedTxs` in proxy-rpc.mjs is in-memory only. Proxy restart loses all captured transactions.
- `challenges` Map and `challengeRateLimit` Map in webapp-server.mjs are in-memory. They reset on restart.
- The `DELETE /api/presign` handler and `broadcastPresigned`/`expireStaleBundle` in monitor.mjs all read/write presigned.json without the write lock — safe in practice because they run sequentially, but worth noting if the architecture changes.
- Test files import `describe, it, expect` from vitest globally (configured via `vitest.config.mjs` `globals: true`), plus explicit imports. The explicit imports are redundant but harmless.
