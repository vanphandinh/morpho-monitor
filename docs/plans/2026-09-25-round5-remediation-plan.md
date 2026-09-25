# Kế hoạch fix các lỗi audit còn mở — 2026-09-25 (nhánh `feat/multi-market-monitor`)

> **Trạng thái: P1–P6 ĐÃ LÀM, kể cả P5 (O5) và một finding mới D10 (cổng lint không quét `.mjs` gốc).** HEAD khi lập plan: `12f12c2`.
> **Cập nhật vòng 6:** bảng dưới đây từng ghi O1–O4 là "Mở" dù chúng đã được fix — đó là lỗi tài liệu
> của chính vòng 5, nay đã sửa thành "Đã đóng" kèm commit. Vòng 6 (`docs/plans/2026-09-25-round6-plan-and-findings.md`)
> lấp nốt nợ *bằng chứng* mà plan này chỉ dừng ở mức tĩnh: đường tiền nay được chạy THẬT và so từng byte.
> Mọi con số/`file:line` dưới đây đã **chạy trên cây hiện tại**, không suy luận từ docstring hay
> tên test. Bằng chứng thực thi + các chỗ plan nói sai so với thực tế: xem §8.
>
> Nguồn: `docs/plans/2026-09-25-audit-round5-findings.md` (vòng 5), `…/2026-09-24-audit-round2-findings.md`
> (D3/P5 còn mở), `CLAUDE.md` (mục Conventions — nợ test mirror).

## 0. Trạng thái từng finding

| # | Finding | Trạng thái | Bằng chứng |
| --- | --- | --- | --- |
| D7 | Đồ thị module browser không có test khép kín | **Đã đóng** `12f12c2` | Test mới trong `__tests__/webapp.test.mjs`; đỏ-trước: đổi khoá route map ⇒ `1 failed \| 31 passed (32)` |
| D8 | Fail-fast chỉ báo market id sai đầu tiên | **Đã đóng** `12f12c2` | `market-reader.mjs` gom `unknownIds` + `.marketIds`; đỏ-trước: `1 failed \| 7 passed (8)` |
| D9 | Hai vết định dạng do P2.8 để lại | **Đã đóng** `12f12c2` | `webapp-app.mjs:818` + dòng trống trong `fetchNonce` |
| **O1** | Không có cách chứng minh trong repo rằng `webapp-app.mjs` **evaluate được** (chỉ có HTTP 200 + test tĩnh) | **Đã đóng** `f1360bb` | `webapp-app.mjs:48` đọc `window.MORPHO_CONFIG` ngay top-level; 186 dòng chạm `document.`/`window.` |
| **O2** | Relay JSON-RPC của proxy **không xác thực** khi bind public (D3 vòng 2, đã chọn phương án (a) tài liệu hoá) | **Đã đóng** `88c5f65` — rate-limit + allow-list có sẵn nhưng **mặc định tắt** (chờ owner chốt) | `proxy-dispatcher.mjs:66` `handleRpc` switch; `:331` `Unhandled method → null`; tiền lệ rate-limit `webapp-handler.mjs:115-140` |
| **O3** | Bootstrap monitor không phân biệt "config sai" (fatal) với "RPC lỗi tạm thời" (restart loop) | **Đã đóng** `5e80a7e` (+ `05b8342` vá `monitor.mjs` bị bỏ sót) | `monitor.mjs:176` `await createMarketReader(...)` → `.catch` → `process.exit(1)` |
| **O4** | `ntfy.test.mjs` là bản sao payload **duy nhất còn lại** (nợ đã ghi trong `CLAUDE.md`) | **Đã đóng** `5e9a007` | `__tests__/ntfy.test.mjs:20` định nghĩa `buildNtfyPayload` trong khi payload thật nằm inline ở `monitor.mjs:169` |
| **O5** | `webapp-app.mjs` vẫn là file lớn nhất (1.848 dòng) | **Đã đóng** (P5, `73433b7`) | `wc -l` sau P5: `webapp-app.mjs` **393** dòng; 7 module browser, module lớn nhất `webapp-presign.mjs` **573**. File lớn nhất repo vẫn là `proxy-dispatcher.mjs` — **710** dòng, không phải `633`: con số ở cột phải đo tại `12f12c2`, còn file đó lớn lên ở P2 |
| **O6** | Nợ "webapp.html không được lint" | **Đã moot — không cần làm** | `webapp.html` chỉ còn `<script type="importmap">` + `<script type="module" src="/webapp-app.mjs">`; **0** JS inline. `scripts/check-syntax.mjs` đã ghim bất biến này (`node --check: 68/68 (62 .mjs + webapp.html no-inline-module)`) |

## 1. Hành vi hiện tại [đã kiểm chứng]

- `webapp-app.mjs` là module ES chạy trong browser; **top-level** đã đọc `window.MORPHO_CONFIG`
  (`:48`) nên không thể `import` trong Node nếu không có stub. `oxlint` (no-undef) đã phủ phần
  "gõ sai tên", nhưng **không** phủ: lỗi thứ tự khởi tạo/TDZ, và mismatch giữa `getElementById()`
  với `id` trong HTML.
- Probe id hiện tại: HTML có **64** `id`, app gọi **61** `getElementById` ⇒ **1** chỗ không có trong
  HTML: `tx-verify-note`. Kiểm tay: id này do **chính app chèn** vào banner (`webapp-app.mjs:1753`)
  rồi tra lại có null-guard (`:1761-1762`), và đã được test ghim (`__tests__/webapp.test.mjs:404`)
  ⇒ **không phải lỗi**. Đây là mẫu bắt buộc cho test ở P1: id tự chèn phải được coi là hợp lệ.
- `proxy-dispatcher.mjs:66` `handleRpc(method, params)` forward `eth_call`/`eth_getLogs`/… sang
  `RPC_URLS` của operator; nhánh HTTP JSON-RPC **không** đi qua `requireLenderOrInternal` (bắt buộc
  về kỹ thuật: MetaMask không gửi được header `Authorization`). Rủi ro là **lạm dụng tài nguyên**
  (quota/API key/IP), không phải mất tiền — capture vẫn gate `from === LENDER_ADDRESS`.
- `monitor.mjs:176` gọi `createMarketReader` trong `main()`; lỗi nào cũng rơi vào `.catch` ⇒
  `process.exit(1)`. Hai lớp lỗi rất khác nhau đi cùng một đường: `MARKET_PARAMS_ZERO` (config sai,
  phải chết ngay) và lỗi transport (mạng, nên thử lại có giới hạn).
- `ntfy.test.mjs:20` tự dựng payload; payload production nằm inline trong `monitor.mjs:169`
  (`Title`/`Tags`/`Priority`/`Markdown`/`Click` + 6 dòng body) — test xanh dù production lệch.

## 2. Ảnh hưởng (GitNexus, chạy trên cây hiện tại)

| Symbol | Caller / process | Risk | Ghi chú |
| --- | --- | --- | --- |
| `createMarketReader` (`market-reader.mjs`) | impacted 4 · direct 2 · processes 2 | **LOW** · `epistemic: exact` | P3 sửa **caller** trong `monitor.mjs`, không đổi hợp đồng của reader |
| `createRequestHandler` (`webapp-handler.mjs`) | impacted 1 · direct 1 · processes 0 | **LOW** | P1 chỉ thêm test; không sửa handler |
| `createProxyRequestHandler` (`proxy-dispatcher.mjs`) | impacted 1 · direct 1 · processes 0 | **LOW** | P2 sửa trong dispatcher; một caller là `proxy-rpc.mjs` |
| `detect_changes --scope all` (sau khi sửa vòng 5) | 4 file · 7 symbol · 2 process | **medium** | không `partial`/`truncated` |

Bất biến không được phá trong mọi pha: claim durable trước I/O · chỉ receipt có block identity mới
cho terminal · `keccak256(rawTx) === txHash` trước rebroadcast · tối đa 1 claim/nonce · fail closed ·
capture chỉ nhận tx từ `LENDER_ADDRESS`.

---

## 3. Kế hoạch theo pha

### P1 — Chứng minh `webapp-app.mjs` *evaluate được*, không chỉ *tải được* (O1) — **ưu tiên 1**

**Vấn đề.** Vòng 5 đã đóng lớp "import 404" (D7), nhưng chưa đóng lớp "tải xong rồi chết": sai thứ
tự khởi tạo (gọi hàm đọc `const` khai báo phía dưới), hoặc `getElementById()` trỏ vào id không tồn
tại (⇒ `null.textContent` ⇒ TypeError chỉ lộ khi người dùng bấm đúng nút đó).

**Thay đổi (test-only, không sửa production).**
1. `__tests__/webapp-app-boot.test.mjs` (mới): dựng **DOM stub tối thiểu** (~80 dòng, không thêm
   dependency) gồm `document.getElementById/querySelector/querySelectorAll/addEventListener/
   createElement`, `window` (kèm `localStorage`, `location`, `navigator`, `ethereum = null`),
   `fetch` trả 503. Sau đó `await import("../webapp-app.mjs")` và gọi đường boot một lần.
   Mục tiêu: bắt **TDZ/init-order** và mọi reference top-level, không cần browser.
2. Trong `__tests__/webapp.test.mjs` (hoặc file trên): bất biến id hai chiều —
   `getElementById("x")` ⇒ `x` có `id="x"` trong `webapp.html` **hoặc** app tự chèn (`id="x"` có
   trong chính `webapp-app.mjs`, ví dụ `tx-verify-note`). Chốt chống-regex-hỏng: số id kiểm ≥ 60.
3. Ghi rõ trong `CLAUDE.md`: DOM stub là safety net cho mọi lần tách tiếp `webapp-app.mjs`.

**Đỏ-trước (bắt buộc chứng minh):**
- đổi `id="presign-nonce"` trong HTML thành `id="presign-nonce-x"` ⇒ test id **đỏ**;
- kéo một `const` mà hàm top-level dùng xuống dưới lời gọi ⇒ test boot **đỏ**.

**Tiêu chí nghiệm thu:** 2 test mới đỏ-trước rồi xanh; `npm run check` xanh; không thêm dependency;
không sửa dòng nào của production.

**Rủi ro:** stub quá "dễ tính" ⇒ test xanh vô nghĩa. Giảm thiểu: `getElementById` trả `null` cho id
lạ (đúng như browser), và mỗi lần thêm stub phải kèm 1 ca phá (như 2 ca đỏ-trước ở trên).
**Công:** M.

### P2 — Relay JSON-RPC của proxy: rate-limit theo IP + allow-list opt-in (O2) — **ưu tiên 2**

**Vấn đề.** Ai vào được port proxy cũng dùng được `RPC_URLS` của operator. Vòng 2 đã chọn (a) chỉ
tài liệu hoá; đây là bước (b)+(c).

**Thay đổi (`proxy-dispatcher.mjs`, giữ mặc định cũ khi env không đặt).**
1. `PROXY_RPC_RATE_LIMIT=<req/phút>` (mặc định: **tắt** ⇒ hành vi y hệt hiện nay). Vượt ngưỡng ⇒
   trả **JSON-RPC error `-32005`** (không phải HTTP 429) để ví hiểu là lỗi RPC, không phải mạng chết.
   Dùng đúng cấu trúc Map theo IP + cửa sổ trượt của `webapp-handler.mjs:115-140` (tiền lệ có sẵn).
   Ngưỡng mặc định đề xuất khi bật: **600 req/phút/IP** — MetaMask bắn `eth_call`/`eth_estimateGas`/
   `eth_gasPrice` theo cụm, đặt thấp sẽ tự bóp chính mình.
2. `PROXY_ALLOW_PUBLIC_RPC=1` ⇒ chỉ forward **allow-list** method (chainId, blockNumber, call, code,
   getStorageAt, getTransactionCount, feeHistory, getBlockByNumber, gasPrice, estimateGas,
   sendRawTransaction, debug_traceCall, eth_createAccessList, web3_clientVersion, net_version);
   method khác ⇒ `-32601` kèm log. Đây là lựa chọn **opt-in** cho người bind public, không đổi mặc định.
3. `assertProxyAuthConfig`: khi bind public mà **chưa** bật 2 biến trên, in thêm 1 dòng gợi ý cụ thể.

**Đỏ-trước:** request thứ N+1 từ cùng IP ⇒ `-32005` trong khi IP khác vẫn 200; đặt allow-list ⇒
method ngoài danh sách bị `-32601`, `eth_sendRawTransaction` hợp lệ vẫn được capture.

**Tiêu chí nghiệm thu:** env không đặt ⇒ **không** đổi byte nào trong phản hồi hiện có (test pin
hành vi cũ); test HTTP thật cho cả hai chế độ; tài liệu `.env.example` + `CLAUDE.md`.
**Rủi ro:** chặn nhầm ví thật ⇒ mặc định tắt + ngưỡng rộng + đo lại bằng log trước khi bật.
**Công:** M.

### P3 — Phân loại lỗi khởi động: config = fatal, mạng = retry có giới hạn (O3) — **ưu tiên 3**

**Thay đổi.**
1. Module nhỏ `startup-retry.mjs`: `isRetryableStartupError(err)` (false cho `MARKET_PARAMS_ZERO`,
   `MARKETS_FILE`/parse error; true cho lỗi transport/timeout) + `retryWithBackoff(fn, { attempts,
   delaysMs, isRetryable, sleep, log })`.
2. `monitor.mjs` chỉ bọc **đúng** `createMarketReader(...)` bằng retry (mặc định 4 lần, 2s → 4s → 8s
   → 16s, tổng ~30s); `loadMarkets` và mọi lỗi config vẫn chết ngay với thông báo cũ.
3. Log mỗi lần thử lại có số lần + lý do; hết lượt ⇒ ném lỗi gốc (exit 1 như cũ, không nuốt).

**Đỏ-trước:** fake reader ném lỗi transport 2 lần rồi thành công ⇒ monitor dựng được và `sleep` được
gọi 2 lần; fake ném `MARKET_PARAMS_ZERO` ⇒ ném ngay, `sleep` **không** được gọi (0 lần).
**Tiêu chí nghiệm thu:** 2 test trên; `MARKETS_FILE=./config/__nope.json node monitor.mjs` vẫn chết
ngay với đúng thông báo cũ (không retry); không có retry nào chạm đường broadcast.
**Rủi ro:** retry làm chậm phát hiện config sai ⇒ vì vậy config **không** retry.
**Công:** S.

### P4 — Trả payload ntfy về production, xoá bản sao cuối cùng trong test (O4) — **ưu tiên 4**

**Thay đổi.**
1. `monitor.mjs`: `export function buildNtfyPayload({ loanSymbol, collateralSymbol, marketId,
   lenderAddress, webappUrl, scenario })` → `{ headers, body }`; bootstrap dùng nó thay khối inline
   ở `:169`. `monitor.mjs` import không có side effect (đã đạt ở P1.5) nên test import được — đúng
   tiền lệ P1.6 đã làm cho `voip.mjs`.
2. `__tests__/ntfy.test.mjs`: xoá `buildNtfyPayload` cục bộ (`:20`), import từ production; giữ
   nguyên 7 test live đang bị skip sau `NTFY_LIVE=1`.

**Đỏ-trước:** đổi `Priority: "4"` → `"3"` trong production ⇒ test cũ vẫn xanh, test mới **đỏ**.
**Tiêu chí nghiệm thu:** `grep -c 'function buildNtfyPayload' __tests__/ntfy.test.mjs` = 0;
`CLAUDE.md` mục Conventions không còn dòng "Remaining debt: ntfy.test.mjs…".
**Công:** S.

### P5 — (tuỳ chọn) Tách tiếp `webapp-app.mjs` theo luồng (O5) — **chỉ làm sau P1**

**Đề xuất ranh giới:** `webapp-presign.mjs` (nonce/gas/tier/ký/lưu) · `webapp-withdraw.mjs` (tab rút
+ nối `txVisibleOnChain`) · `webapp-overview.mjs` (market switcher + bảng overview). Giữ bất biến
**một chỗ duy nhất sở hữu `window.*`**: mỗi module export `registerXxxHandlers()`, `webapp-app.mjs`
gọi và là nơi duy nhất gán `window.*` (test hợp đồng `onclick` hiện có sẽ bắt ngay nếu phá).
Route map đã tổng quát ⇒ **test D7 tự động phủ** module mới; `readBrowserModule` trong
`webapp-server.mjs` phải thêm file (fail-fast nếu thiếu).

**Tiêu chí nghiệm thu:** toàn bộ suite hiện có vẫn xanh; không module nào > 700 dòng; D7 + P1 xanh.
**Rủi ro:** di chuyển lớn, dễ trộn state ⇒ làm sau P1 (đã có lưới an toàn) và **từng module một**.
**Công:** L. **Khuyến nghị:** làm, nhưng là pha riêng, không trộn với P2/P3.

### P6 — Vệ sinh & tài liệu

1. `.freebuff/` (AI tooling): thêm vào `.gitignore` cạnh `.claude/` (hoặc để nguyên — **cần owner
   quyết**; tôi đã cố ý không commit nó).
2. Đóng dòng nợ "webapp.html không được lint" trong `CLAUDE.md` kèm bằng chứng O6 (0 JS inline).
3. Sau mỗi pha: cập nhật số test trong `CLAUDE.md` + thêm mục "Đã kiểm tra, không phải lỗi" cho
   `tx-verify-note` (để vòng sau không audit lại).

## 4. Thứ tự thực hiện

`P1` → `P4` → `P3` → `P2` → (`P5`) → `P6`, mỗi pha **một commit** kèm bằng chứng đỏ-trước trong
message. Lý do thứ tự: P1 là lưới an toàn cho mọi pha sau (đặc biệt P5); P4/P3 nhỏ và rủi ro thấp,
làm trước để lấy đà; P2 đụng đường ví nên làm khi đã có P1; P5 là pha cấu trúc lớn, tách riêng.

Trước khi sửa **từng** symbol: chạy `impact` (AGENTS.md). Sau mỗi pha: `detect_changes --scope all`
(không được `partial`/`truncated`) rồi `npm run check`.

## 5. Chiến lược test

| Pha | File test | Loại |
| --- | --- | --- |
| P1 | `__tests__/webapp-app-boot.test.mjs` (mới, DOM stub) + bất biến id trong `webapp.test.mjs` | import production + tĩnh |
| P2 | `__tests__/proxy-capture.test.mjs` hoặc file mới `proxy-rate-limit.test.mjs` — HTTP thật qua `createProxyRequestHandler` | tích hợp |
| P3 | `__tests__/startup-retry.test.mjs` (mới) | unit + đỏ-trước |
| P4 | `__tests__/ntfy.test.mjs` (sửa) | import production; 7 test live vẫn skip sau `NTFY_LIVE=1` |
| P5 | suite hiện có + D7 + id test | hồi quy |
| P6 | — | tài liệu |

Không test nào được: gọi mainnet broadcast, chạm `data/presigned.json` thật, hay dùng `.env` thật.

## 6. Rủi ro & điều KHÔNG làm

- **Không** bật `stickyMs` cho proxy/CLI (giữ blast radius nhỏ — quyết định vòng 3 vẫn đúng).
- **Không** làm P5 "2 chu kỳ đồng thuận trước khi nhả `superseded`" (vòng 2): D6/`stickyMs` đã sửa
  đúng gốc, và rủi ro nhả sớm là *liveness*, không phải *money*.
- **Không** thêm bundler/codegen cho webapp (D7 + P1 giải quyết phần phát hiện lệch mà không cần build).
- Rủi ro lớn nhất của cả kế hoạch là **P2 chặn nhầm ví thật** ⇒ mặc định tắt, ngưỡng rộng, và bật
  bằng cách đo log trước.
- Rủi ro thứ hai là **P1 xanh giả** (stub quá dễ tính) ⇒ mỗi năng lực của stub phải có một ca phá
  chứng minh test đỏ được.

## 7. Cần owner quyết

| # | Câu hỏi | Khuyến nghị |
| --- | --- | --- |
| 1 | P2: chỉ rate-limit, hay rate-limit + allow-list opt-in? | Cả hai, nhưng **mặc định tắt** để không đổi hành vi đang chạy |
| 2 | P5: có tách tiếp `webapp-app.mjs` không (chi phí L, đổi lại dễ review)? | **Đã quyết: LÀM** (owner đồng ý) — xong ở `73433b7`: 7 module, đồ thị DAG, một chủ sở hữu `window.*` |
| 3 | `.freebuff/`: thêm vào `.gitignore` hay commit `project-id`? | Thêm vào `.gitignore` (giống `.claude/`) |

---

## 8. Kết quả thực thi (2026-09-25)

| Pha | Commit | Kết quả | Đỏ-trước đã chứng minh |
| --- | --- | --- | --- |
| P1 (O1) | `f1360bb` | `webapp-app-boot.test.mjs` (3 test, DOM stub dựng TỪ `webapp.html`) + bất biến id phủ **61** lời gọi `getElementById` | Đổi `id="presign-setup"` trong HTML ⇒ test id đỏ và nêu đúng tên id lệch (`1 failed \| 65 passed`) |
| P4 (O4) | `5e9a007` | `buildNtfyPayload` export từ `monitor.mjs`; 12 test payload import production + 1 test chặn bản sao quay lại | Đổi `Priority: "4"` → `"3"` ⇒ test mới đỏ, bản sao cũ vẫn xanh |
| P3 (O3) | `5e80a7e` | `startup-retry.mjs` + 8 test; monitor chỉ bọc đúng `createMarketReader` | `isRetryableStartupError` luôn true ⇒ 2 test đỏ; `MARKETS_FILE` thiếu vẫn exit 1 ngay (`MARKETS_FILE_MISSING`) |
| P2 (O2) | `88c5f65` | rate limit theo IP + `RPC_METHOD_ALLOW_LIST`, cả hai mặc định TẮT; 11 test dùng `req`/`res` giả để điều khiển IP | Mặc định `rpcRateLimit = 60` ⇒ test "mặc định tắt" đỏ; vô hiệu `methodBlocked` ⇒ 2 test allow-list đỏ |
| P6 | `a99518a` | `.freebuff/` vào `.gitignore`; `.env.example` ghi 2 biến mới; `CLAUDE.md` cập nhật số test + đóng nợ | — |
| **P5** (O5) | `73433b7` | `webapp-app.mjs` 1.848 → **393** dòng, tách thành **7 module** (module lớn nhất `webapp-presign.mjs` 573 dòng): `state`/`shell`/`overview`/`presign-bundles`/`presign`/`withdraw`/`app`. Đồ thị là DAG (không chu trình), chỉ `app` gán `window.*`, `state` bị `Object.seal`. Thêm `__tests__/helpers/browser-modules.mjs` (closure import) + 3 bất biến cấu trúc mới | Đồ thị import ban đầu có **2 chu trình** (`auth↔presign`, `auth↔overview` — đo bằng script phân tích phụ thuộc); hạ 2 helper banner xuống `shell` và chuyển `switchTab` lên `app` ⇒ còn **0**. Lint đỏ 18 lỗi `no-undef` khi khối `window.*` tham chiếu handler chưa import (đã sửa); 15 test đỏ vì ghim file (đã chuyển sang closure) |
| **D10** (mới) | (commit này) | `npm run lint` đổi target `*.mjs __tests__ scripts` → `.`: trên Windows/npm shell **không** expand `*.mjs` nên cổng lint chỉ quét `__tests__`+`scripts` (38 file, 39 sau khi P5 thêm helper test) và **bỏ toàn bộ `.mjs` ở gốc** | Đỏ-trước: thêm `const zzProbe = someUndefinedName123;` vào `webapp-shell.mjs` ⇒ lệnh CŨ exit **0** ("Found 0 warnings and 0 errors"), lệnh MỚI exit **1** + nêu đúng `eslint(no-undef): 'someUndefinedName123' is not defined.`; lệnh mới lint 74 file thay vì 39 |

`npm run check` cuối: **35 file / 520 passed \| 7 skipped (527)**, 0 warning (lint thật sự quét 74 file),
`node --check` 79/79.

### Bằng chứng P5 không làm mất code

- **Đối chiếu dòng** (script tạm, không commit): mọi dòng code gốc của `webapp-app.mjs` đều xuất hiện
  trong 7 file mới sau khi chuẩn hoá — chỉ còn 40 dòng khác dạng, **tất cả** thuộc 3 nhóm chủ ý:
  (a) khối `import` gốc viết nhiều dòng → import tính toán một dòng; (b) `window.X = function(...)` →
  `function X(...)` (đổi chủ sở hữu); (c) `let X = …;` → `X: …,` trong object `state`. Không có dòng nào mất.
- **HTTP thật** (server khởi động một lần, `WEBAPP_PORT=3999`): cả **10** module browser trả `200`
  `text/javascript` với kích thước hợp lệ; route bịa `webapp-nope.mjs` trả `404`. Trước đây mục
  "verify bằng browser" bị coi là bất khả thi trong harness này — hoá ra chỉ cần **một lệnh tự chứa**
  (khởi động server + `for` curl + `kill`) thay vì giữ tiến trình nền giữa các lệnh.
- **Test hành vi**: `webapp-app-boot.test.mjs` (dựng DOM từ `webapp.html`, import thật) xanh ngay
  sau khi tách — tức 7 module evaluate được và hợp đồng `on*` còn nguyên. File này **có** sửa 1 dòng
  (nguồn id tự chèn nay quét cả closure, vì `tx-verify-note` đã sang `webapp-withdraw.mjs`), nhưng
  đo lại thì dòng đó **không bắt buộc**: quay về nguồn cũ (chỉ đọc `webapp-app.mjs`) test boot vẫn
  xanh 3/3 — đúng mục 2 ở dưới (đường boot chỉ chạm 2 id), nên nó là chống-đỏ-giả về sau chứ không
  phải bằng chứng. Bằng chứng cho lưới id nằm ở test TĨNH: quay nó về nguồn cũ ⇒ đỏ ngay
  `expected [ 'tx-verify-note' ] to deeply equal []`.

### Plan đã nói sai chỗ nào (ghi để vòng sau không lặp)

1. **P1 không kiểm được TDZ như đã hứa.** Kịch bản phá "kéo một `const` xuống cuối file" KHÔNG
   làm test đỏ: `init()` chạy *sau khi* module evaluate xong, nên lúc hàm đọc hằng thì nó đã được
   khởi tạo. Test bắt được: reference top-level vào global/API không tồn tại, id mismatch, đường
   boot chạy tới nhánh lỗi, và mọi handler `on*` đã thực sự được gán. **Không** bắt TDZ trong thân
   hàm — muốn bắt phải chạy `init()` ngay trong lúc evaluate (readyState != "loading") và bắt
   unhandled rejection, việc chưa làm.
2. **Lưới phủ id thật nằm ở test TĨNH, không phải test động.** Đo được: đường boot chỉ chạm **2**
   id (`loading`, `error-banner`) vì nó dừng ở bước RPC. Đã ghi thẳng con số này vào cả hai file
   test thay vì để người đọc tưởng test động phủ hết.
3. **Probe id ban đầu báo động giả.** Script probe của tôi báo `tx-verify-note` là id thiếu,
   nhưng id đó do chính `webapp-app.mjs` chèn vào banner rồi tra lại có null-guard (`__tests__/webapp.test.mjs:404`
   ghim việc chèn đó). Nếu tin ngay probe thì đã "sửa" một thứ không hỏng. Hệ quả thiết kế: test
   tĩnh chấp nhận id tự chèn. Lần phá id ĐẦU TIÊN của tôi không làm test đỏ vì lúc đó test tĩnh
   chưa tồn tại còn test động thì chỉ chạm 2 id — đây là lý do test tĩnh ra đời.
4. **"Boot test không phải sửa một dòng" là nói quá.** Nó *xanh* mà không cần sửa, nhưng file vẫn bị
   sửa 1 dòng (nguồn id tự chèn) và phép đo ngược ở §Bằng chứng P5 chứng minh dòng đó không cần
   thiết cho test boot. Ghi lại vì đúng kiểu tuyên bố dễ bị đọc thành "test bắt được lỗi".
