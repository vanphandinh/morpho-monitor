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
npm run verify -- [path] [--market 0x…]   # verify registry v3/v2 hoặc bare bundle (exit 1 khi mismatch)
node --env-file=.env verify-presigned.mjs [path/to/presigned.json] [--market 0x…]

# Static gates
npm run lint         # oxlint --deny no-undef (bắt lớp lỗi C1: identifier đã bị xoá)
npm run check        # lint + node --check (.mjs + script nội tuyến của webapp.html) + vitest run

# Tests
npm test             # vitest run (all 525 tests across 35 files; 518 chạy + 7 skipped = live ntfy, NTFY_LIVE=1 để chạy)
npx vitest run       # same
npx vitest           # watch mode
npx vitest run __tests__/shared.test.mjs  # single file
```

## Architecture: three long-running processes

```
.env ──→ shared.mjs (config + format) · monitor-rules.mjs (anti-spam rules) · auth.mjs (HMAC) · file-lock.mjs
              │
   ┌──────────┼────────────────┬───────────────┬───────────────┐
   │          │                │               │               │
monitor.mjs  webapp-server.mjs proxy-rpc.mjs   voip.mjs    wss-connect.mjs
(polling +   (port 3000)      (port 8545)     (VoIP REST  (viem webSocket +
 WSS hybrid)   │                │             API client) closeTransport)
   │           │                │
   │      webapp-handler.mjs    proxy-dispatcher.mjs
   │      webapp-config.mjs     (JSON-RPC + /bundle + /captured)
   │           │ (serves ↓)
   │        webapp.html (browser SPA)
   │        ├─ webapp-app.mjs      (script chính)
   │        ├─ webapp-logic.mjs    (logic thuần, dùng chung với test)
   │        ├─ webapp-render.mjs   (esc/row/formatToken — audit P2.7)
   │        └─ webapp-wallet.mjs   (nhận diện ví EIP-1193 — audit P2.7)
   │
   ├─ monitor-triggers.mjs    (lossless scheduler + single-endpoint WSS watcher)
   ├─ market-reader.mjs       (same-block multicall snapshots)
   ├─ presigned-broadcast.mjs (nonce-wide claim + receipt-grounded lifecycle)
   ├─ presigned-store.mjs     (registry v3 multi-nonce ladder + withFileLock + lifecycle guard)
   ├─ lifecycle-alert.mjs     (ntfy cảnh báo claim kẹt — kênh riêng, không tốn quota)
   └─ presign-verify.mjs      (Morpho withdraw calldata verification)

tất cả HTTP: rpc-client.mjs (circuit breaker + round-robin RPC transport)
```

- **`shared.mjs`** — Config/env + formatting/body helpers only (read from `.env` via `env()`/`envNum()`): addresses, `RPC_URLS` (server), key-less `PUBLIC_RPC_URLS` (browser), `PROXY_RPC_RATE_LIMIT` / `PROXY_ALLOW_PUBLIC_RPC` (both default OFF), `readBodyLimited()`, `recoverSignerAddress()`. Audit P1.4 split the grab-bag: anti-spam rules → `monitor-rules.mjs`, HMAC auth → `auth.mjs`, cross-process lock → `file-lock.mjs`.
- **`startup-retry.mjs`** — `retryStartup()` + `isRetryableStartupError()` (audit vòng 5 O3): the monitor's bootstrap retries only *infrastructure* failures (~30s of backoff); config errors such as `MARKET_PARAMS_ZERO` throw on the first attempt, and `loadMarkets` stays outside the retry entirely.
- **`monitor-rules.mjs`** — Pure anti-spam/broadcast rules (`shouldNotify`, `computeDrainThreshold`, `shouldBroadcastPresigned`). No imports, no I/O, no env.
- **`auth.mjs`** — HMAC session tokens + bearer/basic auth middleware (`createSessionToken`, `verifySessionToken`, `verifyToken`, `checkInternalSecret`, `requireLenderOrInternal`). Depends one-way on `shared.mjs` config.
- **`file-lock.mjs`** — Cross-process `withFileLock` + `LOCK_STALE` diagnostic; node:fs/node:os only.
- **`rpc-client.mjs`** — Circuit breaker per RPC URL (CLOSED→OPEN→HALF-OPEN→CLOSED), round-robin transport across every configured RPC URL, `createRobustPublicClient()`/`createRobustWalletClient()` factories. Module-level `circuits` Map persists across all clients. Exports `addGlobalErrorHandlers()` for daemon resilience.
- **`monitor.mjs`** — Exports `createMonitor(deps)` (reader/notifier/broadcaster/alerter injected — audit P1.5, so cycles are unit-testable); the bootstrap runs only when the file is executed directly, so importing it has no side effects. Polls Morpho Blue markets on `setInterval` through `createCheckScheduler` (polling and WSS events share one lossless queue; a failing cycle is logged per cycle and never kills the loop). ALSO starts `startWss()`, which uses `createWssConnect()`: 5 separate `watchContractEvent` subscriptions (one per event: Supply, Withdraw, Borrow, Repay, Liquidate) with `eventName` as a SINGLE STRING and `args: { id: marketIds }` for RPC-level topic filtering (`topics[1]`). Events call `scheduler.request(ids)`; the debounce coalesces a block's events into one `checkMarkets()` run. Uses `shouldNotify()` for anti-spam (per-market threshold, 0→positive transition, cycle dedup, cooldown, daily limit). Sends ntfy.sh push notifications AND VoIP calls. Broadcasts pre-signed bundles when liquidity ≥ tier amount; bundle expiry and terminal transitions live in `presigned-broadcast.mjs` (receipt-grounded — a pending-nonce advance never expires a `broadcasting` claim).
- **`monitor-triggers.mjs`** — Lossless scheduler shared by polling and WSS. It unions market IDs, lets all-market requests dominate, always executes a trailing run for work arriving during a check, and catches a throwing check per cycle (logged, loop survives). Its WSS watcher keeps one endpoint active with per-attempt resource ownership: a partial subscription failure closes every earlier subscription AND the connection before advancing; error callbacks AND `onLogs` callbacks are fenced by connection generation (logs from a replaced/closed endpoint never wake the scheduler); a runtime failure rotates to the NEXT url; when every url has failed the whole set is retried with bounded backoff (30s, timer cancelled on close). Polling remains the fallback during WSS outages.
- **`presigned-broadcast.mjs`** — Registry lifecycle for the nonce-wide claim, generalized to the **multi-nonce ladder** (v3): the registry can hold many bundles at once (different markets and/or different nonces for one market), but only the entry at the CURRENT on-chain pending nonce is ever claimable — txs mine strictly in nonce order, so broadcasts naturally run **ascending by nonce** and higher rungs just wait. A future-nonce tx is never pre-broadcast (it would mine unconditionally and defeat the trigger condition). Same-nonce races (multiple markets presigned at the same nonce) resolve by trigger: whichever market crosses its drain threshold first is claimed (markets.json order breaks a same-cycle tie); the mined receipt then expires every same-nonce sibling. Expiry is on-chain-nonce-based: `pending` bundles at or below the highest consumed nonce expire. Durable claim (status `broadcasting`, tier, exact `rawTx` bytes + `txHash`) is persisted BEFORE any RPC I/O. Recovery reconciles by the persisted hash: rebroadcast only the exact persisted bytes after `keccak256(rawTx) === txHash`, and only after `RECOVERY_THRESHOLD_MS` (180s) with no mined receipt. A legacy `broadcasting` record without raw identity (or with a hash mismatch) stays claimed and reports manual reconciliation — never auto-unlocked. Only a mined receipt carrying block identity permits terminal `submitted`/`failed` (writes `terminalAt`, expires same-nonce siblings). `submitted`/`failed` records are **inert history**: they never reserve, conflict, reconcile or warn — but their nonce stays consumed forever. Multiple live claims are reconciled oldest `broadcastingAt` first; two live claims sharing one nonce fail closed. A pending-nonce advance expires `pending` bundles only — never the claim. **Third terminal status `superseded` (audit R1):** a durable `broadcasting` claim whose nonce was consumed by a *different* transaction can never mine and would otherwise freeze the whole ladder forever (the webapp can neither re-sign that nonce — 409 — nor delete the record). After `RECOVERY_THRESHOLD_MS` it is released only when two independent pieces of evidence agree: `getTransactionReceipt(claim.txHash)` returns **null** *and* `eth_getTransactionCount(latest)` is strictly greater than the claim's nonce (a mined tx cannot skip a nonce; a *throwing* lookup or non-finite nonce is not evidence, so the claim stays `broadcasting`). Release is one locked mutation: `status: "superseded"` + `reason` + `terminalAt`, `rawTx` deleted (those bytes are unusable — the nonce is gone), `withdrawals` kept for the record, same-nonce siblings expired, and the nonce stays consumed forever exactly like `submitted`/`failed`. `releaseSuperseded()` logs `[presign] claim <id> released as superseded`.
- **`presigned-store.mjs`** — Registry v3 read/write with atomic rename + 0600 perms, and `updateRegistry(filePath, mutate, { origin })`. **v3 is a multi-nonce ladder**: bundles are stored with opaque keys (new saves use composite `marketId@nonce` via the webapp API); a bundle's identity is read from its VALUES — `bundle.marketId` + `bundle.nonce` — never from the key. v2 files are auto-migrated in-memory on read (keys kept, `marketId` stamped from the key; re-written as v3); v1/garbage fails closed. Helpers: `bundleKey`, `parseBundleKey`, `marketBundles` (per-market ladder, ascending nonce), `nonceRounds` (bundles grouped by nonce — the race view). `origin: "user"` (webapp API) rejects any mutation that deletes or alters an active claim (broadcasting/submitted bundle, its nonce, tx identity, or tier list) by comparing an active-claim signature before/after the mutation inside the same file lock; the rejection carries code `ACTIVE_CLAIM_CONFLICT` for HTTP 409 mapping. Monitor-origin mutations are unrestricted. `registrySummary(bundle)` (the `GET /api/overview` payload) surfaces `broadcastingAt` and `reason` in addition to status/nonce/tiers, so the browser can show how long a claim has been `broadcasting` and why it ended up `superseded`.
- **`webapp-handler.mjs`** — Importable pure HTTP request handler (`createRequestHandler({ presignedPath, markets, content, ... })`). All responses are deferred until the registry mutation commits, so no 200 is sent before the lifecycle guard passes. Error codes map to HTTP statuses: `MARKET_INPUT_INVALID` → 400, `MARKET_NOT_CONFIGURED` → 404, `ACTIVE_CLAIM_CONFLICT` → 409, anything else → 500. POST /api/presign strips client-supplied lifecycle fields (`status`, `txHash`, `rawTx`, `broadcastingAt`, `broadcastingTier`, `minedAt`, `submittedAt`) and persists verified `pending` data only; merging into a broadcasting/submitted/failed bundle is refused. `GET /api/overview` (auth like /api/presign) returns `{ ok, lenderAddress, markets: [{ id, ...registrySummary }] }` for **every** configured market — the multi-market presign dashboard data source (missing bundle → `exists: false`); on-chain nonce is deliberately not included (browser computes duplicate-nonce warnings from bundle nonces).
- **`webapp-server.mjs`** — Thin bootstrap: loads markets, injects `window.MORPHO_CONFIG` via `webapp-config.mjs` (fail-fast when `LENDER_ADDRESS`/`PROXY_RPC_URL` are missing), wires SSL, creates the handler's challenge-cleanup timer, and serves `createRequestHandler` from `webapp-handler.mjs`. Keep business logic in the handler module so tests exercise the real HTTP process without triggering startup side effects.
- **`webapp-config.mjs`** — `buildWebappConfig()` / `injectWebappConfig()`: derives the browser config from `shared.mjs` (`LENDER_ADDRESS`, derived `PROXY_RPC_URL`, `PUBLIC_RPC_URLS` — key-less browser RPC, **never** the keyed `RPC_URLS`, plus `claimRecoveryMs` so the browser never copies `RECOVERY_THRESHOLD_MS`) and escapes `<` so env values cannot break out of the injected `<script>`. A URL matching a credential pattern (query `apikey=`, provider key-in-path) is rejected fail-closed (`urlLooksCredentialed`) — the webapp is public, an injected key is a leaked key. Also hosts the auth fail-fast pair: `assertWebappAuthConfig()` (webapp) and `assertProxyAuthConfig({ host })` (proxy, called before `loadMarkets()` in `proxy-rpc.mjs`) — binding a non-loopback host with an empty `WEBAPP_PASSWORD` aborts startup unless `WEBAPP_ALLOW_INSECURE=1` is set deliberately. A public bind **with** a password is allowed but returns a warning (audit D3): the password only guards `/bundle` and `/captured` (lender-gated), while the JSON-RPC relay must stay header-free for wallets, so anyone reaching port 8545 can relay `eth_call`/`eth_getLogs`/`eth_feeHistory` through your `RPC_URLS`.
- **`notification-dispatch.mjs`** — Independently invokes ntfy and VoIP and reports `ntfyDelivered`; monitor quota changes only from that result.
- **`lifecycle-alert.mjs`** — Out-of-band ntfy alerts for wedged presign claims (audit R1). Deliberately separate from `notification-dispatch.mjs`: liquidity alerts go through the shared anti-spam quota, lifecycle alerts use their own topic and **never** call `shouldNotify()`, so a stuck claim cannot be silenced by the daily limit (and cannot burn the liquidity quota). `buildLifecycleAlert` renders kinds `superseded`/`stuck`/`conflict` with priorities 4/5/5; `postNtfy({ fetchImpl, server, topic, alert, timeoutMs })` posts with an `AbortSignal.timeout(NTFY_ALERT_TIMEOUT_MS)` (10s); `createLifecycleAlerter({ send, cooldownMs, now, logger })` keeps a 6h per-`(kind, marketId)` cooldown Map in memory — stamped **before** the send so a failing send cannot retry-storm — and swallows send errors. Wired in `monitor.mjs` as `await alertOnLifecycle(await broadcastEligible(snapshots))` on every cycle.
- **`voip.mjs`** — Optional second notification channel alongside ntfy. REST API client for automated VoIP announcement calls via SIP. Two-step bearer auth (`POST /api/v1/auth/token` → 24h token, cached at module level with 1-min expiry buffer). Call flow: initiate (`POST /api/v1/call`) → poll (`GET /api/v1/call/{id}`) until terminal status. Retries up to `VOIP_MAX_RETRIES` times on `failed`/`no_answer`/`busy`. Disabled when `VOIP_SECRET_KEY` is empty. Vietnamese TTS message, max 500 chars.

- **`proxy-rpc.mjs`** — Bootstrap only (SSL, block-number fallback, `capturedTxs`, `listen`). All JSON-RPC methods and HTTP routes live in `proxy-dispatcher.mjs`.
- **`proxy-dispatcher.mjs`** — Importable fake Ethereum JSON-RPC endpoint (`createRpcDispatcher` / `createProxyRequestHandler`). Captures `eth_sendRawTransaction` signed tx hex. Mocks most methods (chainId, gas, blockNumber) and forwards `eth_getTransactionCount`/`eth_call`/receipts to the real RPC. Handles Rabby-specific methods (`debug_traceCall`, `eth_createAccessList`) with empty responses. `morpho_proxyInfo` → `{ server: "morpho-proxy", chainId: 1 }` is a manual/debug probe only (since 2026-09-24 the webapp no longer calls it — the H5 preflight gate was removed); `web3_clientVersion` stays `"MorphoProxy/v1"`. CORS mirrors the request `Origin` header for credentialed requests. `POST /bundle` matches captured txs with tier metadata via the webapp. `GET /captured` and `DELETE /captured` endpoints for debugging the tx buffer. Mutex-guarded bundle assembly; the capture buffer is capped at `MAX_CAPTURED_TXS` (50, oldest dropped). Since audit vòng 5 (O2) the JSON-RPC branch can be bounded, both off by default: `rpcRateLimit` (per-IP sliding window — over the limit ⇒ JSON-RPC `-32005` with HTTP 200, never 429, because a wallet would treat 429 as a transient network error and retry) and `rpcMethodAllowList` (exported `RPC_METHOD_ALLOW_LIST`, the wallet method set). Wired from `PROXY_RPC_RATE_LIMIT` / `PROXY_ALLOW_PUBLIC_RPC` in `proxy-rpc.mjs`; the limiter only counts the JSON-RPC branch (OPTIONS/`/bundle`/`/captured` unaffected).
- **`index.mjs`** — Standalone CLI: fetches and pretty-prints market state + lender position.
- **`verify-presigned.mjs`** — Standalone CLI: parses signed transactions from a bundle JSON (registry v3 ladder or bare bundle), decodes calldata, verifies it's a valid Morpho `withdraw()` call with matching amounts and nonce. Reuses the shared `MORPHO_WITHDRAW_ABI` / verification helpers from `presign-verify.mjs` (no duplicate ABI).
- **`webapp.html`** — Browser-side SPA served by `webapp-server.mjs`. Uses `viem` `createPublicClient` with a simplified `fallbackTransport()` (round-robin without circuit breaker — browser sessions are short-lived) over `CFG.rpcUrls`, i.e. the server-injected key-less `PUBLIC_RPC_URLS` list (`RPC_URLS` carries API keys and is **never** sent to the browser). A public, **key-less** endpoint list is the only fallback; no provider API key is ever embedded in this file (it is served publicly — see Sharp edges). Detects wallet type (Rabby, MetaMask, Ambire, Frame, Coinbase Wallet, Trust Wallet) via EIP-1193 provider flags. `getCompatibilityMessage()` (now in `webapp-wallet.mjs`) reports wallet brand only (`ok: true` for every wallet — the H5 preflight gate was **removed by user decision on 2026-09-24**; see below). Uses a `_listenersAttached` boolean guard to prevent duplicate event listener registration. Communicates with the webapp server via REST (`/api/challenge`, `/api/auth`, `/api/bundle`, `/api/presign`, `/api/overview`) and with MetaMask via the proxy RPC. The browser code is split into modules `webapp-server.mjs` serves alongside the HTML (audit A.1/A.1b/P2.7): `webapp-app.mjs` (main script + DOM wiring), `webapp-logic.mjs` (pure calc, imported by tests), `webapp-render.mjs` (`esc`/`row`/`formatToken`) and `webapp-wallet.mjs` (EIP-1193 brand detection). `webapp-handler.mjs` serves every configured module through a route map keyed by bare filename (`.mjs` paths → JSON 404 when not wired, never the HTML SPA fallback). Multi-market UX: a market switcher (`#market-switcher`, hidden when only one market is configured) navigates via `?market=<id>`; the presign tab shows an overview block (`/api/overview`) listing every market's bundle status/nonce/tier count and warns when two or more active bundles (pending/broadcasting) share a nonce — only one can ever mine, siblings get expired. **Non-presign "Rút Tiền" tab (audit R4):** `doWithdraw` reports success straight from `walletClient.writeContract`'s hash — and the tx's route is decided by the RPC configured *inside the wallet*. If the wallet points at the proxy (port 8545) the tx is only captured, never broadcast, yet the old UI said "✅ thành công". The banner now appends a **best-effort, non-blocking** verification (`txVisibleOnChain`: 4 tries × 3s against `CFG.rpcUrls`) that warns the user when the hash is still invisible — it never blocks or reverses the success message, since a slow propagation is not evidence of failure (same reasoning that removed the H5 preflight gate).

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
Pure function tested independently. Five checks in order: threshold, 0→positive transition, cycle dedup, cooldown, daily limit with day-roll detection. Monitor only updates state on successful ntfy delivery (failures don't burn quota). Lifecycle alerts (`lifecycle-alert.mjs`) bypass `shouldNotify()` entirely — they carry their own per-`(kind, marketId)` cooldown and never consume the liquidity quota, so an operator cannot lose withdrawal alerts because a claim got stuck.

### VoIP notification (voip.mjs)
- Optional second notification channel alongside ntfy. Disabled when `VOIP_SECRET_KEY` is empty.
- Two-step bearer auth: `POST /api/v1/auth/token` for a 24h token, cached at module level with 1-min expiry buffer. On 401, cache is cleared and re-authentication is attempted automatically.
- Call flow: initiate call (`POST /api/v1/call`), then poll (`GET /api/v1/call/{id}`) until terminal status. Poll interval 2s, timeout 30s.
- Terminal statuses: `completed` (success), `failed`/`no_answer`/`busy` (triggers retry).
- Retry: up to `VOIP_MAX_RETRIES` (default 3) with `VOIP_RETRY_DELAY_MS` (default 5s) between attempts.
- Anti-spam integration: VoIP failures do NOT burn notification quota (same pattern as ntfy failures). VoIP runs independently of ntfy — if ntfy fails, VoIP still attempts.
- Message: plain-text Vietnamese with diacritics, max 500 characters, optimized for TTS (text-to-speech).
- Tested by importing the real production exports with injected `fetchImpl`/`sleepImpl`/`now` (audit P1.6); no duplicated logic in the test.

### Write serialization and lifecycle guard (presigned-store.mjs)
- All registry mutations go through `updateRegistry` → cross-process `withFileLock` (`.lock` file) → read → mutate → atomic write (tmp file + rename). Webapp POST/DELETE use `origin: "user"`; the monitor broadcaster uses the default monitor origin.
- User-origin mutations are compared against an active-claim signature (id, status, nonce, txHash, tier digest of every broadcasting/submitted bundle) taken before and after the mutation inside the same lock. Any difference rejects the mutation with `ACTIVE_CLAIM_CONFLICT` and the registry is left unchanged — the web UI can never delete or edit an in-flight withdrawal.

### Presigned lifecycle invariants (presigned-broadcast.mjs)
1. Claim is durable before RPC I/O: `broadcasting` + tier + exact `rawTx` + `keccak256(rawTx)` are persisted in one locked mutation before any network send.
2. Timeout, ambiguous RPC error, or pending-nonce advance never clears a claim; only a mined receipt for the exact hash does.
3. Recovery rebroadcasts the exact persisted bytes only, and only after the recovery window (180s); identity mismatches fail closed with a diagnostic.
4. A mined receipt (block identity required) transitions to `submitted`/`failed` and expires same-nonce siblings — the nonce is consumed.
5. At most one reservation per nonce across the registry; two found → fail closed, no broadcast.
6. A `broadcasting` claim becomes `superseded` only on positive evidence that another tx consumed its nonce (receipt `null` **and** `latest` nonce > claim nonce). Missing, throwing or non-finite evidence leaves the claim as `broadcasting`; the released nonce stays consumed forever (no re-claim, no re-sign of that nonce).


### Challenge rate limiting (webapp-handler.mjs)
`GET /api/challenge` is rate-limited to 10 requests per minute per IP via a per-handler `challengeRateLimit` Map inside the `createRequestHandler` closure (test handlers never share state). IPs exceeding the limit receive HTTP 429. Expired rate-limit entries are cleaned up every 2 minutes along with expired challenges; the interval belongs to the bootstrap (`handler.startCleanupTimer()`, cancelled on shutdown), so importing the handler in tests leaves no timer behind. Routing matches the exact pathname (`/api/presignXYZ` is not `/api/presign`) and any unknown `/api/*` path returns JSON 404 instead of the SPA HTML.

### Dependency injection for testing
`broadcastEligible`, `createRequestHandler`, `createCheckScheduler`, `createWssWatcher`, `createWssConnect`, `createRpcDispatcher`/`createProxyRequestHandler`, `buildWebappConfig` and `injectWebappConfig` all accept their I/O (RPC client, registry path, timers, fetch, connect, viem factories) as injectable parameters, so the production modules are tested directly with fakes instead of duplicated logic. Test doubles for viem WSS must use the real transport shape: `{ value: { getRpcClient: () => Promise.resolve({ close }) } }` — a fake `{ close }` on the transport hides the fact that viem has no `transport.close`.

### WebSocket hybrid trigger (monitor.mjs)

WebSocket `eth_subscribe` được dùng làm **trigger** (không phải data source) để giảm độ trễ phát hiện từ 0-30s xuống 0-3s. Kiến trúc additive — không sửa đổi logic hiện có, chỉ thêm trigger bổ sung.

```
5 × watchContractEvent(eventName="Supply", args={id: marketIds})
  → topics = [[Supply_sig], [marketId…]]    ← lọc CHÍNH XÁC ở RPC level
5 × watchContractEvent(eventName="Withdraw", args={id: marketIds})
... (Borrow, Repay, Liquidate)

→ Chỉ nhận events cho đúng các market đã cấu hình
→ Mỗi event → scheduler.request(ids) [gộp trong WSS_DEBOUNCE_MS window, mặc định 3s]
  → checkMarkets(ids) [fetch dữ liệu qua HTTP]
    → reader.readSnapshots()  ← multicall ở cùng block (dữ liệu chính xác)
    → shouldNotify()          ← anti-spam theo market
    → broadcastEligible()

setInterval(30s) → vẫn chạy song song làm fallback
```

- **5 subscription riêng biệt** — mỗi event (Supply, Withdraw, Borrow, Repay, Liquidate) một `watchContractEvent` với `eventName` là SINGLE STRING. `viem` encode `args: { id: marketIds }` chính xác thành `topics[1]`, lọc ở RPC level. 5 subscription dùng chung 1 WebSocket connection → không tốn thêm tài nguyên.
- **Tại sao không dùng `watchEvent` với `events[]`?** — `watchEvent` trong viem 2.53 bị lỗi encode topics khi dùng `events` (plural) + `args`: `flatMap` nhét tất cả event signatures + args values vào `topics[0]`, khiến `args.id` bị coi là event signature thay vì filter `topics[1]`. Hậu quả: subscription khớp MỌI market thay vì chỉ market được chỉ định.
- **WebSocket chỉ làm trigger** — không tham gia vào data pipeline. Mọi quyết định vẫn dựa trên HTTP `fetchMarket()`.
- **Debounce 3s** — scheduler gộp nhiều events trong cùng block thành 1 lần check (`WSS_DEBOUNCE_MS`), tránh spam RPC calls; work đến trong lúc đang chạy luôn có trailing run riêng.
- **Sequential failover** — thử từng WSS URL theo thứ tự trong `createWssWatcher`. `createPublicClient` + `webSocket()` là synchronous, nên `createWssConnect` gọi `client.getChainId()` để test kết nối thực sự; probe fail → đóng transport rồi chuyển URL tiếp theo.
- **Generation fence** — mọi callback (`onError` **và** `onLogs`) bị chặn theo `generation`: error/log từ endpoint đã bị thay thế hoặc đã `close()` không thể failover lần hai, không thể kích scheduler. Runtime error → rotate sang URL **kế tiếp**; hết URL → retry cả set với backoff 30s (timer bị cancel khi `close()`).
- **Partial subscription cleanup** — nếu subscription thứ N throw, tất cả unwatch trước đó + connection đều được đóng trước khi sang URL khác.
- **Config**: `WSS_URLS` (comma-separated WSS endpoints), `WSS_DEBOUNCE_MS` (debounce window, mặc định 3000ms).
- **Shutdown**: `wssWatcher.close()` → clear retry timer + unwatch 5 subscription + đóng transport thật (`closeTransport`).

### Browser fallback transport (webapp.html)
A simplified round-robin transport without circuit breaker. Each request starts at a random URL index. On failure, it tries the next URL. On success, it advances the index for the next request. No circuit breaker because browser sessions are short-lived and the user can simply refresh.

### Wallet compatibility + sign flow (webapp.html)
**2026-09-24 — H5 preflight gate removed by user decision.** The gate (added for audit H5, commit `969cf9f`) ran `assertProxyNetwork()` before both `walletClient.sendTransaction` call sites and blocked signing unless the wallet's RPC answered `morpho_proxyInfo` with `{ server: "morpho-proxy", chainId: 1 }`. It turned out to be unworkable for smart-contract wallets: Ambire rejects the custom method client-side (`method [morpho_proxyInfo] doesn't has corresponding handler` — the RPC is never reached) and answers `web3_clientVersion` itself ("Ambire v6.21.4"), so no client-side probe can verify the RPC through the wallet. Signing flow is therefore restored to mainline behavior: no client-side gate; every wallet brand reports `ok: true` (Ambire has its own case).

Safety now rests entirely on **server-side checks**: capture only accepts txs from `LENDER_ADDRESS` against configured markets with a valid bundle/nonce; the JSON-RPC proxy still exposes `morpho_proxyInfo` as a manual/debug probe. Known trade-off: an EOA wallet (MetaMask/Rabby) pointed at the wrong RPC will no longer be blocked before signing — the tx would hit mainnet un-captured and invisible to the monitor.

**Verified in practice (2026-09-24, user test):** a presign transaction signed through Ambire was captured successfully (`from` matched `LENDER_ADDRESS`), i.e. Ambire signs via its raw/EOA path rather than its relayer for this flow and **is compatible** with the presign architecture despite rejecting custom JSON-RPC methods.

Wallet detection is by EIP-1193 provider flags (`e.isRabby`, `e.isMetaMask`, `e.isFrame`, `e.isCoinbaseWallet`, `e.isTrust`, `e.isAmbire`) purely for display. The "Thêm Mạng Proxy" button keeps its UX branches: success message as mainline, a manual-RPC instruction when the wallet rejects `wallet_addEthereumChain` ("corresponding handler"), and the Rabby duplicate-chainId warning.

## Conventions

- **Tests import the real production modules**; mirror copies were removed (audit A.1b + P1.6):
  - `shared.test.mjs` — config/format from `../shared.mjs`, rules from `../monitor-rules.mjs`, auth from `../auth.mjs`
  - `monitor.test.mjs` — rules from `../monitor-rules.mjs`; `monitor-cycle.test.mjs` drives `createMonitor()` with fakes
  - `market-reader.test.mjs` — same-block multicall + per-market failure isolation + zero-params fail-fast, via injected fetchers (P0.3)
  - `voip.test.mjs` — imports the real `getBearerToken`/`initiateCall`/`pollCallStatus`/`callWithRetry`/`sendVoipNotification`/`buildVoipMessage` from `../voip.mjs` (a full mirror before P1.6)
  - `webapp.test.mjs` — imports shared pure logic from `../webapp-logic.mjs` (the same file served to the browser)
  - `webapp-render-wallet.test.mjs` — imports `../webapp-render.mjs` (`esc`/`row`/`formatToken`) and `../webapp-wallet.mjs` (brand detection) directly, plus a `formatToken ↔ shared.formatTokenAmount` parity check (audit P2.7)
  - `ntfy.test.mjs` — imports `buildNtfyPayload` from `../monitor.mjs` (audit vòng 5 O4: the local mirror had drifted and was asserting a payload production no longer produced). Also runs 7 live tests that POST to `ntfy.sh` (skipped unless `NTFY_LIVE=1`).
  - `webapp-app-boot.test.mjs` — imports the real `webapp-app.mjs` with a DOM stub built FROM `webapp.html` (`window`/`location`/`sessionStorage`, `fetch` → 503, `confirm` → false), so the module must actually evaluate and its boot path must run; asserts every `on*` handler in the HTML is a live `window` function (audit vòng 5 O1).
  - `proxy-rpc-limits.test.mjs` — drives the real proxy handler with fake `req`/`res` so the per-IP rate limit can be tested without a multi-host setup (audit vòng 5 O2).
  - `startup-retry.test.mjs` — retry/classification of startup failures with injected `sleep`/`log` (audit vòng 5 O3).
  - The lifecycle-critical suites all import production modules (audit 2026-09-23 removed the last copied logic):
    - `presigned-lifecycle.test.mjs` — receipt grounding, raw-tx identity recovery, legacy fail-closed, user-origin guard (temp registries + real `updateRegistry`)
    - `presign-broadcast.test.mjs` — imports production `selectBestWithdrawal`
    - `expire-bundle.test.mjs` — production expiration semantics via `broadcastEligible`
    - `wss-watcher.test.mjs` — production scheduler + WSS watcher (partial cleanup, rotation, bounded retry, generation fence)
    - `presigned-api.test.mjs` — real `createRequestHandler` on a live `http.Server` (400/404/409, market-scoped DELETE, lifecycle-field stripping)
    - `presigned-cross-process.test.mjs` + `two-process-race.test.mjs` — two REAL Node processes racing the same nonce over the production store/broadcaster; at most one raw broadcast (verified via a shared send log)
- **Vietnamese comments and log messages** throughout. UI is in Vietnamese.
- **`--env-file=.env`** flag required for all `node` commands. The `.env` file is gitignored; `.env.example` is the template.
- **Port conventions:** webapp=3000, proxy=8545. Proxy URL is auto-derived from `WEBAPP_URL` host + `PROXY_PORT`.
- **Docker:** `docker-compose.yml` runs all three services under a supervisor shell script that auto-restarts crashed processes.
- **HTTPS/SSL:** Servers support HTTPS khi `SSL_CERT_PATH` và `SSL_KEY_PATH` được set trong `.env`. Để trống cả hai → chạy HTTP như cũ. Xem hướng dẫn thiết lập Let's Encrypt bên dưới.
- **Browser RPC endpoints come from the server**: `webapp.html` reads `CFG.rpcUrls` (injected from `RPC_URLS` in `shared.mjs` via `webapp-config.mjs`) and only falls back to a small key-less public list. Never embed provider API keys in `webapp.html` — the file is served publicly (VPS + Let's Encrypt) and any key in it is exposed.
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
- `proxy-rpc.mjs` has a top-level `await` for the initial block fetch. The module won't finish loading until that resolves or times out, which is why it is not importable in tests: all testable logic lives in `proxy-dispatcher.mjs`.
- `wss-connect.mjs` closes transports through viem's real API (`getRpcClient()` → `Promise<SocketRpcClient>.close()`, with a `getSocket()` fallback). `client.transport.close` does not exist in viem 2.53 — calling it is a silent no-op that leaks the socket plus its keepAlive/reconnect timers.
- `capturedTxs` in proxy-rpc.mjs is in-memory only. Proxy restart loses all captured transactions.
- `tokenCache` in voip.mjs is in-memory only. It resets on process restart. On 401, the cache is cleared and re-authentication is attempted automatically.
- `challenges` Map and `challengeRateLimit` Map live in the `createRequestHandler` closure (webapp-handler.mjs) — in-memory, reset on restart, never shared between handlers.
- **Stale lock recovery (H4):** `withFileLock` writes `{ pid, host, createdAt }` into `data/presigned.json.lock`. A `SIGKILL`/OOM/`docker restart` in the middle of a mutation skips the `finally` unlink, so the lock survives and every writer fails with code `LOCK_STALE` (holder, lock age and the recovery command in the message; the webapp maps it to HTTP 503). The lock is **never** stolen automatically. Manual recovery: read the lock file to confirm no live process holds it, then `rm data/presigned.json.lock` and restart the service.
- **Shared nonce (M9):** every market's bundle uses the same lender nonce. A receipt that consumes nonce N expires all same-nonce siblings, and a terminal record keeps nonce N consumed forever — so a bundle can silently become `expired` because a *different* market withdrew first. The UI must keep instructing users to fetch a new nonce and re-sign; do not treat this as an error state.
- **Superseded claims (audit R1):** when a different tx consumed the claim's nonce, the monitor releases the claim as `superseded` (see above) and the ladder moves on by itself — the nonce is still consumed, so the rung for it will never broadcast and the user must fetch a fresh nonce. `PROTECTED_STATUSES` in `presigned-store.mjs` stays `["broadcasting"]`, i.e. a `superseded` record is user-deletable, while a live claim still fails closed with `ACTIVE_CLAIM_CONFLICT` (409).
- **Per-rung tier delete (audit R2):** merging keeps older tiers on purpose (incremental signing), so editing an amount without deleting the old tier still leaves a *larger* stale tier that `selectBestWithdrawal` would pick (largest ≤ liquidity). The UI therefore offers a per-tier ✕ on every non-broadcasting rung, and `DELETE /api/presign?market=…&nonce=…&tier=…` requires the nonce when a market has more than one rung (400 otherwise) — deleting "the lowest rung" silently was the F3 defect.
- **Terminal records are user-deletable (M1):** `origin: "user"` may delete/replace `submitted`/`failed` bundles (history has no automatic retention policy). Only a `broadcasting` claim is untouchable — the lifecycle guard still fails closed with `ACTIVE_CLAIM_CONFLICT` (HTTP 409).
- **Markets config is mandatory (M4):** a missing `config/markets.json` now fails fast with copy/mount instructions from `preflightMarketsFile()` (called by every entry point through `loadMarkets`). Legacy keys `MARKET_ID`, `MIN_LIQUIDITY_THRESHOLD_USDC`, `SUDDEN_DRAIN_MULTIPLIER` are ignored.
- The `DELETE /api/presign` handler and `broadcastPresigned`/`expireStaleBundle` in monitor.mjs coordinate via `withFileLock` on `presigned.json.lock` (same lock as webapp POST).
- Proxy binds `PROXY_HOST` (default `127.0.0.1`). Docker publishes `8545:8545` for MetaMask mobile. Capture gated by lender sender + Morpho withdraw decode; `/bundle` and `/captured` require lender Bearer or Basic auth. Binding a public `PROXY_HOST` with an empty `WEBAPP_PASSWORD` now **fails fast before the port opens** (audit R3): in dev mode `checkInternalSecret()` returns `true` for everyone, so `GET /captured` (txHash list) and `DELETE /captured` would be open to anyone reaching 8545. Deliberate override: `WEBAPP_ALLOW_INSECURE=1` (warns and continues). **A password does not close the relay** (audit D3): `WEBAPP_PASSWORD` gates `/bundle` + `/captured` only — wallets cannot send an `Authorization` header, so the JSON-RPC branch is unauthenticated by construction. Public bind with a password now warns at startup with that scope; limit exposure with a firewall / IP allow-list rather than relying on the password.
- `presign-verify.mjs` verifies Morpho `withdraw` calldata on save (proxy + webapp) and before broadcast (monitor).
- Test files import `describe, it, expect` from vitest globally (configured via `vitest.config.mjs` `globals: true`), plus explicit imports. The explicit imports are redundant but harmless.
- Run `npm run lint` before considering a change done: `oxlint --deny no-undef` is the gate that catches the C1-class bug (an identifier removed in one place but still called in another), which `node --check` cannot see. `npm run check` runs lint + `node --check` for every `.mjs` + the full suite. It also checks `webapp.html`: since audit A.1/A.1b/P2.7 there is **no inline module JS left** in that file (only `<script type="importmap">` plus `<script type="module" src="/webapp-app.mjs">`), so the SPA's code is now linted and `node --check`ed like any other `.mjs`, and the old "the SPA can only be verified by opening it in a browser" debt is closed (`node --check` reports it as the `webapp.html no-inline-module` target). `scripts/check-syntax.mjs` still validates the importmap JSON, fails if an inline module ever comes back, and pins that every browser module imported by `webapp-app.mjs` exists and is wired into the server's route map.
- `webapp.html` uses a simplified `fallbackTransport()` without circuit breaker. If every configured URL is slow, the browser may hang for `15s × số URL` (default fallback list: 4 URLs → 60s).
- `verify-presigned.mjs` duplicates the Morpho `withdraw()` ABI definition. The same ABI is also in `webapp.html`. Updates to the ABI must be applied in both places.
- `webapp-server.mjs` sets security headers: `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`. Requests for sensitive file extensions (`.json`, `.env`, `.log`, `.tar`) return 403 Forbidden.
- `proxy-rpc.mjs` CORS mirrors the request `Origin` header. Any origin can make credentialed requests — acceptable since the proxy only listens on localhost, but worth noting if exposed.
- `ntfy.test.mjs` contains 7 live integration tests (`describe.skipIf(process.env.NTFY_LIVE !== "1")`) that make real HTTP requests to ntfy.sh. These are the 7 tests shown as skipped in every `npm test` run; set `NTFY_LIVE=1` to run them. They use `NTFY_SERVER` (defaults to `https://ntfy.sh`) and may fail in offline environments.
- `docker-entrypoint.sh` uses `wait -n` to detect when any child process exits, then checks each PID via `kill -0` and restarts any dead service. This provides self-healing without a full process manager.
- `monitor.mjs` WSS watcher uses 5 separate `watchContractEvent` calls (one per event) instead of `watchEvent` with `events[]`. Reason: `watchEvent` in viem 2.53 has a bug where `flatMap` over multiple events + `args` flattens topic encodings incorrectly — `args.id` values end up mixed with event signatures in `topics[0]` instead of being placed in `topics[1]` as a proper indexed filter. Using `watchContractEvent` with a SINGLE STRING `eventName` per call avoids this bug and correctly filters at the RPC level.
- `createPublicClient` with `webSocket()` transport is synchronous and doesn't throw on connection failure. To detect failures and enable sequential failover, `_tryConnectWss()` calls `client.getChainId()` after creating the client. Without this test call, the first URL would silently fail and subsequent URLs would never be tried.
- WSS endpoints must support `eth_subscribe` with `logs` subscription type. If an endpoint doesn't support it, `onError` fires with "method not found" and the watcher fails over to the next URL.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **morpho-monitor** (588 symbols, 1383 relationships, 37 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/morpho-monitor/context` | Codebase overview, check index freshness |
| `gitnexus://repo/morpho-monitor/clusters` | All functional areas |
| `gitnexus://repo/morpho-monitor/processes` | All execution flows |
| `gitnexus://repo/morpho-monitor/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
