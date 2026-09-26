# Audit toàn diện — 2026-09-24 (branch `feat/multi-market-monitor`)

Repo: `morpho-monitor` · Branch: `feat/multi-market-monitor` · HEAD lúc audit: `e221bb6`
Phạm vi: toàn bộ module production trên nhánh hiện tại (10.5k dòng `.mjs` + `webapp.html`),
tập trung vào phần MỚI NHẤT — presign ladder v3 multi-nonce (4 commit gần nhất).
Phương pháp: mỗi phát hiện phải có **vòng phản hồi đỏ được** (test chạy production code) trước khi sửa.

Trạng thái tổng: **baseline xanh → 3 defect xác nhận (2 money-relevant) đã sửa + 4 phát hiện ghi nhận**.
`npm run check` cuối cùng: **23 file / 360 test pass** (baseline 356 → +4 regression test), lint + `node --check` sạch.

---

## 1. Vòng phản hồi (Phase 1) — baseline trước khi sửa

Không có test nào đỏ ở baseline ⇒ audit này là "đi tìm defect", không phải "fix test đang đỏ".
Mọi defect dưới đây đều được chứng minh bằng **một lệnh chạy được, xác định, < 2s**, và test đó
được giữ lại làm regression test (Phase 5). Bằng chứng "trước fix" là output thật của vitest.

```
$ npm run check                      # baseline, trước mọi thay đổi
 Test Files  23 passed (23)
      Tests  356 passed | 7 skipped (363)
```

## 2. Pre-edit impact analysis (gitnexus, bắt buộc theo AGENTS.md)

| Symbol (file) | Callers / processes | Risk | Ghi chú |
| --- | --- | --- | --- |
| `broadcastEligible` (presigned-broadcast.mjs) | d=1 `monitor.mjs:broadcastEligible` (wrapper), d=2 `checkMarkets` → `main`; 4 process (`BroadcastEligible → EstimatedAssets / IsMinedReceipt / IsActiveClaim / ReconcileBroadcasting`) | **LOW** | `epistemic: exact`; sửa chỉ trong Phase 2 (nhánh terminal), không đổi phase 1/claim |
| `marketBundles` (presigned-store.mjs) | d=1 `handler` (webapp-handler); 1 process | **LOW** | Tái dùng cho lookup identity (không đổi hành vi của helper) |
| `createRequestHandler` (webapp-handler.mjs) | d=1 `webapp-server.mjs`; 0 process | **LOW** | `api_impact POST /api/presign`: 0 consumer index, riskLevel LOW |

`detect_changes --scope all` (sau khi sửa): `changed_count: 3`, `changed_files: 6`,
`affected_count: 5`, `risk_level: medium`, **không** có `partial`/`truncated`
(changed symbols đúng là 2 hàm production + closure `handler`).
Lưu ý: index gitnexus **behind 1 commit** so với HEAD — nên refresh trước lần audit sau.

## 3. Defect đã sửa

### F4 (HIGH, money-relevant) — terminal transition expire SAI rung của bậc thang

`presigned-broadcast.mjs`, Phase 2. Sibling expiry dùng biến `nonce` (pending nonce đọc ở đầu
chu kỳ) thay vì **nonce của claim**:

```js
// CŨ — claim nonce 7 đang nằm trong mempool ⇒ getTransactionCount(pending) = 8
for (const [id, other] of Object.entries(registry.bundles)) {
  if (id !== claim.id && Number(other.nonce) === Number(nonce) && ...) other.status = "expired";
}
```

Khi tx của claim còn trong mempool, `eth_getTransactionCount(..., "pending")` **đã tính chính nó**
⇒ `pending = claim.nonce + 1`. Đây chính là workflow của ladder ("ký trước rung kế tiếp"), nên
reconcile một claim nonce 7 sẽ **expire rung nonce 8 vừa được ký** — rung hợp lệ, đúng nonce kế tiếp,
bị vô hiệu hoá âm thầm (user phải ký lại; nếu không để ý, tier đó không bao giờ được rút).

Bằng chứng trước fix (`npx vitest run __tests__/presigned-lifecycle.test.mjs`):

```text
× F4: reconcile claim nonce 7 không được expire rung hợp lệ ở nonce 8 19ms
AssertionError: expected 'expired' to be 'pending'
Expected: "pending"   Received: "expired"
```

Fix: dùng `claimNonce = Number(claim.bundle?.nonce)` cho cả sibling expiry và log terminal;
nonce thiếu/không hợp lệ ⇒ **không expire ai** (fail closed). Sau fix: F4 pass, và
`presigned-lifecycle` (26) + `presigned-e2e-ladder` (2) + `presign-broadcast` (8) + `expire-bundle` (7) đều xanh.

### F1 (HIGH, money-relevant) — registry v2→v3: POST tạo RUNG TRÙNG IDENTITY

`presigned-store.mjs` migrate v2 **giữ nguyên key cũ** (plain `marketId`; key là opaque, identity
nằm trong VALUE) — nhưng `POST /api/presign` lại tra rung bằng key composite:

```js
// CŨ (webapp-handler.mjs)
const key = bundleKey(marketId, incoming.nonce);   // "marketId@7"
const old = registry.bundles[key];                 // key legacy là "marketId" ⇒ undefined
```

⇒ coi như bundle mới, `registry.bundles["marketId@7"] = merged` **trong khi key legacy vẫn còn**.
Hệ quả trên registry của deployment (v2 từ trước, đã migrate):

1. hai rung cùng identity `(marketId, nonce)`;
2. ladder/overview báo **race giả** ("nonce đang được dùng bởi nhiều market") cho cùng một market;
3. broadcaster `marketBundles(...).find(pending && nonce === pending)` chọn rung **đầu theo thứ tự
   chèn = rung legacy** ⇒ có thể broadcast **số tiền cũ** mà user đã sửa.

Bằng chứng trước fix:

```text
× F1: POST cùng nonce vào registry đã migrate v2 KHÔNG được tạo rung trùng identity
[presigned] 📝 Presigned bundle saved at …: 1 tiers, nonce=7      ← "saved", không phải "merged"
AssertionError: expected [ {…}, {…} ] to have a length of 1 but got 2
```

Fix: tra rung theo **identity (marketId từ VALUE, nonce)** qua `marketBundles`, ghi lại vào **key
tìm được** (giữ key legacy — key vẫn opaque), và dọn các bản sao identity còn sót (state hỏng do bug
này) trừ rung đang claim (`broadcasting`) — lifecycle guard vẫn là chốt fail-closed.
Sau fix: `📝 Presigned bundle merged (1 new, 1 kept)`, 1 rung, `presigned-api` (20) xanh.

### F3 (MEDIUM, mất dữ liệu ở sai rung) — `DELETE ?tier=N` không kèm `nonce` là mơ hồ

`webapp-handler.mjs`. Sau khi chuyển sang registry v3, `targets` là **mọi rung** của market; không
có `nonce` thì `rung[0]` = rung nonce **thấp nhất** ⇒ xóa tier ở rung khác với rung user đang xem,
và vẫn trả `ok: true`. (`deleteTierFromBundle` phía browser hiện **không còn được gọi** — API này
chỉ còn đường gọi thủ công, nhưng vẫn là endpoint xoá dữ liệu.)

Fix: ladder > 1 rung mà thiếu `nonce` ⇒ 400 `MARKET_INPUT_INVALID` (thông báo có hành động);
`nonce` chỉ định mà không có rung tương ứng ⇒ 400 (trước đây `ok:true, removed:null` — im lặng vô ích).
Test: 2 case mới trong `__tests__/presigned-api.test.mjs` (rung khác phải nguyên vẹn).

### Hygiene đã sửa

* `webapp.html`: `saveToServer()` thành công chỉ refresh overview, **không** refresh ladder đang
  hiển thị ⇒ UI giữ state cũ tới lần chuyển tab sau. Nay gọi cả `fetchExistingBundle()`.

## 4. Phát hiện GHI NHẬN, chưa sửa (có bằng chứng, cần quyết định của owner)

### R1 (HIGH nếu gặp) — claim không thể mine ⇒ bậc thang kẹt vĩnh viễn, không tự báo

Bằng chứng (chạy production code, registry: claim `a@7` broadcasting + rung `b@8` pending hợp lệ,
`sendRawTransaction` lỗi `nonce too low` = nonce đã bị tiêu bởi tx khác ⇒ tx của claim **không bao giờ mine được**):

```text
claim = a@7 | stuck = false | a@7 = broadcasting | b@8 = pending
```

⇒ rung `b@8` (eligible, đúng nonce hiện tại) **không bao giờ được claim**; claim `a@7` không bao giờ
được finalize; webapp cũng không cứu được (POST cùng nonce bị `409 ACTIVE_CLAIM_CONFLICT`, DELETE bị
guard chặn) ⇒ **phải sửa tay `data/presigned.json`**. Mỗi chu kỳ monitor chỉ log
`broadcast error (claim retained): nonce too low` và trả `stuck: false` (không escalate).
Đây là lựa chọn fail-closed có chủ đích (test "keeps broadcasting on send timeout even when pending
nonce advances" khẳng định điều này), nên **không tự ý đổi bất biến lifecycle** trong audit này.
Đề xuất: phân biệt *definitive* (`nonce too low` / `already known` / `replacement underpriced`) với
*lỗi mơ hồ*, và chỉ với nhóm definitive mới đánh dấu claim là "dead, cần người xử lý" + cho phép
rung kế tiếp claim (hoặc tối thiểu là `stuck: true` + diagnostic riêng để webapp/ntfy cảnh báo).

### R2 (MEDIUM, money-relevant) — merge giữ tier cũ ⇒ có thể broadcast số tiền user đã bỏ

Merge semantics là chủ đích ("1 new, 1 kept") để ký tăng dần nhiều đợt. Nhưng khi user **sửa số tiền**
(100 → 50) và ký lại, tier cũ vẫn nằm trong rung, và bộ chọn ưu tiên **lớn nhất ≤ liquidity**:

```text
rung sau merge: old-100, new-50 → broadcast chọn: old-100
```

UI không có đường xoá 1 tier (nút theo tier đã bị gỡ; API `deleteTierFromBundle` còn đó nhưng không
được gọi) ⇒ muốn bỏ tier cũ phải "Xóa Mọi Bundle Của Market Này" rồi ký lại tất cả.
Đề xuất: hoặc gửi cờ "tier list là authoritative" (replace) khi user đã ký lại đủ, hoặc nối lại nút
xoá tier theo từng rung (đã có F3 guard cho API này).

### R3 (MEDIUM) — proxy bind public nhưng thiếu `WEBAPP_PASSWORD` chỉ WARN, không fail-fast

`webapp-server.mjs` fail-fast khi thiếu `WEBAPP_PASSWORD` (`assertWebappAuthConfig`), còn
`proxy-rpc.mjs` chỉ `console.warn` khi `PROXY_HOST` public + thiếu password. Trong dev mode
(`checkInternalSecret` trả `true` khi password rỗng) ⇒ `GET /captured` (lộ danh sách txHash) và
`DELETE /captured` (xoá buffer capture của chính mình) **mở** cho bất kỳ ai vào được port 8545 —
docker-compose có publish port này. Đề xuất: fail-fast (hoặc bắt buộc `WEBAPP_ALLOW_INSECURE=1`)
theo đúng chuẩn đã áp cho webapp.

### R4 (LOW) — các điểm nhỏ

* `.env.example` ghi "normally <= 10" market, code chặn `> 9` (`loadMarkets`). **Không sửa được bằng
  công cụ edit của agent** (file `.env.*` bị chặn) — cần user sửa tay 1 dòng.
* Tab "Rút Tiền" (không presign) dùng `walletClient.writeContract`: nếu ví đang trỏ vào proxy RPC,
  tx bị **capture** thay vì broadcast, nhưng UI vẫn báo "✅ đã gửi thành công" + link Etherscan.
  Cùng lớp rủi ro với H5 (đã gỡ theo quyết định 2026-09-24) — chỉ nên cảnh báo trong UI.
* Index gitnexus sau `HEAD` 1 commit ⇒ `analyze --index-only` lại trước lần audit/commit sau.

## 5. Cổng kiểm chứng (output thật, sau fix)

```text
$ npm run check
 ✅ node --check: 45/45 file OK          # lint: 12 warnings (no-unused-vars cũ), 0 errors
 Test Files  23 passed (23)
      Tests  360 passed | 7 skipped (367)

$ npx vitest run __tests__/presigned-lifecycle.test.mjs __tests__/presigned-merge-nonce.test.mjs \
    __tests__/presigned-api.test.mjs __tests__/presigned-e2e-ladder.test.mjs
 Test Files  4 passed (4)      Tests  50 passed (50)
```

Regression test mới (giữ lại vĩnh viễn): F4 → `presigned-lifecycle.test.mjs`;
F1 → `presigned-merge-nonce.test.mjs`; F3 → 2 case trong `presigned-api.test.mjs`.

## 6. Cleanup (Phase 6)

* Không có instrumentation `[DEBUG-*]` nào được thêm (0 grep hit).
* Không tạo prototype/script tạm trong repo — mọi repro là test thật (giữ lại) hoặc `node -e` (không ghi file).
* Repro gốc không còn tái hiện (4 test mới đều xanh, toàn bộ suite xanh).
* Không commit/push (theo yêu cầu). Gợi ý message khi commit — nêu rõ hypothesis đúng:

```text
fix(presign): expire đúng nonce của claim + tra rung theo identity (audit 2026-09-24)

F4: terminal transition dùng pending nonce (đã tính cả tx của claim trong mempool)
    nên expire rung kế tiếp vừa ký — nay dùng nonce của claim, fail closed nếu thiếu.
F1: POST /api/presign tra rung bằng key composite nên bỏ sót key legacy v2 (migrate giữ
    nguyên key) và tạo rung trùng identity — nay tra theo (marketId từ VALUE, nonce).
F3: DELETE ?tier thiếu nonce trên market có ladder luôn sửa rung nonce thấp nhất — nay 400.
```

## 7. Bất biến được giữ nguyên (không nới trong audit này)

1. Claim durable trước mọi I/O; timeout/lỗi RPC mơ hồ/pending-nonce advance **không** unlock.
2. Chỉ receipt có block identity mới cho terminal (`submitted`/`failed`) + tiêu thụ nonce.
3. `keccak256(rawTx) === txHash` trước mọi rebroadcast; record thiếu identity → fail closed.
4. Tối đa 1 claim/nonce; 2 claim cùng nonce → conflict, không gửi gì.
5. Lifecycle guard `origin: "user"` vẫn là chốt cuối cho mọi mutation từ webapp.

---

## 8. Xử lý R1–R4 (cùng ngày 2026-09-24) — 6 bước

Ba quyết định của owner (đều là phương án "Recommended"):

| Finding | Quyết định |
| --- | --- |
| R1 | **Tự nhả claim khi có đủ bằng chứng** (không chờ người sửa tay `data/presigned.json`) |
| R2 | **Nút xoá tier theo từng rung** (giữ merge semantics, đưa quyền quyết định cho user) |
| R3 | **Fail-fast + escape hatch** `WEBAPP_ALLOW_INSECURE=1` |

Bất biến ở §7 **không bị nới** ở bất kỳ bước nào — R1 chỉ thêm một lối ra *có bằng chứng*.

### R1 — trạng thái terminal thứ ba `superseded`

Claim `broadcasting` bị một tx KHÁC tiêu thụ nonce thì không bao giờ mine được, nhưng theo thiết kế
cũ nó **không bao giờ được nhả**: mỗi chu kỳ monitor chỉ log `broadcast error (claim retained)` và trả
`stuck: false`; webapp cũng bất lực (POST cùng nonce → 409, DELETE → guard chặn) ⇒ phải sửa tay
registry. Nay claim được nhả khi **và chỉ khi** hai bằng chứng độc lập cùng đúng:

1. `getTransactionReceipt(claim.txHash)` trả **`null`** (throw hoặc non-null đều KHÔNG phải bằng chứng), **và**
2. `eth_getTransactionCount(latest)` **lớn hơn** nonce của claim (tx đã mine không thể nhảy nonce).

Controller (`presigned-broadcast.mjs`): `nonceConsumedByAnotherTx()` fail closed khi nonce không hữu hạn
hoặc lookup lỗi; `releaseSuperseded()` ghi trong MỘT mutation có lock: `status: "superseded"` + `reason`
+ `terminalAt`, xoá `rawTx` (bytes vô dụng — nonce đã mất), giữ `withdrawals` để đối soát, expire các
sibling cùng nonce, log `[presign] claim <id> released as superseded`. Nonce **vẫn tiêu thụ vĩnh viễn**
(như `submitted`/`failed`) nên không thể claim lại; `PROTECTED_STATUSES` vẫn chỉ có `["broadcasting"]`
⇒ user xoá được record `superseded`, còn claim sống vẫn 409.

Bằng chứng (5 case mới, đều chạy production `broadcastEligible` trên registry thật + client giả):

```text
$ npx vitest run __tests__/presigned-lifecycle.test.mjs --reporter=verbose | grep "R1 —"
 ✓ R1 — nhả claim chết (nonce đã bị tx KHÁC tiêu thụ) > (a) receipt null + latest > nonce ⇒ superseded,
   và rung kế tiếp được claim ở chu kỳ sau
 ✓ (b) lỗi RPC khi đọc receipt ⇒ KHÔNG thu thập bằng chứng, giữ broadcasting (fail closed)
 ✓ (c) receipt null nhưng nonce CHƯA bị tiêu thụ (latest == nonce) ⇒ giữ claim, vẫn rebroadcast
 ✓ (d) receipt mine đúng hash ⇒ submitted (bằng chứng chết không chen ngang)
 ✓ (e) nonce của claim đã nhả vẫn tiêu thụ vĩnh viễn ⇒ không bao giờ claim lại rung cùng nonce
```

Case (b)/(c) chính là hai bẫy của phép thử này: RPC lỗi **không** được coi là "tx chết", và nonce
chưa nhảy **không** được coi là "tx chết" — nếu sai, claim hợp lệ bị giết oan (mất tiền thì không,
nhưng mất cả bậc thang). 3/5 case này đỏ trước khi sửa.

Quan sát được (cùng commit): `GET /api/overview` thêm `broadcastingAt` + `reason` (`registrySummary`);
`webapp.html` hiện tuổi claim + banner quá hạn; `monitor.mjs` gọi
`alertOnLifecycle(await broadcastEligible(...))` mỗi chu kỳ; module mới `lifecycle-alert.mjs` gửi ntfy
**ngoài quota** anti-spam (cooldown 6h theo `(kind, marketId)`, timeout 10s, swallow lỗi gửi).

### R2 — nút ✕ xoá tier theo từng rung

Merge giữ tier cũ là chủ đích, và `selectBestWithdrawal` chọn **lớn nhất ≤ liquidity**. Nên
"sửa 100 → 50 rồi ký lại" vẫn broadcast **100** nếu tier cũ chưa bị xoá. Chứng minh bằng chính hàm
production (`node --env-file=.env --input-type=module`):

```text
rung sau merge: old-100 (user đã bỏ), new-50
broadcast chọn (production selectBestWithdrawal): old-100 (user đã bỏ)
sau khi user bấm ✕ ở tier cũ:
broadcast chọn (production selectBestWithdrawal): new-50
```

⇒ Đường thoát duy nhất trước đây là "Xóa Mọi Bundle Của Market Này" rồi ký lại tất cả. Nay mỗi rung
(pending) có nút ✕ gọi `deleteTierFromBundle(nonce, index)`; rung `broadcasting` khoá (kèm thông báo
409 riêng). API `DELETE /api/presign` đã có guard F3 từ Bước 0 (thiếu `nonce` trên market nhiều rung
⇒ 400) nên không thể xoá nhầm rung.

### R3 — proxy fail-fast khi bind public mà thiếu `WEBAPP_PASSWORD`

Chính sách thuần `assertProxyAuthConfig({ host, password, allowInsecure })` trong `webapp-config.mjs`,
gọi trong `proxy-rpc.mjs` **trước** `loadMarkets()` (tức trước mọi I/O mạng/port). Xác minh bằng tiến
trình thật:

```text
$ PROXY_HOST=0.0.0.0 WEBAPP_PASSWORD= node --env-file=.env proxy-rpc.mjs
❌ PROXY_HOST=0.0.0.0 (public) nhưng WEBAPP_PASSWORD trống — proxy sẽ MỞ /captured và DELETE /captured cho bất kỳ ai.
   → Đặt WEBAPP_PASSWORD=<mật khẩu mạnh> trong .env, hoặc bind loopback (PROXY_HOST=127.0.0.1).
   → Chấp nhận rủi ro có ý thức (KHÔNG dùng trên VPS): set WEBAPP_ALLOW_INSECURE=1.
exit=1

$ PROXY_HOST=127.0.0.1 WEBAPP_PASSWORD= node --env-file=.env proxy-rpc.mjs   # loopback: vẫn chạy dev
[proxy] Khởi tạo với 11 RPC endpoint(s)
[proxy] Connected to real RPC — block #26048070
```

Lưu ý: ở lần chạy public, KHÔNG có dòng `[proxy] Khởi tạo...` — tức là chưa hề gọi RPC. Cảnh báo
`console.warn` cũ ở thời điểm `listen` đã bị gỡ vì không còn đường tới.

### R4 — hygiene

* **`webapp.html`, tab "Rút Tiền" (không presign):** sau `walletClient.writeContract`, UI cũ báo
  "✅ thành công" chỉ từ hash — mà đường đi của tx do RPC *trong ví* quyết định, nên ví trỏ về proxy ⇒
  tx chỉ được capture, chưa từng lên chain (cùng lớp rủi ro H5). Nay banner thêm xác minh
  **best-effort, không chặn UI** (`txVisibleOnChain`: 4 lần × 3s với `CFG.rpcUrls`) và chỉ CẢNH BÁO khi
  hash vẫn vô hình — không kết luận tx lỗi, vì lan truyền chậm cũng cho `false`. 6 test mới
  (5 cho retry/timeout của hàm thuần + 1 kiểm hợp đồng tĩnh trong `webapp.html`).
* **Cổng cú pháp cho `webapp.html`:** `scripts/check-syntax.mjs` nay trích mọi
  `<script type="module">` nội tuyến và `<script type="importmap">` rồi đưa qua
  `node --input-type=module --check` (stdin). Trước đây oxlint chỉ quét `.mjs`, nên lỗi cú pháp trong
  SPA ~2200 dòng chỉ lộ ra khi mở trang. Xác minh cổng thật sự bắt lỗi (tiêm `const X = ;` vào bản
  copy trong RAM):

  ```text
  $ node scripts/check-syntax.mjs
  ✅ node --check: 49/49 target OK (47 file .mjs + webapp.html inline)
  ```

* **Index gitnexus:** đã refresh (`analyze --index-only`) — trước đó behind 3 commit, khiến
  `impact` của các symbol mới (`alertOnLifecycle`, `assertProxyAuthConfig`) trả `UNKNOWN`/not-found và
  phải xác nhận tạm bằng text search (đã ghi trong message của Bước 2/Bước 4).
* **Còn lại — cần user sửa tay 1 dòng:** `.env.example` ghi "normally <= 10" market trong khi
  `loadMarkets` chặn `> 9`. Công cụ edit của agent từ chối mọi file `.env.*`; đổi "<= 10" thành
  "<= 9" (hoặc "at most 9") bằng tay.

### Cổng kiểm chứng cuối (output thật)

```text
$ npm run check
 ✅ node --check: 49/49 target OK (47 file .mjs + webapp.html inline)
 Found 12 warnings and 0 errors.        # oxlint: 12 warning no-unused-vars cũ, không phát sinh mới
 Test Files  24 passed (24)
      Tests  394 passed | 7 skipped (401)   # 7 skipped = toàn bộ block `ntfy live integration` (skipIf NTFY_LIVE !== "1")

$ node .gitnexus/run.cjs detect-changes --scope all --repo .
 Changes: 5 files, 14 symbols      Affected processes: 0      Risk level: low
 # không có partial/truncated
```

Chuỗi số lượng test theo từng bước: baseline `356` → Bước 0 (F1/F3/F4) `360` → Bước 1 (R1 core) `369`
→ Bước 2 (R1 observability) `381` → Bước 3 (R2) `388` → Bước 5 (R4) `394` (+7 skipped).

### Commit

| Bước | Commit | Nội dung |
| --- | --- | --- |
| 0 | `59651b2` | F4 (expire sai nonce), F1 (rung trùng identity), F3 (`DELETE ?tier` mơ hồ) + regression test |
| 1 | `187b973` | R1 core: `superseded` + bằng chứng kép, `HISTORY_STATUSES`, `registrySummary` |
| 2 | `f4dca49` | R1 quan sát được: `lifecycle-alert.mjs`, tuổi claim trong UI, banner quá hạn |
| 3 | `927c70f` | R2: nút ✕ theo từng rung |
| 4 | `73ff02e` | R3: proxy fail-fast + `WEBAPP_ALLOW_INSECURE` |
| 5 | commit này | R4: cảnh báo tab Rút Tiền, cổng cú pháp webapp.html, docs/CLAUDE.md, refresh index |
