# Multi-market audit findings — 2026-09-23 (P0/P1/P2)

Repo: `morpho-monitor` · Branch: `feat/multi-market-monitor` · HEAD: `24111bc`
Phạm vi: khắc phục toàn bộ phát hiện P0/P1/P2 của đợt audit 2026-09-23 trên worktree
(chưa commit — mọi thay đổi vẫn ở dạng uncommitted, không có `git add`/commit/push).

Trạng thái tổng: **P0 3/3 đã sửa · P1 5/5 đã sửa · P2 11/11 xử lý (10 sửa, 1 ghi nhận debt)**.

---

## 1. Pre-edit impact analysis (gitnexus, bắt buộc theo AGENTS.md)

Index đã được refresh trước khi sửa (`node .gitnexus/run.cjs analyze --index-only --skip-agents-md --skip-skills .`
→ *647 nodes | 1,517 edges | 23 clusters | 46 flows*), vì index cũ không có
`createRequestHandler`, `presigned-store.*` (index stale).

| Symbol (file) | Callers / processes | Risk | Mitigation |
| --- | --- | --- | --- |
| `withFileLock` (shared.mjs) | `updateRegistry` (d=1) → monitor `main`, `broadcastEligible`, webapp `server`; 4 processes | **HIGH** | Chỉ thêm metadata + error code khi hết retry; giữ nguyên retry loop, `finally` unlink, fail-closed (không steal lock). Test `__tests__/file-lock.test.mjs`. |
| `updateRegistry` (presigned-store.mjs) | 3 direct (webapp-handler), monitor `main`/`broadcastEligible`; 5 processes; `epistemic: lower-bound` (1 callable-value reference — `updateRegistry` truyền như callback trong `monitor.mjs`) | **CRITICAL** | Chỉ đổi tập `PROTECTED_STATUSES` (bỏ `submitted`); broadcasting vẫn bị khoá tuyệt đối. Callers dạng callback đã xác nhận bằng đọc source `monitor.mjs:41-48`. Test: lifecycle + presigned-api + two-process-race. |
| `closeActive` / `attemptUrl` (monitor-triggers.mjs) | 5 processes: `reconnect`, `start`, `handleConnectionError`, `scheduleRetry` | **CRITICAL** | Giữ nguyên cấu trúc single-active-endpoint + generation fence; chỉ đổi đường close sang API viem thật và fence `onLogs`. Test `wss-watcher`, `wss-connect`. |
| `handleRpc` (proxy-rpc.mjs) | 1 caller (HTTP handler closure); process `server` | LOW | Tách module, giữ nguyên toàn bộ method/mock/shape lỗi. |
| `broadcastEligible` / `isReserved` / `reconcileBroadcasting` (presigned-broadcast.mjs) | 3-4 (monitor + worker test) | LOW | Đổi semantics theo A2 + test hồi quy. |
| `createWssWatcher`, `createCheckScheduler` (monitor-triggers.mjs) | 2-3 (monitor `main`) | LOW | Thêm fence + catch. |
| `createRequestHandler`, `statusForError`, `registrySummary` (webapp-handler/presigned-store) | 1-2 | LOW | Route chính xác + state per-handler + 503 mapping. |
| `loadMarkets` (market-config.mjs) | 4 direct (monitor/webapp/proxy/index) | LOW | Thêm preflight, không đổi shape trả về. |

Không có caller nào bị bỏ sót: mọi symbol đã sửa đều có test chạy trực tiếp production code.

---

## 2. P0 — chặn chức năng

| # | Phát hiện | Trạng thái | Bằng chứng |
| --- | --- | --- | --- |
| C1 | `proxy-rpc.mjs:96` gọi `configuredMarketIds` đã bị xoá ⇒ mọi `eth_sendRawTransaction` ném `ReferenceError`, JSON-RPC `-32603`, không capture được tx | ✅ Đã sửa | `proxy-dispatcher.mjs` (module import được) + `__tests__/proxy-capture.test.mjs` (9 test) |
| C2 | Một bundle terminal `submitted` khiến broadcaster kẹt vĩnh viễn (`stuck: true`, không claim bundle mới; webapp 409) | ✅ Đã sửa | Y nguyên script repro của audit: trước `rawSends = 0 \| stuck = true`, sau `rawSends = 1 \| stuck = false` |
| C3 | `PROXY_RPC_URL` không bao giờ được inject vào browser (đọc thô `process.env` trong khi `shared.mjs` mới derive) | ✅ Đã sửa | `webapp-config.mjs` + `__tests__/webapp-config.test.mjs` (13 test), fail-fast có message |

### C1 — bằng chứng

Nguyên nhân nằm đúng trong diff worktree (chỉ 9 dòng ở `proxy-rpc.mjs`):

```diff
-const configuredMarketIds = new Set(configuredMarkets.map((market) => market.id));
 function assertConfiguredMarket(marketId) {
-  if (typeof marketId !== "string" || !configuredMarketIds.has(marketId.toLowerCase())) {
+  return requireConfiguredMarket(configuredMarkets, marketId);
 }
```
…nhưng dòng `if (!configuredMarketIds.has(capturedMarketId))` trong `eth_sendRawTransaction`
vẫn còn ⇒ `ReferenceError` bên trong request handler, MemoMask nhận `-32603`.
Không test nào import `proxy-rpc.mjs` (top-level `await` + `listen`) nên `npm test` vẫn xanh.

Sau khi sửa:

* dispatcher tách sang `proxy-dispatcher.mjs` (`createRpcDispatcher`, `createProxyRequestHandler`,
  `MAX_CAPTURED_TXS`), `proxy-rpc.mjs` chỉ còn bootstrap + `listen`;
* capture đi qua `requireConfiguredMarket` (code `MARKET_NOT_CONFIGURED`), market lạ bị từ chối rõ ràng;
* `__tests__/proxy-capture.test.mjs` phủ: (a) market chưa cấu hình → reject + buffer rỗng;
  (b) withdraw hợp lệ của lender → `keccak256(signedTx)` + vào buffer; (b2) tx sai `to` bị từ chối;
  (c) toàn bộ method mock chạy sạch (**đúng đường từng ném ReferenceError**);
  (c4) JSON-RPC qua HTTP thật; (d) cap 50 + `GET/DELETE /captured`.

```text
✓ __tests__/proxy-capture.test.mjs (9 tests) 181ms
```

### C2 — bằng chứng (repro của audit, chạy lại sau khi sửa)

```text
$ node -e "<script repro C2 trong audit plan>"        # registry: 1 submitted(nonce 7, đã xoá rawTx) + 1 pending(nonce 8)
rawSends = 1 | stuck = false | diag = undefined
registry statuses = {"0xaaaa":"submitted","0xbbbb":"submitted"}
```

Trước khi sửa (theo audit): `rawSends = 0 | stuck = true | diag = broadcasting bundle lacks rawTx/txHash identity…`.

Cơ chế sửa (`presigned-broadcast.mjs`):

* `isReserved` → `isActiveClaim(bundle) = status === "broadcasting"`; `submitted`/`failed` **trơ**
  (không reservation, không conflict, không reconcile, không warning);
* nonce của terminal **vẫn tiêu thụ vĩnh viễn**: phase 1 expire mọi `pending` có
  `nonce < current || nonce <= max(nonce của terminal)` ⇒ không bao giờ broadcast lại nonce đã dùng;
* reconcile theo `broadcastingAt` **cũ nhất** (bỏ sort theo id) và bỏ 2 param chết
  (`client`, `now`) của `reconcileBroadcasting`;
* phase 2 ghi thêm `terminalAt` (giữ `minedAt` cho reader cũ);
* diagnostic phân biệt *legacy broadcasting thiếu identity* (fail-closed, cần người xử lý)
  vs *terminal history* (`terminalSummary: { count, consumedNonce }`).

### C3 — bằng chứng

`webapp-server.mjs` giờ đọc `LENDER_ADDRESS` / `PROXY_RPC_URL` / `RPC_URLS` **từ `shared.mjs`**
(qua `webapp-config.mjs`) và fail-fast nếu thiếu lender hoặc không derive được proxy URL:

```text
❌ Thiếu LENDER_ADDRESS trong .env — webapp cần địa chỉ ví lender để xác thực và hiển thị vị thế.
   → Đặt LENDER_ADDRESS=0x... (ví lender) trong .env rồi khởi động lại webapp.
```

Trước đây `JSON.stringify({ proxyRpcUrl: undefined })` bỏ hẳn key ⇒ `webapp.html` rơi về
`http://127.0.0.1:8545`, trên VPS/HTTPS là **máy của user**, không phải server.

---

## 3. P1 — cao

| # | Phát hiện | Trạng thái | Bằng chứng |
| --- | --- | --- | --- |
| H1 | `client.transport?.close?.()` là no-op (viem 2.53 không có `.close` trên transport) ⇒ leak socket + keepAlive/reconnect timer mỗi lần failover; `onLogs` không fence theo generation | ✅ Đã sửa | `wss-connect.mjs` (`closeTransport` dùng `getRpcClient()/getSocket()`), fence trong `monitor-triggers.mjs`; `__tests__/wss-connect.test.mjs` (7) + `__tests__/wss-watcher.test.mjs` (10, fake đúng shape viem) |
| H2 | `verify-presigned.mjs` không migrate registry v2 ⇒ "📄 Bundle rỗng" rồi exit 0 | ✅ Đã sửa | CLI đọc registry v2, `--market`, exit 1 khi mismatch; `__tests__/verify-presigned-cli.test.mjs` (8) |
| H3 | Không có gate tĩnh bắt `no-undef` | ✅ Đã sửa | `oxlint` + `.oxlintrc.json` + `npm run lint`; probe chứng minh gate bắt đúng lỗi C1 (dưới) |
| H4 | `presigned.json.lock` kẹt vĩnh viễn, không chẩn đoán/khôi phục | ✅ Đã sửa (hướng thận trọng) | `withFileLock` ghi `{pid,host,createdAt}` + `LOCK_STALE` (holder, age, lệnh `rm`); map 503 ở webapp; `__tests__/file-lock.test.mjs` (6) |
| H5 | `Sign All` không preflight ví có trỏ vào proxy RPC ⇒ broadcast thật lên mainnet | ⚠️ Đã sửa rồi **gỡ theo quyết định user (2026-09-24)** | Gate `assertProxyNetwork()` + probe `morpho_proxyInfo` đã bị gỡ khỏi `webapp.html` vì không khả thi với smart-contract wallet (H6); an toàn khi ký nay dựa hoàn toàn vào check server-side (đúng lender/market/bundle); probe `morpho_proxyInfo` vẫn còn trên dispatcher để debug thủ công |
| H6 | Ví chặn method tùy chỉnh ở client (Ambire, một số build MetaMask/Rabby): `method [morpho_proxyInfo] doesn't has corresponding handler` ⇒ user tưởng proxy sai dù RPC chưa hề được gọi | ⚠️ Không thể sửa client-side — đã gỡ gate (2026-09-24) | Bằng chứng thực tế: Ambire v6.21.4 tự trả lời `web3_clientVersion` ("Ambire v6.21.4") ⇒ không có probe client-side nào xác thực được RPC qua ví; flow ký khôi phục như main, Ambire có case riêng trong banner; nút Thêm Mạng Proxy vẫn giữ hướng dẫn thủ công khi bị chặn |

### H1 — chi tiết

viem 2.53: `webSocket()` → `createTransport(..., { getSocket, getRpcClient, subscribe })`,
`getRpcClient(): Promise<SocketRpcClient>` (đối tượng này mới có `.close()` — huỷ
`keepAlive` interval 30s, reconnect timer 2s, đóng socket và xoá cache entry).

```js
// CŨ — no-op thật sự (test khẳng định `client.transport.close === undefined`)
try { client.transport?.close?.(); } catch {}
// MỚI — wss-connect.mjs closeTransport(client)
const rpcClient = value.getRpcClient();
if (rpcClient?.close) { rpcClient.close(); return true; }          // viem cũ (sync)
if (rpcClient?.then) { rpcClient.then((r) => r?.close?.()).catch(...); return true; } // viem 2.53
```

`monitor-triggers.mjs` fence log callback theo generation:
`const isCurrentGeneration = () => !stopped && generationAtStart === generation;`
⇒ log từ endpoint cũ (hoặc sau `close()`) không còn kích scheduler.

Resource smoke (chạy local, loopback, không ra Internet): **không kết luận được**.
Hai biến thể (close cũ no-op vs `closeTransport`) đều trả socket/resources về baseline trong ~2s
vì kịch bản loopback bị từ chối kết nối không để lại socket client trong cache
(`process.getActiveResourcesInfo()`: `during` 10 → `after` 2; `socketClientCache.size` = 0 ở cả hai).
Bản smoke dựng WS server tối giản để so sánh cache đã **bị treo và được huỷ** (không dùng làm bằng chứng).
Bằng chứng chính thức cho H1 là unit test với **đúng shape viem**:
`{ value: { getRpcClient: () => Promise.resolve({ close }) } }` cho cả 4 nhánh
(probe fail, partial-subscription fail, rotation, `close()`), cộng assertion `transport.close === undefined`.

### H3 — gate tĩnh bắt đúng lớp lỗi C1

Probe tạm (`scripts/no-undef-probe.mjs`, đã xoá sau khi chạy) tham chiếu một biến không tồn tại:

```text
$ npm run lint
  x eslint(no-undef): 'removedSet' is not defined.
   ,-[scripts/no-undef-probe.mjs:6:10]
Found 12 warnings and 1 error.        # exit code 1
```

`oxlint` là devDependency (registry npm truy cập được: `npm view oxlint version` → 1.85.0),
không có scanner tự chế. Cấu hình `.oxlintrc.json` khai báo Node/browser/test globals;
`npm run lint` = `oxlint --deny no-undef *.mjs __tests__ scripts`.

### H4 — quy trình khôi phục (không tự phá lock)

```bash
# 1. Xác nhận không còn process nào giữ lock (log của lock cho biết pid/host/createdAt)
cat data/presigned.json.lock
# 2. Chỉ khi chắc chắn (process đã bị SIGKILL/OOM/docker restart giữa mutation):
rm data/presigned.json.lock
# 3. Restart service; webapp trả 503 kèm thông báo hành động được trong lúc lock còn kẹt
```

---

## 4. P2 — trung bình / hygiene

| # | Phát hiện | Trạng thái | Ghi chú |
| --- | --- | --- | --- |
| M1 | Record terminal không có retention, user không xoá được | ✅ Đã sửa | `PROTECTED_STATUSES` chỉ còn `broadcasting`; user xoá `submitted`/`failed`; `registrySummary` expose `terminalAt` |
| M2 | `webapp.html` hardcode 11 RPC URL kèm key Infura/Ankr và được phục vụ công khai | ✅ Đã sửa | Xoá toàn bộ URL kèm key; browser dùng `CFG.rpcUrls` (fallback keyless); test khẳng định không còn `infura.io/v3`, `ankr.com/eth/0x`, `alchemy.com/v2/`, `lb.drpc.live/ethereum/`, `core.chainstack.com/`, `onfinality.io/rpc?apikey=` |
| M3 | `CLAUDE.md` drift (hàm không tồn tại, claim RPC URL, bullet trùng, challenges Map sai file, nonce check sai, diagram thiếu module) + comment cụt `shared.mjs:50-53` | ✅ Đã sửa | CLAUDE.md cập nhật theo code hiện tại; comment `shared.mjs` viết lại |
| M4 | Không có `config/markets.json` ⇒ local chết ngay / Docker crash-loop; `.env` còn key v1 | ✅ Đã sửa (message + docs) | `preflightMarketsFile()` gọi từ monitor/webapp/proxy/index (qua `loadMarkets`) với hướng dẫn copy/mount; `.env.example` ghi rõ `MARKET_ID`/`MIN_LIQUIDITY_THRESHOLD_USDC`/`SUDDEN_DRAIN_MULTIPLIER` không còn được đọc. **Không** tự tạo `config/markets.json` (file gitignored, thuộc quyền quyết định của deployment) và không sửa `.env` |
| M5 | `checkMarkets` + scheduler `run` không có `catch` ⇒ unhandled rejection mỗi 30s khi RPC outage | ✅ Đã sửa | `try/catch` + log theo chu kỳ, giữ trailing-run; test "check throw không giết loop" |
| M6 | `docker-entrypoint.sh`: `set -e` + `wait -n` có thể thoát trước khi gán `EXIT_CODE` | ✅ Đã sửa | `EXIT_CODE=0; wait -n … \|\| EXIT_CODE=$?` (+ comment lý do) |
| M7 | Test copy logic production (webapp/ntfy), code chết trong test | ✅ Đã sửa (một phần, có debt) | Xoá block chết `two-process-race.test.mjs:76-81` (giờ dùng `keccak256(TX_A)`), xoá ternary no-op `presigned-lifecycle.test.mjs:63`; debt duplicated-logic của `webapp.test.mjs`/`ntfy.test.mjs`/predicate webapp ghi vào CLAUDE.md (không thêm bundler) |
| M8 | `package.json`: `main: index.js` sai, description rỗng, thiếu engines/script lint | ✅ Đã sửa | `main: index.mjs`, description, `engines.node >= 20`, scripts `lint`/`check`/`verify`/`test` |
| M9 | Nonce dùng chung giữa các market ⇒ sibling bị `expired` âm thầm, UI không gợi ý ký lại | ✅ Đã sửa (UI + docs) | `fetchExistingBundle` hiện banner "expired → lấy nonce mới và ký lại" và banner cho record terminal; ràng buộc nonce dùng chung ghi vào CLAUDE.md. **Không** đổi kiến trúc nonce |
| M10 | `webapp-handler.mjs`: state module-level, route `startsWith`, path lạ trả HTML 200 | ✅ Đã sửa | `challenges`/`challengeRateLimit` vào closure `createRequestHandler`, interval do `webapp-server.mjs` tạo (`startCleanupTimer`); route khớp chính xác pathname; `/api/*` lạ → JSON 404; test `presigned-api.test.mjs` |
| M11 | `reconcileBroadcasting(id, bundle, client, now)` bỏ phí param; nhiều reservation reconcile theo id | ✅ Đã sửa | Bỏ param chết; sort theo `broadcastingAt` cũ nhất (test "M11" trong `presigned-lifecycle.test.mjs`) |

### Bất biến được giữ nguyên (không nới)

1. **Claim nonce lender-wide, fail-closed**: tối đa 1 claim/nonce; 2 `broadcasting` cùng nonce → `conflict: true`,
   không gửi gì; timeout/lỗi RPC mơ hồ/pending-nonce advance **không** unlock.
   Test: `presigned-lifecycle` ("fails closed when two active same-nonce claims exist", "keeps broadcasting on send timeout…").
2. **Chỉ receipt mined có block identity mới cho terminal + expire sibling**: `isMinedReceipt` giữ nguyên;
   phase 2 expire sibling cùng nonce. Test: "finalizes only a mined receipt and expires sibling nonce claims".
3. **Identity tuyệt đối**: `keccak256(rawTx) === txHash` trước mọi rebroadcast; legacy thiếu identity vẫn
   `stuck: true` + manual reconciliation. Test: "fails closed on a legacy broadcasting record…",
   "fails closed when persisted rawTx does not match txHash", "recovery rebroadcasts the exact persisted bytes".
4. **Market isolation + cross-process lock**: `requireConfiguredMarket` ở capture/bundle/presign; `withFileLock`
   vẫn là cổng duy nhất cho mọi mutation (không hạ cấp, không steal).
5. **Quota thông báo**: chỉ `ntfyDelivered` mới tiêu quota; VoIP không tiêu quota (không đổi).

---

## 5. Cổng kiểm chứng (output thật)

```text
$ npm test
 Test Files  21 passed (21)
      Tests  339 passed (339)          # baseline: 16 files / 280 tests

$ npm run check                        # lint + node --check + vitest run
Found 12 warnings and 0 errors.        # 12 warning là no-unused-vars có sẵn trong test cũ
✅ node --check: 42/42 file OK
 Test Files  21 passed (21)

$ node scripts/check-syntax.mjs
✅ node --check: 42/42 file OK

$ npx vitest run __tests__/proxy-capture.test.mjs __tests__/presigned-lifecycle.test.mjs \
    __tests__/presign-broadcast.test.mjs __tests__/expire-bundle.test.mjs \
    __tests__/presigned-api.test.mjs __tests__/wss-watcher.test.mjs \
    __tests__/two-process-race.test.mjs __tests__/wss-connect.test.mjs __tests__/file-lock.test.mjs
 Test Files  9 passed (9)
      Tests  79 passed (79)

$ docker compose config --quiet
compose config OK

$ node .gitnexus/run.cjs detect-changes --scope all --repo .
Changes: 19 files, 76 symbols
Affected processes: 26
Risk level: critical                  # xem ghi chú bên dưới
```

`detect_changes` (MCP, cuối cùng) trả `changed_count: 76`, `changed_files: 19`, `affected_count: 26`,
**không** có `partial`/`truncated` ⇒ lần chạy hoàn chỉnh (zero ở đây là đã thấy, không phải chưa thấy).
Con số tăng so với các lần chạy trước trong đợt này (18 file / 67 symbol) vì báo cáo audit và
`docs/plans/2026-09-22-multi-market-monitor.md` cũng nằm trong diff. `risk_level: critical` phản ánh
**cả worktree dirty** (gồm thay đổi của user từ trước và tài liệu), không phải ước lượng riêng cho diff này;
các process bị ảnh hưởng đúng như dự kiến trước khi sửa (`BroadcastEligible → IsReserved/ReconcileBroadcasting`,
`UpdateRegistry → EmptyRegistry`, `HandleRpc → ComputeMarketId`, `Server → MarketError`,
`Main → CreateWssWatcher/ComputeDrainThreshold`).

**Không commit** — mọi thay đổi vẫn uncommitted theo yêu cầu.

---

## 6. Ghi chú triển khai (deviation so với plan)

1. **A3** — `buildWebappConfig()` / `injectWebappConfig()` được đặt trong module mới `webapp-config.mjs`
   và `webapp-server.mjs` import chúng, thay vì export từ chính `webapp-server.mjs`: import
   `webapp-server.mjs` sẽ boot server (`loadMarkets` + `listen`), còn test cần import thuần.
2. **B1** — factory `connect()` được tách sang `wss-connect.mjs` (kèm `closeTransport`) thay vì giữ
   inline trong `monitor.mjs`, cùng lý do: `monitor.mjs` không import được (top-level side effects).
   `monitor.mjs` chỉ còn `connect: createWssConnect({ address: MORPHO_BLUE_ADDRESS })`.
3. **C1** — preflight được gọi từ `loadMarkets()` (mọi entry point đều đi qua) **và** export riêng
   `preflightMarketsFile()` để dùng tường minh; `loadMarkets("")` vẫn giữ nguyên lỗi
   `MARKETS_FILE is required` cho tương thích test cũ.
4. **C1/H3** — gate tĩnh là `oxlint` + `.oxlintrc.json` (Node/browser/test globals) và
   `scripts/check-syntax.mjs` cho `node --check` cross-platform (npm scripts chạy bằng cmd.exe trên
   Windows nên không dùng vòng lặp POSIX được).
5. **A2** — giữ cả `terminalAt` (mới, cho retention/display) và `minedAt` (reader cũ) ở cùng một
   mốc thời gian.
6. **H1 smoke** — bản smoke dựng WS server tối giản bị treo (keepAlive của viem giữ event loop) và
   đã được huỷ; không dùng làm bằng chứng, đã ghi rõ ở mục H1.

## 7. Còn lại / gap đã biết

* `config/markets.json` vẫn chưa tồn tại trong worktree (gitignored). Deployment phải
  `cp config/markets.example.json config/markets.json` hoặc mount; nay lỗi có hướng dẫn thay vì ENOENT.
* `.env` (read-only theo yêu cầu) vẫn chứa key v1 (`MARKET_ID`, `MIN_LIQUIDITY_THRESHOLD_USDC`,
  `SUDDEN_DRAIN_MULTIPLIER`) — không còn được đọc; xoá là việc của user.
* Smoke resource runtime cho H1 không kết luận được trong môi trường local (loopback không tạo
  socket client bền); bằng chứng thay thế là unit test đúng shape viem. Muốn chứng minh end-to-end
  cần một WSS endpoint thật + rotation thật (deployment-owned).
* Retention policy cho record terminal mới chỉ có "user xoá được" + `terminalAt`; chưa có TTL tự động
  (audit yêu cầu không tự xoá lịch sử khi chưa có policy rõ ràng).
* Duplicated pure functions trong `webapp.test.mjs` / `ntfy.test.mjs` / predicate trong
  `webapp-config.test.mjs` vẫn là debt (webapp.html không import được bằng vitest, không thêm bundler).
* `oxlint` báo 12 warning `no-unused-vars` có sẵn trong test cũ — chưa dọn (không thuộc phạm vi audit).
* `npm install` cho oxlint báo 8 advisory trên cây devDependencies hiện có (2 moderate, 6 high) —
  không chạy `npm audit fix` để tránh thay đổi ngoài phạm vi.
