# Audit vòng 2 — 2026-09-24 (nhánh `feat/multi-market-monitor`)

Repo: `morpho-monitor` · Branch: `feat/multi-market-monitor` · HEAD lúc audit: `f4bd50f`
(cùng ngày với `docs/plans/2026-09-24-audit-findings.md`; đây là vòng **kiểm tra lại chính các
sửa đổi mới nhất**, không lặp lại vòng 1).

Phạm vi: toàn bộ module production + 6 commit mới nhất (`59651b2`, `187b973`, `f4dca49`, `927c70f`,
`73ff02e`, `f4bd50f`) trên cây làm việc hiện tại.
Phương pháp: mỗi kết luận — kể cả kết luận "đã sửa đúng" — phải có **lệnh chạy được** trên
production code. Không suy luận từ tên test hay từ docstring.

Trạng thái cổng (baseline của vòng này):

```text
$ npm run check
 Found 12 warnings and 0 errors.                      # toàn bộ là no-unused-vars trong __tests__/*, 0 ở production
 ✅ node --check: 49/49 target OK (47 file .mjs + webapp.html inline)
 Test Files  24 passed (24)
      Tests  394 passed | 7 skipped (401)

$ node .gitnexus/run.cjs impact "broadcastEligible" --direction upstream --repo .
 risk: LOW · impactedCount: 4 · direct: 1 (monitor.mjs wrapper)
 (index đã refresh: 850 nodes / 2.026 edges / 61 flows)
```

**Kết luận tổng: 1 defect HIGH (money/liveness) + 3 phát hiện, và một bài học về test double.**
Vòng 1 kết luận R1 "đã sửa"; vòng này chứng minh **R1 không hoạt động trong production** (D1).

---

## 0. Vì sao vòng 1 bỏ sót — bài học phương pháp

Vòng 1 kiểm chứng R1 bằng 5 test xanh. Các test đó dùng double:

```js
getTransactionReceipt: async () => null,   // "null = không tìm thấy"
```

Nhưng `client` thật là viem, và viem **ném** `TransactionReceiptNotFoundError` khi JSON-RPC trả
`null` (`node_modules/viem/_esm/actions/public/getTransactionReceipt.js:32-33`). Double trả `null`
là hình dạng **không tồn tại** ở production ⇒ test xanh nhưng nhánh code không bao giờ chạy.
Đã kiểm chứng lại bằng client viem thật + transport giả trả `null`:

```text
$ node --input-type=module   # createPublicClient + custom transport: eth_getTransactionReceipt → null
getTransactionReceipt → NÉM LỖI: TransactionReceiptNotFoundError
getTransactionCount(latest) → 8 (kiểu: number)
```

⇒ Từ vòng này, nguyên tắc bổ sung: **double phải tái tạo đúng hình dạng lỗi của client thật**, và
mọi nhánh phụ thuộc "return null vs throw" phải có test cho cả hai hình dạng.

---

## D1 (HIGH, money/liveness) — cổng bằng chứng R1 không bao giờ chạy ở production

`presigned-broadcast.mjs:270-290`:

```js
let lookupFailed = false;
try { receipt = await client.getTransactionReceipt({ hash: txHash }); } catch { receipt = undefined; lookupFailed = true; }
const receiptMissing = !lookupFailed && receipt == null;   // ← LUÔN false với viem thật
```

Với viem, `receipt == null` không bao giờ xảy ra (viem đã ném trước đó), nên `receiptMissing` **luôn
false** ⇒ `releaseSuperseded()` **không thể chạy**. Nhánh tiếp theo là rebroadcast exact-bytes, mà
nonce đã bị tx khác tiêu thụ nên `sendRawTransaction` ném `nonce too low`, bị nuốt ở catch ngoài:

```text
[presign] broadcast error (claim retained): nonce too low
```

⇒ trạng thái đúng như trước fix R1: **claim kẹt vĩnh viễn, chặn cả bậc thang, webapp không ký lại
được (409) và không xoá được**, chỉ khác là nay có log/cảnh báo `stuck`… nhưng `stuck` chỉ bật khi
record thiếu `rawTx`/hash mismatch — nên ca này cũng không báo.

Bằng chứng trực tiếp — chạy production `broadcastEligible` với HAI client trên **cùng dữ liệu**
(claim nonce 7 đã quá ngưỡng recovery, `latest` nonce = 8 ⇒ nonce 7 đã bị tx khác tiêu thụ, cạnh đó là
rung nonce 8 hợp lệ):

```text
--- viem THẬT: getTransactionReceipt ném TransactionReceiptNotFoundError ---
[presign] broadcast error (claim retained): nonce too low
chu kỳ 1: a@7=broadcasting | nonce8=pending | sends=1 | r.superseded=false
chu kỳ 2: a@7=broadcasting | nonce8=pending | sends=2 | r.superseded=false
chu kỳ 3: a@7=broadcasting | nonce8=pending | sends=3 | r.superseded=false

--- double của test hiện tại: getTransactionReceipt trả null ---
[presign] claim 0x4290c44e… released as superseded (nonce 7): receipt for 0x20ee8f13… not found
           while the mined nonce advanced past 7 for 0x11111111…
chu kỳ 1: a@7=superseded | nonce8=pending | sends=0 | r.superseded=true
```

⇒ Với hình dạng client **thật**, claim không bao giờ được nhả, và mỗi chu kỳ lại gửi lại đúng bytes cũ
(vô ích, `nonce too low`). Nghĩa là **toàn bộ giá trị của R1 hiện chỉ tồn tại trong test**.
(Ghi chú: ở nhánh đối chứng, `nonce8` vẫn `pending` vì client giả của probe trả pending nonce = 7;
test (a) trong suite đã khẳng định riêng rằng khi pending nonce = 8 thì rung kế tiếp được claim.)

Phạm vi ảnh hưởng: chỉ dòng 272 (`presigned-broadcast.mjs`) — dòng 286 (best-effort sau rebroadcast)
catch rồi bỏ qua, không phụ thuộc phân loại lỗi. `proxy-dispatcher.mjs:230` cũng catch → `null`, và ở
đó trả `null` là **đúng** (JSON-RPC phải trả null cho ví).

**Hướng sửa (tối thiểu, đúng hợp đồng của viem):**

1. Phân loại lỗi thay vì coi mọi throw là "không có bằng chứng":

```js
let receipt; let receiptMissing = false;
try { receipt = await client.getTransactionReceipt({ hash: txHash }); }
catch (err) {
  // viem ném TransactionReceiptNotFoundError khi RPC trả null — ĐÓ là bằng chứng
  // "không có receipt cho hash này", KHÔNG phải lỗi mạng.
  receiptMissing = err?.name === "TransactionReceiptNotFoundError";
}
```

2. Test R1 phải dùng double ném đúng `TransactionReceiptNotFoundError`
   (`import { TransactionReceiptNotFoundError } from "viem"` — đã kiểm chứng export được), và giữ
   một test khẳng định lỗi mạng **khác** (vd `Error("socket hang up")`) vẫn fail closed.

3. **Hardening đề xuất (không bắt buộc trong cùng bước):** sau khi sửa, hai lần đọc
   (`getTransactionReceipt` và `getTransactionCount(latest)`) có thể rơi vào **hai endpoint khác
   nhau** do round-robin 11 URL (`rpc-client.mjs`) ⇒ hai góc nhìn không đồng nhất. Đề xuất bắt
   **hai chu kỳ liên tiếp cùng đồng ý** trước khi nhả (lưu `supersededEvidenceAt` ở lần quan sát đầu),
   hoặc đọc `getTransactionCount` sau khi đã xác nhận block `latest` lần hai. Không phải chặn release,
   vì tài sản không bị ảnh hưởng: nonce chỉ mine được một tx, nên giải phóng sớm **không thể** dẫn tới
   hai lệnh rút.

---

## D2 (MEDIUM-HIGH) — bundle "invalid" là kết cục im lặng và vĩnh viễn

`presigned-broadcast.mjs` phase 1: verify fail ⇒ `bundle.status = "invalid"`. `invalid` **không**
nằm trong `TERMINAL_STATUSES`, **không** phải `pending` ⇒ không bao giờ được thử lại, không bao giờ
hết hạn, **và không kích hoạt cảnh báo nào** (`alertOnLifecycle` chỉ xử lý
`superseded|conflict|stuck`).

Bằng chứng (production, registry thật, tx ký thật):

```text
$ node --input-type=module
chu kỳ 1 (config lệch — vd operator đổi LENDER_ADDRESS/MORPHO_BLUE_ADDRESS trong .env):
  status: invalid | error: bundle.lenderAddress !== config lender
  broadcastEligible trả về: null            ← không có gì để cảnh báo
  sendRawTransaction đã gọi: 0 lần
chu kỳ 2 (config đã đúng lại): status: invalid | trả về: null | đã gửi: 0
chu kỳ 3 (config đã đúng lại): status: invalid | trả về: null | đã gửi: 0
⇒ bundle ký hợp lệ bị KẾT VĨNH VIỄN: true
```

Tác động: mọi bundle đang `pending` bị đánh `invalid` **im lặng** khi có lệch cấu hình (đổi
`LENDER_ADDRESS`/`MORPHO_BLUE_ADDRESS`, deploy nửa vời, registry copy giữa hai môi trường). Người
dùng phải tự để ý badge `invalid` trong ladder rồi xoá + ký lại toàn bộ — đúng lớp "bậc thang ngừng
tiến mà monitor im lặng" mà R1 vừa được thêm để chống.

Hướng sửa: coi `invalid` là **trạng thái cần người xử lý** — thêm `kind: "invalid"` vào
`lifecycle-alert.mjs` (đã có sẵn cooldown theo `(kind, id)`), và cho `alertOnLifecycle` báo khi một
chu kỳ vừa chuyển bundle sang `invalid`. Tuỳ chọn mạnh hơn: chỉ đánh `invalid` khi lỗi verify là
*thuộc về nội dung bundle* (sai marketId/nonce/amount/onBehalf) — còn lệch **config**
(`bundle.lenderAddress !== config lender`, Morpho address) thì giữ `pending` + cảnh báo, vì đó là
lỗi cấu hình của operator, không phải bundle hỏng.

---

## D3 (MEDIUM) — relay JSON-RPC của proxy mở hoàn toàn, kể cả khi đã đặt `WEBAPP_PASSWORD`

`requireLenderOrInternal` chỉ được gọi cho `/bundle`, `GET /captured`, `DELETE /captured`. Nhánh
JSON-RPC (`POST /`) **không** kiểm tra gì — và điều đó là *bắt buộc về mặt kỹ thuật* (MetaMask không
gửi được header `Authorization`). Nhưng `eth_call`/`eth_getLogs`/`eth_feeHistory`/
`eth_getBlockByNumber`/`eth_getCode`/`eth_getStorageAt`/`eth_getTransactionCount` được **forward**
sang `RPC_URLS` của operator.

Bằng chứng (handler production, `WEBAPP_PASSWORD` đã set):

```text
GET /captured (không auth, ĐÃ set password) → 401        ← auth hoạt động (đúng)
eth_blockNumber (không auth, ĐÃ set password) → 200      ← relay MỞ
eth_call forward (không auth)                 → 200      ← dùng RPC/API key của operator
```

Trong khi đó: `docker-compose.yml` publish `8545:8545`, và `.env.example` hướng dẫn
`PROXY_HOST=0.0.0.0` cho MetaMask mobile, kèm dòng "# /bundle và /captured yêu cầu Bearer lender
hoặc Basic WEBAPP_PASSWORD" — dễ đọc thành "đặt password là proxy an toàn", trong khi bề mặt chính
(relay) vẫn mở. Thông báo fail-fast của R3 cũng viết "Đặt WEBAPP_PASSWORD… hoặc bind loopback", hàm ý
tương tự.

Không có rủi ro mất tiền: capture **chỉ** ghi vào buffer, không bao giờ forward/broadcast; capture lại
gate `from === LENDER_ADDRESS` + đúng Morpho `withdraw` + market trong allow-list (đã kiểm chứng:
raw tx lạ ⇒ `-32603`, không vào buffer). Rủi ro thật là **lạm dụng tài nguyên**: dùng hạ tầng RPC
(quota/API key/IP của operator) như một node công cộng.

Hướng sửa (chọn 1 hoặc nhiều): (a) nói thẳng trong `.env.example`, trong cảnh báo public-bind của
`assertProxyAuthConfig` và trong CLAUDE.md rằng relay là mở theo thiết kế + hệ quả; (b) rate-limit
theo IP cho nhánh JSON-RPC (đã có sẵn tiền lệ `challengeRateLimit` ở webapp); (c) khi bind public,
chỉ forward một allow-list method rẻ tiền, hoặc yêu cầu opt-in tường minh kiểu
`PROXY_ALLOW_PUBLIC_RPC=1`.

---

## D4 (LOW) — bản vá F1 vá thiếu một thứ tự key, để lại rung trùng identity

`webapp-handler.mjs` (POST /api/presign): khi dọn bản sao identity, nó lấy `sameIdentity[0]` làm
`target` và **bỏ qua** bản sao đang `broadcasting`. Nếu bản ghi `broadcasting` đứng **sau** bản
`pending` (đúng thứ tự file mà bug tra-key trước F1 tạo ra: key legacy trước, key composite sau), thì
`target` là bản `pending` ⇒ ghi merged vào key pending, **không** xoá bản `broadcasting` ⇒ còn 2 bản
cùng identity.

Bằng chứng (handler production trên HTTP thật):

```text
$ node --input-type=module
seed: [ marketId ] = pending (legacy key)   |   [ marketId@7 ] = broadcasting (composite key)
POST /api/presign → 200 {"ok":true,"action":"merged (1 updated)"}
registry sau POST — số bundle: 2
  key=0xe8a358ee28… status=pending     nonce=7 tiers=1 amounts=70000000000
  key=0xe8a358ee28… status=broadcasting nonce=7 tiers=1 amounts=50000000000
=> rung trùng identity còn tồn tại: true (2 bản)
```

Hệ quả: `nonceRounds` trả 2 entry cùng identity ⇒ webapp hiện **cảnh báo race giả** ("hai bundle
hoạt động cùng nonce") cho cùng một market — đúng triệu chứng mà F1 sinh ra để xoá. Không có rủi ro
tiền: broadcaster chỉ claim bundle `broadcasting` và `byNonce` đếm đúng 1 claim; bản `pending` thừa
sẽ tự `expired` khi nonce bị tiêu thụ.

Hướng sửa: chọn `target` = bản `broadcasting` nếu có (rồi để lifecycle guard trả 409 — hành vi đúng
khi user cố ký lại nonce đang được claim), ngược lại bản đầu tiên; và xoá **mọi** bản sao khác
identity không phải target. Thêm test cho cả hai thứ tự key.

---

## Đã kiểm tra và KHÔNG phải lỗi (ghi lại để khỏi audit lại)

* `verifyBundle` chạy **trong file lock** ở phase 1 nhưng là **thuần crypto** (`parseTransaction`,
  `decodeFunctionData`, `recoverTransactionAddress`, `keccak256`) — không có I/O mạng trong lock.
* Cổng bằng chứng R1 (khi được chạy) **đúng logic**: `blockTag: "latest"` (không phải `pending`),
  nonce hữu hạn, lỗi ⇒ fail closed; nonce không thể nhảy nên `latest > claimNonce` + thiếu receipt
  ⇒ tx của claim vĩnh viễn không mine được.
* `releaseSuperseded` xoá `rawTx` nhưng giữ `withdrawals`, nonce vẫn tiêu thụ vĩnh viễn, `superseded`
  nằm trong `TERMINAL_STATUSES`; `PROTECTED_STATUSES` vẫn chỉ `["broadcasting"]` ⇒ user xoá được.
* F4 (dùng `claim.bundle.nonce` thay pending nonce) và F3 (guard `?nonce` trên market nhiều rung) đọc
  lại vẫn đúng trên cây hiện tại.
* R2 (nút ✕ theo rung + `selectBestWithdrawal` chọn lớn nhất ≤ liquidity) và R3 (fail-fast trước khi
  mở port; loopback vẫn chạy dev) đã kiểm chứng lại bằng tiến trình thật.
* `GET /captured` trả 200 trong probe đầu là **dev mode của `.env` local** (`WEBAPP_PASSWORD=""`),
  không phải lỗi: set password ⇒ 401. Đã xác nhận.
* `eth_sendRawTransaction` không phải vector di chuyển tiền: handler chỉ `push` vào `capturedTxs`,
  không bao giờ `sendRawTransaction`; tx lạ bị từ chối.
* `monitor-triggers.mjs` (scheduler + WSS watcher: generation fence, partial cleanup, rotation theo
  URL đã fail), `wss-connect.mjs` (`getRpcClient().close()` thật), `market-reader.mjs` (multicall
  cùng block, `allowFailure`), `notification-dispatch.mjs`, `market-config.mjs`, `webapp-server.mjs`
  — không thấy defect.
* Nhánh này **không sửa** `rpc-client.mjs`; ghi nhận (không phải finding): outer `retryCount: 1` × 9
  URL × (`retryCount: 1`, timeout 15s) nghĩa là một lệnh RPC xấu nhất có thể kéo dài vài phút trước
  khi lỗi — chấp nhận được vì có polling, nhưng đáng biết khi debug "monitor đứng".

---

## Kế hoạch đề xuất (theo thứ tự)

> **Trạng thái: P1–P4 đã xong** — bằng chứng sau fix ở [§8](#8-xử-lý-d1d4-đã-làm-xong-2026-09-24). P5 hoãn
> (rủi ro liveness, không phải money).

| # | Việc | Ghi chú |
| --- | --- | --- |
| P1 | Sửa D1: phân loại `TransactionReceiptNotFoundError` là **bằng chứng**, generic error vẫn fail closed; cập nhật 2 test R1 sang double viem-shaped + 1 test lỗi mạng | `presigned-broadcast.mjs` (+ `__tests__/presigned-lifecycle.test.mjs`); impact `broadcastEligible` = LOW |
| P2 | Sửa D2: cảnh báo lifecycle cho `invalid` (kind mới) + chỉ `invalid` khi lỗi thuộc nội dung bundle, lệch config thì giữ `pending` | `presigned-broadcast.mjs`, `monitor.mjs`, `lifecycle-alert.mjs` (+ test) |
| P3 | Sửa D4: chọn `target` ưu tiên bản `broadcasting`, xoá mọi bản sao khác; test cả hai thứ tự key | `webapp-handler.mjs` (+ `presigned-api`/`presigned-merge-nonce` test) |
| P4 | D3: quyết định chính sách — (a) tài liệu hoá relay mở, (b) rate-limit IP, (c) opt-in `PROXY_ALLOW_PUBLIC_RPC=1` | cần owner quyết định; (a) là tối thiểu |
| P5 | Hardening tuỳ chọn: 2 chu kỳ đồng thuận trước khi nhả `superseded` (round-robin nhiều node) | sau P1 |

Bất biến không đổi trong mọi bước: claim durable trước I/O, chỉ receipt có block identity mới cho
terminal, `keccak256(rawTx) === txHash` trước rebroadcast, tối đa 1 claim/nonce, guard `origin:"user"`
là chốt cuối.

---

## 8. Xử lý D1–D4 (đã làm xong, 2026-09-24)

| # | Commit | Nội dung |
| --- | --- | --- |
| D1 | `0cdc164` | `presigned-broadcast.mjs`: `TransactionReceiptNotFoundError` được coi là **bằng chứng** "không có receipt"; lỗi khác vẫn fail closed. 2 test R1 đổi sang double đúng hình dạng viem + 1 test transport trả `null` + 1 test lỗi mạng |
| D2 | `e069b5f`, `7e3011b` | `presign-verify.mjs` thêm `code` (`CONFIG_*` vs `BUNDLE_INVALID`) — chỉ **thêm** field vào nhánh lỗi; broadcaster giữ `pending` khi lệch `.env`, chỉ `invalid` khi lỗi thuộc nội dung; `lifecycle-alert.mjs` +2 kind; `monitor.mjs` cảnh báo theo `problems[]` |
| D4 | `4955446` | `webapp-handler.mjs` chọn target ưu tiên bản `broadcasting`, 409 khi nonce đang được claim, dọn mọi bản sao khác identity; test cả hai thứ tự key |
| D3 | `f934485` | Chọn phương án (a): cảnh báo + tài liệu hoá. `assertProxyAuthConfig` trả `warning` khi public bind **có** mật khẩu; `CLAUDE.md` + `.env.example` |
| chốt | (chính file này) | Báo cáo kết quả sau fix, refresh index, gate cuối |

### D1 — bằng chứng sau fix (chạy trên code production)

Cùng dữ liệu như phản chứng ở §D1 (claim nonce 7 quá ngưỡng, `latest` nonce = 8, rung `b@8` hợp lệ),
chạy 3 chu kỳ `broadcastEligible` với **hai hình dạng client**:

```text
--- viem THẬT (ném TransactionReceiptNotFoundError) ---
[presign] claim a@7 released as superseded (nonce 7): receipt for 0xc7f2fdca… not found while the mined nonce advanced past 7 for x… — the next rung may now be claimed; verify on-chain before deleting
chu kỳ 1: a@7=superseded | nonce8=pending    | sends=0 | r.id=a@7 | r.superseded=true
[presign] claiming b@8 (market b, nonce 8, tier next)
[presign] broadcast submitted market=b txHash=0xf2ee15ea… tier=next nonce=8
chu kỳ 2: a@7=superseded | nonce8=submitted | sends=1 | r.id=b@8 | r.superseded=undefined
chu kỳ 3: a@7=superseded | nonce8=submitted | sends=1 | r.id=undefined | r.superseded=undefined

--- transport tự viết (trả null) ---
(y hệt: nhả ở chu kỳ 1, sends=0, chu kỳ 2 claim b@8)
```

So với trước fix (`sends` tăng đều 1→2→3, `a@7` kẹt `broadcasting`, `b@8` không bao giờ được claim),
R1 lần đầu tiên **hoạt động ở production**, và bậc thang tiến lên ngay chu kỳ sau.

### D2 — bằng chứng sau fix (`pending` tự khỏi, `invalid` không)

```text
A)  lệch .env      → status=pending  | problems=[{"id":"a@7","marketId":"a","nonce":7,"kind":"config","error":"onBehalf … !== lender 0x9999…"}]
A2) .env đúng lại  → status=broadcasting | verifyError=undefined        ← tự khỏi, không cần thao tác tay
B)  bundle hỏng    → status=invalid  | problems=[{"id":"a@7","marketId":"a","nonce":7,"kind":"invalid","error":"function transfer !== withdraw"}]
B2) verify ok lại  → status=invalid  (đúng: invalid là terminal theo NỘI DUNG — nay đã có cảnh báo)
```

Điểm quan trọng: `problems` được gắn vào **mọi** kết quả (kể cả `null`), nên một chu kỳ chỉ toàn bundle
hỏng vẫn không im lặng.

### D4 — bằng chứng sau fix

4 test trong `__tests__/presigned-merge-nonce.test.mjs`: bản sao `broadcasting` đứng sau / đứng trước bản
`pending` (đều 409, registry nguyên vẹn), hai bản sao đều `pending` (hợp nhất còn một rung), và F1 gốc.
Trước fix, chính seed "broadcasting đứng sau" trả **200 kèm 2 rung cùng identity** (§D4).

### D3 — bằng chứng sau fix (process thật)

```text
$ PROXY_HOST=0.0.0.0 WEBAPP_PASSWORD=s3cret MARKETS_FILE=./config/__nope.json node proxy-rpc.mjs
⚠️  PROXY_HOST=0.0.0.0 (public): WEBAPP_PASSWORD chỉ bảo vệ /bundle và /captured (lender).
   JSON-RPC (eth_call, eth_getLogs, eth_feeHistory…) KHÔNG xác thực được — ví không gửi được
   header Authorization — nên ai vào được port này cũng forward được sang RPC_URLS của bạn
   (tốn quota/API key, request mang IP của bạn). Capture thì vẫn chỉ nhận tx từ LENDER_ADDRESS.
   → Giới hạn bằng firewall / IP allow-list, hoặc chỉ mở port khi cần MetaMask mobile.

$ PROXY_HOST=127.0.0.1 WEBAPP_PASSWORD=s3cret … node proxy-rpc.mjs
(im lặng — đúng)
```

Impact của `assertProxyAuthConfig` (gitnexus): **LOW**, một caller duy nhất (`proxy-rpc.mjs`), 0 process.

### Gate cuối

```text
$ npm run check
 Found 12 warnings and 0 errors.          # 12 warning đều nằm trong __tests__ — không tăng so với baseline
 ✅ node --check: 49/49 target OK (47 file .mjs + webapp.html inline)
 Test Files  24 passed (24)
      Tests  419 passed | 7 skipped (426)

$ node .gitnexus/run.cjs detect-changes --scope all --repo .
 Changes: 4 files, 6 symbols | Affected processes: 0 | Risk level: low      # không partial/truncated

$ node .gitnexus/run.cjs analyze --index-only
 904 nodes | 2,093 edges | 34 clusters | 61 flows
```

Chuỗi test qua cả hai vòng audit: `356` → `394` → **`419`** (+63, 24 file, 7 skip luôn là block ntfy live).

### Không làm (và vì sao)

- **P5 hardening** (2 chu kỳ đồng thuận trước khi nhả `superseded`): hoãn. Rủi ro của việc nhả sớm là
  *liveness*, không phải *money* — nonce chỉ mine được một tx nên nhả sớm **không thể** tạo hai lệnh rút.
- **Đóng relay JSON-RPC** (rate-limit / opt-in `PROXY_ALLOW_PUBLIC_RPC=1`): đã chọn phương án (a) ở Bước 4.
  Vẫn là việc mở nếu sau này proxy lộ ra Internet.
- **`webapp.html` được kiểm cú pháp nhưng không được lint** (oxlint chỉ quét `.mjs`): debt đã ghi nhận.

### Rủi ro còn lại (ghi để không bị đọc nhầm là "sạch tuyệt đối")

1. Đường nhả `superseded` được chứng minh bằng unit test + probe client giả đúng hình dạng viem, **chưa**
   và không thể xác minh an toàn bằng một claim kẹt thật trên mainnet.
2. `invalid` vẫn là terminal với lỗi nội dung (đúng chủ ý: verify là hàm thuần, chạy lại cũng sai như vậy) —
   khác biệt so với trước là nay **có cảnh báo**.
3. `.env.example` dòng giới hạn market (do người dùng sửa tay) vẫn chưa được commit.
