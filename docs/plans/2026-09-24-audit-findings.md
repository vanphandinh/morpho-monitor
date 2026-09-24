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
