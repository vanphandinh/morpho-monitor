# Đợt chẩn đoán 4 triệu chứng webapp/gas — D15…D19 (2026-09-26)

Repo: `morpho-monitor` · Nhánh: `feat/multi-market-monitor` · Bắt đầu từ `cf1bb58` (đỉnh sau khi
merge vòng 7 vào `main`).

Bốn triệu chứng người dùng báo:

| # | Triệu chứng (nguyên văn) | Kết luận | Commit |
| --- | --- | --- | --- |
| 1 | bundle nonce cũ có chứa tier nonce cũ đã hết hạn, "nhưng không tự động xóa" | `expired` là lịch sử TRƠ và **không có đường nào xoá** — `broadcastEligible` short-circuit ở phase-0 idle trước mọi nhánh dọn | `bfa4581` (**D17**) |
| 2 | tier mới với nonce cao hơn "tự động thêm vào bundle có nonce cũ" | nhánh merge ở `POST /api/presign` cho `expired` (thiếu trong `HISTORY_STATUSES`), và trang không đọc lại nonce on-chain trước khi ký | `2f02e20` (**D16**) + `526eb65` (**D19**) |
| 3 | "thông tin về các bundle và tier lúc hiện lúc không" | `init()`/`switchTab` bị chặn bởi `state.marketData` ⇒ RPC hỏng lúc mở trang thì **0 request** `/api/presign`; lỗi 503 bị ẩn im lặng, không thử lại | `526eb65` (**D18**) |
| 4 | lỗi khi xử lý gas price với số nhỏ hàng thập phân, ví dụ `maxPriorityFeePerGas = 0,00000026` | `parseFloat` + `String` ⇒ ký hiệu khoa học `2.6e-7` mà `parseUnits` từ chối; dấu phẩy VN bị cắt thành `0` | `17bbd49` (**D15**) |

Đợt này chạy theo skill `diagnosing-bugs`: **dựng loop đỏ trước, không dựng giả thuyết trước khi có
loop**. Mọi khẳng định dưới đây đều kèm lệnh chạy thật + chuỗi lỗi nguyên văn.

---

## 1. Bằng chứng người dùng cung cấp (artifact thật, không phải suy đoán)

`data/presigned.json` của máy gặp lỗi (chỉ địa chỉ/hash công khai, không có secret):

```json
{ "version": 3,
  "bundles": {
    "0x2485…0ea6@2550": { "nonce": 2550, "status": "expired", "createdAt": "2026-09-25T17:43:11.262Z", "withdrawals": [] },
    "0x2485…0ea6@2553": { "nonce": 2553, "status": "pending", "createdAt": "2026-09-26T05:04:14.155Z", "withdrawals": [ …1 tier all-shares, tx ký nonce 2553… ] }
  },
  "consumedNonce": -1 }
```

Đọc ra (và dùng làm ca minimise cho D17):

* `@2550` là rung `expired` + **rỗng tier**, nằm nguyên hơn một ngày — không có gì xoá nó.
* `consumedNonce: -1` dù đã có rung `expired` ⇒ nếu purge mà không nâng watermark thì ký ức "nonce
  đã tiêu thụ" sẽ mất.
* Volume Docker local của tôi (`morpho_presigned_data`) rỗng (`{"version":2,"bundles":{}}`, 35 byte),
  nên **không** phải nguồn của 4 triệu chứng — artifact của người dùng là thứ quyết định.

---

## 2. Phase 1 — loop đỏ (chạy thật, trước mọi giả thuyết)

Harness có sẵn của repo được dùng lại, không viết mock mới:
`__tests__/helpers/webapp-harness.mjs` (`loadWebapp` + RPC/ví/REST giả) và
`__tests__/helpers/webapp-scenario.mjs`.

**Loop gas (D15)** — lái module production thật:

```text
52  # ô maxPriorityFeePerGas = "0.00000026" (đúng giá trị autoFillGas ghi ra: formatUnits(260n, 9))
A) RED: InvalidDecimalNumberError: Number `2.6e-7` is not a valid decimal number.   ← readGasInputs()
B) RED: InvalidDecimalNumberError: Number `2.6e-7` is not a valid decimal number.   ← onGasInputChange()
C) "0,00000026" (phẩy VN) → KHÔNG ném, nhưng parseFloat = 0 ⇒ ô coi như rỗng, không banner, nút Ký disabled
```

Kiểm chéo độc lập: `parseUnits("0,00000026", 9)` và `parseUnits("1e-7", 9)` đều ném
`InvalidDecimalNumberError` — tức cả dấu phẩy **lẫn** số mũ đều là lỗi thật, không chỉ dấu phẩy.

**Loop webapp (D18/D19)** — `loadWebapp` với RPC giả bị chặn `eth_call` và REST giả trả 503 một lần:

```text
0 request /api/presign  dù bấm tab presign bao nhiêu lần   ← init() không đọc bundle, switchTab bị chặn bởi marketData
presign-existing  display = none  sau một lần 503 (LOCK_STALE) — không banner, không thử lại
(nonce on-chain 12 > nonce đang ký 11) ⇒ vẫn gửi eth_sendTransaction ở nonce 11
```

---

## 3. Phase 3 — giả thuyết đã xếp hạng (trình trước khi test)

1. **Bug 1+2 cùng một lỗ**: `expired` thiếu trong `HISTORY_STATUSES` nên rung đã chết vẫn được merge
   và bị ghi lại `pending`. *Dự đoán*: chặn rung `expired`/`invalid` ở POST cùng nonce ⇒ mất triệu
   chứng. → **Đúng** (D16).
2. **Bug 3 cơ chế đôi**: (a) bundle nằm ở SERVER nhưng chỉ được đọc sau khi có `marketData` của RPC;
   (b) lỗi tạm thời bị nuốt. *Dự đoán*: bỏ cổng `marketData` + thử lại lỗi 503 ⇒ mục bundle luôn
   hiện. → **Đúng** (D18).
3. **Bug 2 vế webapp**: trang giữ nonce từ lần "Lấy Nonce" trước và không đọc lại on-chain trước khi
   ký. *Dự đoán*: guard đọc lại nonce ⇒ không còn chữ ký ở nonce đã chết. → **Đúng** (D19).
4. **Bug 1 bản "chính sách"**: không có cơ chế dọn nào cả. *Dự đoán*: purge theo tuổi là mất triệu
   chứng, và an toàn nhờ watermark `consumedNonce` monotonic. → **Đúng** (D17).
5. **Bug 2 bản "ví/RPC trả nonce cũ"**: ví bỏ qua `nonce` truyền vào. *Dự đoán*: nếu đúng thì log
   `eth_sendTransaction` sẽ cho thấy nonce khác giá trị yêu cầu. → **Không có bằng chứng** trong
   harness (ví giả nhận nguyên tham số); loại trừ ở phạm vi repo. Với bug 1, giả thuyết "UI đọc sai"
   cũng loại trừ: nhánh merge thật sự chạm registry.

---

## 4. Phase 5 — sửa + test hồi quy (red-trước, green-sau)

Mỗi fix có một file test mới giữ đúng ca đỏ của người dùng; tất cả đều đã **chạy đỏ trên cây trước
fix** (chuỗi lỗi ghi nguyên văn trong commit body tương ứng).

### D15 — `parseGasInput()` thay `parseFloat`/`String` (`17bbd49`)

`__tests__/webapp-gas-decimals.test.mjs` (4 test). Đỏ-trước:
`InvalidDecimalNumberError: Number `2.6e-7` is not a valid decimal number.` và
`TypeError: parseGasInput is not a function`. Sau fix: `0.00000026` → `260n`, `0,00000026` → `260n`,
ký ra `maxPriorityFeePerGas = 0x104` (260 wei); số mũ / >9 chữ số thập phân ⇒ banner + chặn ký. Ô
nhập đổi sang `type="text" inputmode="decimal"`.

### D16 — rung `expired` không hồi sinh được (`2f02e20`)

`__tests__/presigned-expired-rung.test.mjs` (3 test). Đỏ-trước:
`AssertionError: expected 200 to be 409` ×2. Sau fix: cùng identity + trạng thái trong
`NON_MERGEABLE_STATUSES` (= `HISTORY_STATUSES` + `expired` + `invalid`) ⇒ 409 `NONCE_NOT_CLAIMABLE`,
registry không bị chạm (throw TRƯỚC mọi mutation). Ca A3 ghim bất biến: nonce CAO HƠN ⇒ rung cũ
nguyên trạng, rung mới chỉ có tier mới — chứng minh triệu chứng 2 **không** phát sinh trong handler
khi nonce khác, tức phần còn lại là phía webapp (D19).

### D17 — purge rung `expired` (`bfa4581`)

`__tests__/presigned-expired-purge.test.mjs` (6 test). Đỏ-trước:
`TypeError: purgeExpiredRungs is not a function` ×4,
`AssertionError: expected { marketId: 'm1', nonce: 2550, …(3) } to be undefined`,
`AssertionError: expected undefined to be '2026-09-26T12:00:00.000Z'`. Sau fix:
`purgeExpiredRungs()` chạy TRƯỚC nhánh idle (không RPC; chỉ lấy lock khi thật sự có record để xoá),
chỉ chạm `status === "expired"` quá ân hạn (`PRESIGN_EXPIRED_RETENTION_MINUTES`, mặc định 60 phút,
0 = ngay chu kỳ kế tiếp), record thiếu mốc thời gian / nonce không hữu hạn bị GIỮ LẠI (fail closed),
và **nâng `consumedNonce`** lên nonce bị xoá trong cùng mutation. Hai nhánh set `expired` nay ghi
`expiredAt` làm mốc đo ân hạn.

### D18/D19 — bỏ cổng RPC cho bundle, thử lại lỗi tạm thời, guard nonce trước khi ký (`526eb65`)

`__tests__/webapp-bundle-visibility.test.mjs` (3 test) + `__tests__/webapp-stale-nonce-guard.test.mjs`
(4 test) + `retryTransient` (hàm thuần, tiêm `sleep`). Đỏ-trước (7/7):

```text
AssertionError: tab presign phải đọc bundle ngay cả khi RPC hỏng: expected 0 to be greater than 0
TypeError: app.window.fetchExistingBundle is not a function
TypeError: retryTransient is not a function
AssertionError: không được ký ở nonce đã chết: expected [ { kind: 'provider', …(2) } ] to deeply equal []
AssertionError: ký đúng nonce mới: expected '0xb' to be '0xc'
AssertionError: thiếu bằng chứng nonce ⇒ không ký: expected [ … ] to deeply equal []
AssertionError: head phải là rung pending 2553: expected '2550' to be '2553'
```

* `init()` đọc bundle trong `finally`; `switchTab("presign")` đọc LUÔN (chỉ render theo RPC mới cần
  `marketData`).
* `retryTransient` (`webapp-logic.mjs`): `PRESIGN_FETCH_ATTEMPTS` 3 × `PRESIGN_FETCH_DELAY_MS` 400ms,
  chỉ cho 503/5xx/fetch ném; lỗi 4xx (trừ 401) là lỗi thật, không thử lại. Hết ngân sách ⇒ banner lý
  do + nút `Thử lại` (`window.fetchExistingBundle` / `window.refreshPresignOverview`).
* Dấu `(nonce kế tiếp sẽ broadcast)` gắn vào rung HOẠT ĐỘNG đầu tiên (pending/broadcasting).
* `nonceStillSignable()` ở đầu `signAllTiers()`/`signWithdrawAll()`: on-chain vượt qua nonce đang ký ⇒
  chặn, tự nâng `state.presignedNonce` lên sàn mới, vô hiệu chữ ký ở nonce đã chết và báo rõ; không
  đọc được nonce ⇒ fail closed. (Chỉ chặn khi on-chain **vượt qua**; nonce cao hơn on-chain vẫn hợp
  lệ vì đó là xếp hàng có chủ đích qua nút ＋.)

**Trace đóng băng sinh lại CÓ CHỦ Ý**: diff so với bản cũ đúng **+2** lời gọi
`eth_getTransactionCount` (một cho mỗi bước ký) và **0** lời gọi bị mất; ghim số lời gọi 46 → 48
trong `__tests__/webapp-flows.test.mjs`.

---

## 5. Phase 6 — dọn dẹp

* `[DEBUG-…]`: đợt này **không thêm tag nào**. Ba file còn mang tag là probe **của các vòng trước**
  (`scripts/probe-payload-limit.mjs` `[DEBUG-mn3]`, `scripts/probe-rpc-endpoints.mjs` `[DEBUG-pr1]`,
  `scripts/replay-eth-call-burst.mjs` `[DEBUG-br2]`) — chúng được giữ có chủ đích như harness debug
  có tên rõ ràng (Phase 6: "moved to a clearly-marked debug location"), không phải rác của đợt này.
* Không có prototype dùng một lần nào còn lại: các probe tạm chạy bằng
  `node --input-type=module -e "…"` (không tạo file), fixture trace sinh lại bằng lệnh chính thức
  `node scripts/webapp-trace.mjs --out __tests__/fixtures/webapp-flows-trace.json`.
* Ca gốc không còn tái hiện: 7/7 test webapp + 4/4 gas + 6/6 purge + 3/3 rung expired đều xanh; trace
  19 bước vẫn khớp fixture (sau khi sinh lại có chủ ý).

---

## 6. Cổng cuối (đo trên cây sau cả 4 commit)

```text
npm run check
  Found 0 warnings and 0 errors.
  [lint] ✅ độ phủ: oxlint quét 92 file .mjs (git theo dõi 90 file, phạm vi ".")   # lúc đo: 2 file test
                                                                                   # mới còn untracked; sau khi commit là 92/92
  ✅ node --check: 90/90 target OK (84 file .mjs + webapp.html no-inline-module)
  Test Files  43 passed (43)
  Tests  579 passed | 7 skipped (586)
```

GitNexus (AGENTS.md): `impact` — `updateRegistry` **CRITICAL** (D16/D17), `broadcastEligible`
**CRITICAL** (D17), `fetchExistingBundle`/`refreshPresignOverview` **CRITICAL** (D18/D19);
`switchTab`/`signAllTiers` trả `UNKNOWN` (gọi qua `onclick` trong HTML + `window.*`) nên đã xác nhận
bằng text search: `webapp.html:216,217,444` + `__tests__/helpers/webapp-scenario.mjs`. `detect-changes
--scope all` từng bước: D16 1 file/6 symbol · medium; D17 4 file/16 symbol · high; D18/D19 7 file/23
symbol · critical — **không** lần nào `partial`/`truncated`.

---

## 7. Còn mở (đọc để không tưởng là "sạch tuyệt đối")

1. **Proxy chưa kiểm nonce on-chain khi capture tx.** Guard mới ở phía browser chặn ký ở nonce đã
   chết, nhưng một client khác (script tự viết, ví tự thêm nonce) vẫn có thể POST một tx ký ở nonce
   đã tiêu thụ; server chỉ từ chối nếu rung tương ứng đã `expired`/`invalid`. Kiểm `nonce ≥
   eth_getTransactionCount(pending)` ở proxy là lớp phòng thủ kế tiếp.
2. **Một rung = một phát.** Nhiều tier trong cùng một rung là các phương án thay thế; tx đầu tiên
   mine ⇒ mọi sibling cùng nonce `expired`, các tier còn lại của chính rung đó không bao giờ được
   broadcast. Muốn cả bậc thang đều có cơ hội thì mỗi tier phải nằm ở một nonce riêng (thay đổi
   thiết kế, chưa làm).
3. **Không có retention cho `submitted`/`failed`/`superseded`** (chỉ `expired` được purge). Chúng
   vẫn là lịch sử trơ, chỉ xoá được bằng tay; nếu registry phình thì đây là việc kế tiếp.
4. **`PRESIGN_EXPIRED_RETENTION_MINUTES` chỉ có ở `.env.example`** — chưa có test nào ghim việc đọc
   env này ở `monitor.mjs` bootstrap (hàm `purgeExpiredRungs` được test trực tiếp với tham số).
5. **Triệu chứng "lúc hiện lúc không" chưa được chứng minh trên môi trường thật** (RPC công cộng
   hỏng thật, `LOCK_STALE` thật). Harness tất định đã tái hiện đúng hai cơ chế; nếu còn ca khác thì
   cần HAR/log có timestamp từ máy người dùng.
