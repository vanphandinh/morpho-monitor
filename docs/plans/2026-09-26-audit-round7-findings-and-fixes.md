# Vòng 7 — Audit toàn diện + hai defect thật + drill đường tiền 3 tiến trình (2026-09-26)

Repo: `morpho-monitor` · Nhánh: `feat/multi-market-monitor` · Cây làm việc trên `6dec4e2`
(**68 commit chưa đẩy lên `origin/main` tại thời điểm audit** — nhưng ngược với điều tôi tưởng lúc
đó, CI **đã** chạy xanh trên chính nhánh này từ 2026-09-25; §8 đính chính bằng API).

Vòng này khác sáu vòng trước ở một điểm: nó **không** bắt đầu bằng kế hoạch, mà bằng một audit
đối kháng trên cây hiện tại, và kết luận của audit bị chính các bước sau đó **bác một phần**
(§5). Nguyên tắc giữ nguyên của repo: mỗi khẳng định phải có **đỏ-trước chạy thật**, test mới
phải import **production**, cổng cuối là `npm run check`.

---

## 1. Điểm 4 chiều (trước khi sửa → sau khi sửa)

| Chiều | Trước | Sau | Vì sao |
| --- | --- | --- | --- |
| SPEC | 7 | **7** | Không thêm tính năng; hai bản vá là sửa lỗi + tài liệu. Điểm trừ giữ nguyên: các "Required audit checks" #3–#5 của spec (`2026-09-22-multi-market-monitor.md`) vẫn cần môi trường thật (RPC/WSS/ví), và CI — cổng chính của vòng 6 — vẫn chưa từng thực thi. |
| DESIGN | 8 | **8** | Hai bản vá rơi đúng chỗ sở hữu: trần thân request ở `readBodyLimited` (một cổng cho cả 5 call site), quy tắc vô hiệu chữ ký ở `webapp-presign.mjs`. Nhưng `webapp-handler.mjs` (611 dòng) vẫn trộn định tuyến/auth với thuật toán merge ladder — điểm trừ cũ không đổi. |
| CORRECTNESS | 7 | **8** | Hai defect **tái hiện được** đã đóng, mỗi cái có test đỏ-trước, và đường tiền nay có drill chạy cả chuỗi trên HTTP thật (§4). Chưa lên 9: RPC/WSS thật, ký bằng ví thật và CI vẫn chưa được chạy. |
| QUALITY | 8 | **8** | Nhánh 413 từ code-chết thành code-chạy-được; drift tài liệu (ABI, `.env.example`) đã sửa. Nhưng vòng này **thêm** ~250 dòng test + một file tài liệu nữa vào đúng chỗ đang phình (`docs/plans` 218 KB) — nợ văn bản không giảm. |

---

## 2. D13 (MEDIUM — hành vi) — 413 không bao giờ tới client

**Triệu chứng.** Thân request vượt `MAX_BODY_BYTES` (mặc định 1 MiB) làm **socket bị huỷ trước
khi response được ghi**: client chỉ thấy `ECONNRESET`, còn nhánh 413 ở `webapp-handler.mjs` (×3)
và `proxy-dispatcher.mjs` (×2) là **code không thể chạy**. Cả 5 nhánh đều nằm sau
`readBodyLimited()` → `req.destroy()`.

**Vì sao lọt sáu vòng:** không có test nào chạm nhánh này — `grep -rn "PAYLOAD_TOO_LARGE\|413\|maxBodyBytes" __tests__ scripts` = **0 kết quả**; `req` giả trong `proxy-rpc-limits.test.mjs`
còn cấp `req.destroy = () => {}`, đúng thứ che mất hành vi thật.

**Đỏ-trước (đã chạy, ba bề mặt thật):**

```text
$ npx vitest run __tests__/shared.test.mjs __tests__/proxy-capture.test.mjs __tests__/presigned-api.test.mjs
 FAIL  presigned-api.test.mjs > thân vượt MAX_BODY_BYTES ⇒ 413 JSON…
       TypeError: fetch failed     Caused by: Error: read ECONNRESET
 FAIL  proxy-capture.test.mjs > (e) thân quá lớn: trả 413 JSON…
       TypeError: fetch failed     Caused by: SocketError: other side closed (bytesRead: +0)
 FAIL  shared.test.mjs > readBodyLimited() > thân vượt trần: client nhận 413…
       AssertionError: client thấy lỗi mạng thay vì 413: expected 'ECONNRESET' to be undefined
 Tests  3 failed | 120 passed (123)
```

**Sửa.** `readBodyLimited` không huỷ socket khi phát hiện quá cỡ nữa: bỏ phần đã buffer (O(1) bộ
nhớ), **hút tiếp** phần còn lại tới hết — hoặc tới `maxBytes + DRAIN_GRACE_BYTES` (4 MiB) — rồi
mới reject, để caller ghi 413 lên một kết nối đã sạch. Vượt cả hạn hút-thêm ⇒ cắt kết nối: đây
là nhánh **duy nhất** còn `destroy()`, ghim bằng ca thứ ba của test (client nhận lỗi mạng, có chủ
ý). Client nhỏ giọt mãi không kết thúc do `requestTimeout` mặc định của Node cắt.

```text
$ npx vitest run __tests__/shared.test.mjs __tests__/proxy-capture.test.mjs __tests__/presigned-api.test.mjs
 Test Files  3 passed (3)      Tests  123 passed (123)
```

---

## 3. D14 (MEDIUM — hành vi) — đổi gas không vô hiệu chữ ký

**Triệu chứng.** `autoFillGas()` là đường **duy nhất** ghi `presignedGas` mà không đi qua cổng vô
hiệu chữ ký: nó gán phí mới rồi mới ghi ra ô nhập. Người dùng bấm "Tự Động Gas" lần nữa sau khi
đã ký ⇒ ô nhập hiện phí MỚI, chữ ký các mốc vẫn `signed`, và byte đã ký vẫn mang phí CŨ — bundle
lưu lên có thể trộn nhiều mức phí, không gì trong UI nói ra điều đó. Tier được chọn để broadcast
(lớn nhất ≤ thanh khoản) có thể là tier phí cũ ⇒ tx không vào bảng ⇒ claim kẹt hết cửa sổ
recovery trước khi tự nhả. Đây đúng là lớp lỗi **D12** vừa sửa, nhưng ở đường còn lại.

**Vì sao lọt:** trace đóng băng không có bước này (`auto-fill-gas` là bước 8, mọi bước ký từ 11);
`webapp-flows.test.mjs` khi đó ghi thẳng rằng `autoFillGas` "ghi thẳng `presignedGas` rồi mới ghi
ra ô nhập" — tức hành vi đã được biết nhưng chưa bị coi là lỗi.

**Đỏ-trước (đã chạy).** Mở rộng harness/scenario (dưới đây) rồi bấm Tự Động Gas lần nữa với phí
MỚI (priority 2 gwei thay vì 1 gwei). Nhãn test lúc chạy đỏ còn tạm là `D13`; đổi thành `D14` trước
khi commit để không trùng số với defect 413 ở §2 — khối dưới in **nguyên văn** nhãn tạm đó:

```text
 FAIL  webapp-flows.test.mjs > D13: bấm Tự Động Gas SAU khi ký + phí ĐỔI ⇒ chữ ký phải bị vô hiệu
 AssertionError: expected '<div class="banner success">✅ Đã lưu 2 giao dịch…' to contain 'Gas đã thay đổi'
 Tests  1 failed | 1 passed | 21 skipped (23)
```

(Thay đổi kịch bản, cần cho red-first — cả hai đều là **harness**, không phải production:

- `helpers/webapp-harness.mjs`: phí gas của RPC giả thành fixture mutable + `setGas()`;
- `helpers/webapp-scenario.mjs`: tuỳ chọn `autoGasAfterSign` (bước `auto-gas-after-sign`), mặc
  định `null` nên trace chính giữ nguyên 19 bước;
- `webapp-flows.test.mjs`: hai ca âm/dương.)

**Sửa.** `autoFillGas` so **trước** khi gán (cùng nguyên tắc `gasValuesChanged` của
`onGasInputChange`) rồi mới gọi `invalidateSignatures`; phí không đổi thì **giữ** chữ ký.

```text
$ npx vitest run __tests__/webapp-flows.test.mjs
 ✓ D12: gas THỰC SỰ đổi thì chữ ký vẫn bị vô hiệu (không tắt bảo vệ)
 ✓ D14: bấm Tự Động Gas SAU khi ký + phí ĐỔI ⇒ chữ ký phải bị vô hiệu
 ✓ D14: bấm Tự Động Gas SAU khi ký nhưng phí KHÔNG đổi ⇒ GIỮ chữ ký (ca âm)
 ✓ kịch bản hiện tại tái tạo đúng trace đã đóng băng
 Test Files  1 passed (1)      Tests  23 passed (23)
```

**Fixture KHÔNG phải đóng băng lại** — điều này là bằng chứng, không phải tiện lợi: cả 19 bước của
đường tiền chính vẫn khớp **từng byte** fixture cũ, tức bản vá chỉ chạm đường mới
(`auto-gas-after-sign`), không đổi hành vi đường tiền hiện có.

Đối chiếu độc lập với cây trước khi tách module (mặc định `--base ee43de6`):

```text
$ npm run diff:refactor
  cũ : 19 bước · 46 lời gọi (eth_sendTransaction=5, POST /api/bundle=2, DELETE /api/presign=1)
  mới: 19 bước · 46 lời gọi (eth_sendTransaction=5, POST /api/bundle=2, DELETE /api/presign=1)
❌ 12 khác biệt: sign-withdraw-all (banner), save-to-server-all-shares (1 → 3 giao dịch),
   delete-tier (readonly) — tất cả đều là hệ quả D12 đã báo ở vòng 6
```

Đọc đúng con số: **số bước và số lời gọi y hệt** ở cả hai cây, và 12 khác biệt nêu trên thuộc
D12 (cây cũ chưa có bản vá đó) — không có khác biệt nào đến từ vòng 7. Đối chiếu *đúng* cho vòng
này là fixture đã đóng băng ở HEAD (test trong `webapp-flows.test.mjs`), và nó xanh từng byte.

---

## 4. P4 — Drill đường tiền xuyên 3 tiến trình (`__tests__/money-path-e2e.test.mjs`)

Lỗ hổng lớn nhất mà audit tìm ra không phải một dòng code sai, mà là một **seam chưa từng chạy**:
mọi mảnh của đường tiền đều đã được chứng minh *riêng*, nhưng chưa có gì chạy **cả chuỗi** trên
các tiến trình thật — và đúng hai defect ở §2/§3 sống ở giữa các mảnh đó. Trước vòng này, kể cả
`proxy-capture.test.mjs` cũng cấu hình `webappUrl: "http://127.0.0.1:1"`, tức **chưa bao giờ**
relay thật sang webapp.

Drill chạy, không mock tầng production nào:

```text
ví ký withdraw() thật → eth_sendRawTransaction → PROXY (http.Server thật, capture gate thật)
  → POST /bundle → ghép tier ↔ signed tx đã capture → WEBAPP (http.Server thật: verify calldata,
    ghi registry v3 qua file lock)
  → broadcastEligible() THẬT: claim rung ở nonce pending → gửi đúng byte đã ký lên chain giả
    → receipt có block identity → submitted + rung cùng nonce expired
  → chu kỳ sau: registry idle, không broadcast lần hai
```

Khẳng định trên **artifact**: `fakeChain.sent` (đúng 1 tx, **bằng đúng byte ví đã ký**), file
registry trên đĩa (`submitted` + `terminalAt`, `rawTx` đã xoá, rung cùng nonce `expired`,
`consumedNonce`), và số lần gửi ở chu kỳ thứ hai.

**Đỏ-khả-năng (đã chạy thật):** phá seam giữa proxy và webapp — POST sang webapp với
`withdrawals: []`:

```text
AssertionError: {"ok":false,"error":"Server rejected: Invalid bundle: withdrawals empty"}: expected 502 to be 200
Tests  1 failed | 1 passed (2)
```

Phục hồi ⇒ `Money-path 2 passed`, chạy lẻ trong **182 ms** (trong `npm run check` đầy đủ: 474 ms).

**Chốt tự kiểm:** file đặt `LENDER_ADDRESS` (khoá test) TRƯỚC khi import handler, và có một test
khẳng định `LENDER_ADDRESS === ví test` — nếu ai đó đổi cấu hình sang không-isolate hoặc thêm lại
import tĩnh kéo `shared.mjs`, drill sẽ **ĐỎ vì lý do sai** thay vì xanh mù.

---

## 5. Đính chính chính audit này (ghi thẳng)

1. **"13 biến env không có trong `.env.example`" là SAI.** Đúng là **4**:
   `PUBLIC_RPC_URLS`, `MAX_BODY_BYTES`, `SESSION_EXPIRY_HOURS`, `CHALLENGE_EXPIRY_MINUTES`. Lỗi
   của tôi: chỉ `grep '^[A-Z_]+'` nên bỏ qua các dòng **comment** (`# PROXY_HOST=0.0.0.0`,
   `# PROXY_RPC_RATE_LIMIT=600`, `# VOIP_*`, `# WEBAPP_ALLOW_INSECURE=1`, `# WSS_DEBOUNCE_MS=…`),
   đúng quy ước của file cho knob tuỳ chọn. Đã sửa bằng phép đếm chặt (`grep -c <TÊN>`).
2. **Finding còn lại của §5.1 thì thật, và nặng hơn cái tôi tưởng:** `.env.example` vẫn nói
   `RPC_URLS` "được inject vào browser qua window.MORPHO_CONFIG.rpcUrls" — tức **ngược** với lượt
   sửa bảo mật của audit vòng 4 (round-4 quota), và `PUBLIC_RPC_URLS` (bản duy nhất thật sự đi
   vào browser) thì không được nhắc tới. Một người triển khai theo file này sẽ tin rằng key phải
   nằm trong `RPC_URLS` *để browser dùng*, trong khi thực tế `webapp-config.mjs` fail-fast khi
   thấy URL có credential trong danh sách browser.
3. **`CLAUDE.md` tự mâu thuẫn về ABI** (đã sửa): dòng 98 ghi "no duplicate ABI", dòng 316 ghi
   `verify-presigned.mjs` duplicate và "same ABI is also in `webapp.html`". Sự thật: ABI nằm ở
   `presign-verify.mjs` **và** `webapp-state.mjs`; `verify-presigned.mjs` import bản dùng chung;
   `webapp.html` không còn JS inline. Số test trong `CLAUDE.md` cũng đã cập nhật (566/38).

**Đã sửa:** 4 biến còn thiếu + cảnh báo credential cho `PUBLIC_RPC_URLS` + trần `MAX_BODY_BYTES`
(số byte + hành vi 413/hút-thêm) vào `.env.example`; mục ABI và số test vào `CLAUDE.md`. Diff
`.env.example` = **26 thêm / 4 xoá**, không đổi line-ending (index blob là LF, `core.autocrlf=true`).

---

## 6. Cổng cuối vòng

```text
$ npm run check
 Found 0 warnings and 0 errors.
 [lint] ✅ độ phủ: oxlint quét 87 file .mjs (git theo dõi 87 file, phạm vi ".")
 ✅ node --check: 85/85 target OK (79 file .mjs + webapp.html no-inline-module)
 Test Files  38 passed (38)
      Tests  559 passed | 7 skipped (566)

$ node .gitnexus/run.cjs detect-changes --scope all --repo .
 Changes: 10 files, 5 symbols · Affected processes: 2 · Risk level: medium
 (không có partial/truncated)
  • CreateProxyRequestHandler → Fail (3 steps) — changed: fail, readBodyLimited
  • Handler → Fail (3 steps)            — changed: fail, readBodyLimited
```

`impact` trước khi sửa (AGENTS.md): `readBodyLimited` → **LOW**, 3 caller (webapp-handler,
proxy-dispatcher, proxy-rpc); `autoFillGas` → **UNKNOWN**, xác nhận bằng text search: caller thật
là `onclick="autoFillGas()"` ở `webapp.html:394` qua `window.autoFillGas` (`webapp-app.mjs:373`),
tức index không phân giải được DOM attribute — đúng ca `UNKNOWN` mà AGENTS.md nói phải kiểm tay.

Cổng lint còn tự bắt lỗi của chính vòng này: một `import { MAX_BODY_BYTES }` thừa trong test
⇒ `Found 1 warning` ⇒ `npm run check` **đỏ** ở bước lint (đã xoá).

---

## 7. Còn mở (đọc để không tưởng là "sạch tuyệt đối")

1. ~~**CI chưa từng chạy — vòng này kết thúc bằng lần push ĐẦU TIÊN**~~ **SAI — tự đính chính ở §8.**
   Tôi suy từ `git rev-list --count origin/main..HEAD` (68) ra "chưa push gì cả", mà quên rằng đích
   của lần push này là nhánh feature, không phải `main`. Sự thật (API công khai, §8): nhánh đã được
   push và PR #1 đã mở TRƯỚC vòng 7; CI đã chạy 10 run cho nhánh này trước lần push của vòng 7, run
   mới nhất cho `6dec4e2` kết thúc `success`.
   Điều còn đúng: mọi tuyên bố "CI sẽ bắt" ở các vòng 5–6 là suy luận chứ không phải quan sát — nhưng
   giờ nó **đã** được quan sát: SHA của vòng 7 (`95cba80`) xanh trên cả 2 run và 5/5 job (§8).
2. **RPC/WSS thật, ví thật, ntfy live chưa được chạy trong vòng này**; drill dùng chain giả nên
   nó chứng minh *chuỗi logic + hợp đồng HTTP*, không chứng minh được mạng thật.
3. `webapp-handler.mjs` vẫn giữ thuật toán merge ladder trong route handler — merge/dedup/409
   chỉ test được xuyên HTTP.
4. Tài liệu vẫn phình (`docs/plans` ≈ 218 KB/11 file); vòng này thêm một file nữa.

---

## 8. Đính chính CI (sau push — bằng chứng từ GitHub API)

Cả §7.1 của doc này lẫn §7.2 của doc vòng 6 (`2026-09-25-round6-plan-and-findings.md`) đều khẳng
định "CI chưa từng chạy". Sau khi push, truy vấn API công khai của repo (không cần auth — repo
public) cho thấy khẳng định đó **SAI**. Lệnh đã chạy:

```text
GET /repos/vanphandinh/morpho-monitor/actions/runs?branch=feat/multi-market-monitor
  total_count = 12   (6 run do `push` + 6 run do `pull_request`)

GET .../actions/runs/36176531698            # run #10, head_sha = 6dec4e2 (HEAD của vòng 6)
  event=pull_request · created_at 2026-09-25T18:55:55Z · conclusion=success

GET .../commits/6dec4e2/check-runs
  total_count = 10 (2 run × 5 job) · job "image · build + smoke" success lúc 2026-09-25T18:57:21Z
```

Nghĩa là: PR #1 (`feat/multi-market-monitor` → `main`, còn **open**) đã tồn tại trước vòng 7, nhánh
đã được push, và CI đã chạy xanh cho `6dec4e2` từ **trước** vòng này. Đây là lỗi suy luận của tôi ở
§7.1/§7.2, không phải một điều kiện môi trường.

CI cho chính vòng 7 (SHA `95cba80`, sau lần push đầu tiên của vòng):

```text
run #11  event=push           id 36218243697  created 2026-09-26T04:34:39Z  conclusion=success
run #12  event=pull_request   id 36218245849  created 2026-09-26T04:34:42Z  conclusion=success
  → 5 job/run: gate · ubuntu · node 20/22, gate · windows · node 20/22, image · build + smoke
  → kiểm trực tiếp: 2 job gate đầu của run #12 (ubuntu/node20, windows/node20) success;
    check-run "image · build + smoke" trên `95cba80` success lúc 2026-09-26T04:36:10Z
```

Điều này không làm yếu bản vá nào của vòng 7 — nó làm **chặt thêm**: cổng CI (4 job gate × 2 OS +
image) giờ đã chạy trên đúng SHA của vòng 7 và xanh, thay vì chỉ là suy luận từ máy local.
