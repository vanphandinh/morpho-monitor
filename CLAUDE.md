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
    ┌─────────┼─────────┬──────────┬──────────┐
    │         │         │          │          │
monitor.mjs  webapp-   proxy-    voip.mjs   WSS watcher
(polling +   server.mjs rpc.mjs  (REST VoIP  (webSocket
 WSS hybrid) (port 3000)(port 8545) API client)  trigger)
             (serves ↓)
           webapp.html
          (browser SPA)
    │            │         │
    └────── rpc-client.mjs ─┘
         (circuit breaker + round-robin RPC transport)
```

- **`shared.mjs`** — Single source of truth for all config (read from `.env` via `env()`/`envNum()`). Exports formatting helpers, HMAC session token create/verify, anti-spam `shouldNotify()` pure function, and auth middleware (`verifyToken`, `checkInternalSecret`).
- **`rpc-client.mjs`** — Circuit breaker per RPC URL (CLOSED→OPEN→HALF-OPEN→CLOSED), round-robin transport across 11 URLs, `createRobustPublicClient()`/`createRobustWalletClient()` factories. Module-level `circuits` Map persists across all clients. Exports `addGlobalErrorHandlers()` for daemon resilience.
- **`monitor.mjs`** — Polls Morpho Blue market on `setInterval`. ALSO runs a WebSocket watcher (`startWsWatcher()`) that creates 5 separate `watchContractEvent` subscriptions (one per event: Supply, Withdraw, Borrow, Repay, Liquidate) via `eth_subscribe` as real-time triggers. Each subscription uses `eventName` as a SINGLE STRING with `args: { id: MARKET_ID }` for correct RPC-level topic filtering (`topics[1] = MARKET_ID`). Events fire a debounced `checkAndNotify()` immediately instead of waiting for the next poll cycle. Uses `shouldNotify()` for anti-spam (threshold, 0→positive transition, cycle dedup, cooldown, daily limit). Sends ntfy.sh push notifications AND VoIP calls. Broadcasts pre-signed bundles when liquidity ≥ tier amount. Expires stale bundles by checking on-chain nonce.
- **`voip.mjs`** — Optional second notification channel alongside ntfy. REST API client for automated VoIP announcement calls via SIP. Two-step bearer auth (`POST /api/v1/auth/token` → 24h token, cached at module level with 1-min expiry buffer). Call flow: initiate (`POST /api/v1/call`) → poll (`GET /api/v1/call/{id}`) until terminal status. Retries up to `VOIP_MAX_RETRIES` times on `failed`/`no_answer`/`busy`. Disabled when `VOIP_SECRET_KEY` is empty. Vietnamese TTS message, max 500 chars.
- **`webapp-server.mjs`** — HTTP server serving `webapp.html` (SPA). REST API: `GET/POST/DELETE /api/presign`, `POST /api/bundle` (relay to proxy), `GET /api/challenge` + `POST /api/auth` (wallet sign-in → HMAC session token). Write-locked presigned.json access.
- **`proxy-rpc.mjs`** — Fake Ethereum JSON-RPC endpoint. Captures `eth_sendRawTransaction` signed tx hex. Mocks most methods (chainId, gas, blockNumber). Forwards only `eth_getTransactionCount` to real RPC. Handles Rabby-specific methods (`debug_traceCall`, `eth_createAccessList`) with empty responses. CORS mirrors the request `Origin` header for credentialed requests. `POST /bundle` matches captured txs with tier metadata via the webapp. `GET /captured` and `DELETE /captured` endpoints for debugging the tx buffer. Mutex-guarded `capturedTxs` buffer.
- **`index.mjs`** — Standalone CLI: fetches and pretty-prints market state + lender position.
- **`verify-presigned.mjs`** — Standalone CLI: parses signed transactions from a bundle JSON, decodes calldata, verifies it's a valid Morpho `withdraw()` call with matching amounts and nonce. Duplicates the Morpho `withdraw()` ABI definition (also present in `webapp.html`).
- **`webapp.html`** — Browser-side SPA served by `webapp-server.mjs`. Uses `viem` `createPublicClient` with a simplified `fallbackTransport()` (round-robin without circuit breaker — browser sessions are short-lived). RPC URLs are hardcoded (duplicated from `shared.mjs`). Detects wallet type (Rabby, MetaMask, Frame, Coinbase Wallet, Trust Wallet) via EIP-1193 provider flags. Uses a `_listenersAttached` boolean guard to prevent duplicate event listener registration. Communicates with the webapp server via REST (`/api/challenge`, `/api/auth`, `/api/bundle`, `/api/presign`) and with MetaMask via the proxy RPC.

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

### VoIP notification (voip.mjs)
- Optional second notification channel alongside ntfy. Disabled when `VOIP_SECRET_KEY` is empty.
- Two-step bearer auth: `POST /api/v1/auth/token` for a 24h token, cached at module level with 1-min expiry buffer. On 401, cache is cleared and re-authentication is attempted automatically.
- Call flow: initiate call (`POST /api/v1/call`), then poll (`GET /api/v1/call/{id}`) until terminal status. Poll interval 2s, timeout 30s.
- Terminal statuses: `completed` (success), `failed`/`no_answer`/`busy` (triggers retry).
- Retry: up to `VOIP_MAX_RETRIES` (default 3) with `VOIP_RETRY_DELAY_MS` (default 5s) between attempts.
- Anti-spam integration: VoIP failures do NOT burn notification quota (same pattern as ntfy failures). VoIP runs independently of ntfy — if ntfy fails, VoIP still attempts.
- Message: plain-text Vietnamese with diacritics, max 500 characters, optimized for TTS (text-to-speech).
- Tested via duplicated pure functions and mocked fetch, following ntfy.test.mjs convention.

### Write serialization (webapp-server.mjs)
- POST /api/presign uses a promise chain + cross-process `withFileLock` (`.lock` file) to serialize concurrent reads/writes to presigned.json (webapp POST/DELETE and monitor broadcast/expire). Atomic write via tmp file + rename.


### Challenge rate limiting (webapp-server.mjs)
`GET /api/challenge` is rate-limited to 10 requests per minute per IP via the `challengeRateLimit` Map. IPs exceeding the limit receive HTTP 429. Expired rate-limit entries are cleaned up every 2 minutes along with expired challenges.

### Dependency injection for testing (expire-bundle.test.mjs)
`expireStaleBundle` in `monitor.mjs` accepts `fs` and `client` as explicit parameters (injected) rather than importing them directly. The test file passes mocks for `existsSync`, `readFileSync`, `writeFileSync`, `unlinkSync`, and `getTransactionCount`. This separates business logic from I/O, making the function testable without real filesystem or chain calls.

### WebSocket hybrid trigger (monitor.mjs)

WebSocket `eth_subscribe` được dùng làm **trigger** (không phải data source) để giảm độ trễ phát hiện từ 0-30s xuống 0-3s. Kiến trúc additive — không sửa đổi logic hiện có, chỉ thêm trigger bổ sung.

```
5 × watchContractEvent(eventName="Supply", args={id: MARKET_ID})
  → topics = [[Supply_sig], MARKET_ID]    ← lọc CHÍNH XÁC ở RPC level
5 × watchContractEvent(eventName="Withdraw", args={id: MARKET_ID})
... (Borrow, Repay, Liquidate)

→ Chỉ nhận events cho đúng market, không nhận event thừa từ market khác
→ Mỗi event → debouncedCheck() [gộp trong WSS_DEBOUNCE_MS window, mặc định 3s]
  → checkAndNotify() [GIỮ NGUYÊN 100%, fetch dữ liệu qua HTTP]
    → fetchMarket()     ← HTTP RPC (dữ liệu chính xác, không delta tracking)
    → shouldNotify()    ← anti-spam không đổi
    → broadcastPresigned()

setInterval(30s) → vẫn chạy song song làm fallback
```

- **5 subscription riêng biệt** — mỗi event (Supply, Withdraw, Borrow, Repay, Liquidate) một `watchContractEvent` với `eventName` là SINGLE STRING. `viem` encode `args: { id: MARKET_ID }` chính xác thành `topics[1] = MARKET_ID`, lọc ở RPC level. 5 subscription dùng chung 1 WebSocket connection → không tốn thêm tài nguyên.
- **Tại sao không dùng `watchEvent` với `events[]`?** — `watchEvent` trong viem 2.53 bị lỗi encode topics khi dùng `events` (plural) + `args`: `flatMap` nhét tất cả event signatures + args values vào `topics[0]`, khiến `args.id` bị coi là event signature thay vì filter `topics[1]`. Hậu quả: subscription khớp MỌI market thay vì chỉ market được chỉ định.
- **WebSocket chỉ làm trigger** — không tham gia vào data pipeline. Mọi quyết định vẫn dựa trên HTTP `fetchMarket()`.
- **Debounce 3s** — gộp nhiều events trong cùng block thành 1 lần check, tránh spam RPC calls. 5 events cùng block → `clearTimeout` reset timer → chỉ 1 `checkAndNotify()`.
- **Sequential failover** — thử từng WSS URL theo thứ tự. `createPublicClient` + `webSocket()` là synchronous, cần gọi `client.getChainId()` để test kết nối thực sự. Connection failure → chuyển URL tiếp theo.
- **3 lớp guard trong `onError`**: (1) `wsState === null` — chặn duplicate failover từ nhiều subscription cùng lúc; (2) `wsState.url !== url` — chặn error từ connection cũ kill connection mới sau khi đã failover; (3) Phân loại lỗi: "socket closed"/"timeout" → `console.warn` + `return` (viem tự reconnect), "method not found"/"-32601" → failover sang URL tiếp theo.
- **Reconnect poll** — Khi socket đóng, `_reconnectTimer = setInterval(10s)` gọi `client.getChainId()` đến khi thành công → log "✅ Đã reconnect" + `debouncedCheck()`. Nếu `onLogs` nhận event trước khi timer chạy → clear timer + log reconnect ngay. Timer được cleanup trong failover và shutdown.
- **Dedup `onError` log** — 5 subscription dùng chung 1 WebSocket → cùng lỗi. `_lastWsError` lưu message + timestamp, bỏ qua nếu trùng message trong 1s.
- **Config**: `WSS_URLS` (comma-separated WSS endpoints), `WSS_DEBOUNCE_MS` (debounce window, mặc định 3000ms).
- **Shutdown**: `stopWsWatcher()` gọi tất cả 5 `unwatch()` + `clearTimeout(debounceTimer)` + `clearInterval(_reconnectTimer)`.

### Browser fallback transport (webapp.html)
A simplified round-robin transport without circuit breaker. Each request starts at a random URL index. On failure, it tries the next URL. On success, it advances the index for the next request. No circuit breaker because browser sessions are short-lived and the user can simply refresh.

### Wallet compatibility detection (webapp.html)
Detects the user's wallet by checking EIP-1193 provider flags: `e.isRabby`, `e.isMetaMask`, `e.isFrame`, `e.isCoinbaseWallet`, `e.isTrust`. Each detected type gets a tailored UI message. Rabby-specific: `wallet_addEthereumChain` shows a warning about duplicate chainId=1.

## Conventions

- **Some test files duplicate pure functions** rather than importing from source, to avoid module-level side effects (top-level awaits, RPC connections) that would fire on import:
  - `shared.test.mjs` — imports directly from `../shared.mjs` (no side effects)
  - `rpc-client.test.mjs` — imports from `../rpc-client.mjs` (uses `vi.mock` for viem)
  - `monitor.test.mjs` — imports `shouldNotify` from `../shared.mjs`
  - `webapp.test.mjs` — duplicates 8 pure functions from `webapp.html` (browser ESM cannot be imported by vitest)
  - `presign-broadcast.test.mjs` — duplicates `selectBestPresignedTx` and `validatePresignedBundle` from `monitor.mjs`
  - `expire-bundle.test.mjs` — duplicates `expireStaleBundle` from `monitor.mjs` (uses dependency injection: accepts `fs` and `client` as parameters)
  - `ntfy.test.mjs` — duplicates `buildNtfyPayload` from `monitor.mjs`; includes 6 live integration tests that POST to `ntfy.sh`
  - `wss-watcher.test.mjs` — duplicates `debouncedCheck` debounce logic and sequential failover pattern from `monitor.mjs` (15 tests); uses fake timers for debounce verification
- **Vietnamese comments and log messages** throughout. UI is in Vietnamese.
- **`--env-file=.env`** flag required for all `node` commands. The `.env` file is gitignored; `.env.example` is the template.
- **Port conventions:** webapp=3000, proxy=8545. Proxy URL is auto-derived from `WEBAPP_URL` host + `PROXY_PORT`.
- **Docker:** `docker-compose.yml` runs all three services under a supervisor shell script that auto-restarts crashed processes.
- **HTTPS/SSL:** Servers support HTTPS khi `SSL_CERT_PATH` và `SSL_KEY_PATH` được set trong `.env`. Để trống cả hai → chạy HTTP như cũ. Xem hướng dẫn thiết lập Let's Encrypt bên dưới.
- **`webapp.html` hardcodes RPC URLs** identically to `shared.mjs`. Both files must be updated together when URLs change.
- **`env()` uses `??` (nullish coalescing)** — returns empty string `""` (not fallback) when the env var is set to `""`. Important for `NTFY_TOPIC` and `WEBAPP_PASSWORD`: setting them to `""` enables dev mode / no auth, while leaving them unset uses the fallback value.

## HTTPS với Let's Encrypt trên VPS

Toàn bộ `/etc/letsencrypt` được mount read-only vào `/certs/` trong container.
Không cần copy certs — Let's Encrypt tự renew, container tự động dùng cert mới sau khi restart.

### 1. Cài đặt certbot và lấy chứng chỉ

```bash
# Cài certbot (Ubuntu/Debian)
sudo apt install certbot

# Lấy chứng chỉ (yêu cầu domain trỏ về VPS và port 80 mở)
sudo certbot certonly --standalone -d your-domain.com
```

### 2. Cấu hình .env

```ini
# SSL — thay your-domain.com bằng tên miền thật
SSL_CERT_PATH=/certs/live/your-domain.com/fullchain.pem
SSL_KEY_PATH=/certs/live/your-domain.com/privkey.pem

# Cập nhật URL sang HTTPS
WEBAPP_URL=https://your-domain.com
# PROXY_RPC_URL sẽ tự động derive thành https://your-domain.com:8545
```

### 3. docker-compose.yml

Mount `/etc/letsencrypt` đã được cấu hình sẵn (dòng `- /etc/letsencrypt:/certs/:ro`). Không cần chỉnh sửa.

### 4. Mở port trên firewall

```bash
# Mở webapp (3000) và proxy RPC (8545) cho MetaMask mobile.
# Capture gated bởi from===LENDER; đặt WEBAPP_PASSWORD khi public.
sudo ufw allow 3000/tcp
sudo ufw allow 8545/tcp
```

### 5. Khởi động

```bash
docker compose up -d --build
# Kiểm tra: curl -v https://your-domain.com:3000
```

### 6. Tự động renew chứng chỉ

Certbot tự động renew qua systemd timer. Chỉ cần restart container để load cert mới:

```bash
# /etc/letsencrypt/renewal-hooks/deploy/morpho.sh
#!/bin/bash
docker restart morpho
```

```bash
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/morpho.sh
```

Kiểm tra timer: `systemctl status certbot.timer`.

## Sharp edges

- `WEBAPP_PASSWORD` doubles as both HTTP Basic Auth secret AND HMAC key for session tokens. Changing it invalidates all existing sessions.
- `proxy-rpc.mjs` has a top-level `await` for the initial block fetch. The module won't finish loading until that resolves or times out.
- `capturedTxs` in proxy-rpc.mjs is in-memory only. Proxy restart loses all captured transactions.
- `tokenCache` in voip.mjs is in-memory only. It resets on process restart. On 401, the cache is cleared and re-authentication is attempted automatically.
- `challenges` Map and `challengeRateLimit` Map in webapp-server.mjs are in-memory. They reset on restart.
- The `DELETE /api/presign` handler and `broadcastPresigned`/`expireStaleBundle` in monitor.mjs coordinate via `withFileLock` on `presigned.json.lock` (same lock as webapp POST).
- Proxy binds `PROXY_HOST` (default `127.0.0.1`). Docker publishes `8545:8545` for MetaMask mobile. Capture gated by lender sender + Morpho withdraw decode; `/bundle` and `/captured` require lender Bearer or Basic auth.
- `presign-verify.mjs` verifies Morpho `withdraw` calldata on save (proxy + webapp) and before broadcast (monitor).
- Test files import `describe, it, expect` from vitest globally (configured via `vitest.config.mjs` `globals: true`), plus explicit imports. The explicit imports are redundant but harmless.
- `webapp.html` hardcodes the 11 RPC URLs (duplicated from `shared.mjs`). Changing RPC URLs requires editing both files.
- `webapp.html` uses a simplified `fallbackTransport()` without circuit breaker. If all 11 URLs are slow, the browser may hang for up to 165s (11 × 15s timeout).
- `verify-presigned.mjs` duplicates the Morpho `withdraw()` ABI definition. The same ABI is also in `webapp.html`. Updates to the ABI must be applied in both places.
- `webapp-server.mjs` sets security headers: `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`. Requests for sensitive file extensions (`.json`, `.env`, `.log`, `.tar`) return 403 Forbidden.
- `proxy-rpc.mjs` CORS mirrors the request `Origin` header. Any origin can make credentialed requests — acceptable since the proxy only listens on localhost, but worth noting if exposed.
- `ntfy.test.mjs` contains 6 live integration tests that make real HTTP requests to ntfy.sh. These require `NTFY_SERVER` env var (defaults to `https://ntfy.sh`). Included in `npm test` — may fail in offline environments.
- `docker-entrypoint.sh` uses `wait -n` to detect when any child process exits, then checks each PID via `kill -0` and restarts any dead service. This provides self-healing without a full process manager.
- `monitor.mjs` WSS watcher uses 5 separate `watchContractEvent` calls (one per event) instead of `watchEvent` with `events[]`. Reason: `watchEvent` in viem 2.53 has a bug where `flatMap` over multiple events + `args` flattens topic encodings incorrectly — `args.id` values end up mixed with event signatures in `topics[0]` instead of being placed in `topics[1]` as a proper indexed filter. Using `watchContractEvent` with a SINGLE STRING `eventName` per call avoids this bug and correctly filters at the RPC level.
- `createPublicClient` with `webSocket()` transport is synchronous and doesn't throw on connection failure. To detect failures and enable sequential failover, `_tryConnectWss()` calls `client.getChainId()` after creating the client. Without this test call, the first URL would silently fail and subsequent URLs would never be tried.
- WSS endpoints must support `eth_subscribe` with `logs` subscription type. If an endpoint doesn't support it, `onError` fires with "method not found" and the watcher fails over to the next URL.
