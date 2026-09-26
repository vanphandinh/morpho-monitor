# Vòng 6 — Harness hành vi đường tiền + CI (2026-09-25, nhánh `feat/multi-market-monitor`)

Repo: `morpho-monitor`. Điểm xuất phát: `d1102ae` (hết vòng 5). Index GitNexus lúc đó **chậm 17 commit**,
nên P0 của vòng này là refresh index trước khi đụng vào bất cứ thứ gì cần `impact`/`detect_changes`.

Vì sao có vòng này: P5 (vòng 5) đã **di chuyển 1.848 dòng** — trong đó là toàn bộ đường tiền (nonce,
gas, ký tier, lưu bundle, xoá rung, rút tiền). Bằng chứng khi đó chỉ ở mức *tĩnh*: 520 test xanh (61
lời gọi `getElementById` chỉ được kiểm tĩnh, đường chạy thật chạm **2** id), HTTP 200 cho 10 module
(chứng minh **tải được**, không chứng minh **chạy đúng**), và một phép so khớp dòng ở mức văn bản.
Không có gì trong repo *thực thi* `signAllTiers()`/`withdrawAmount()` rồi kiểm thứ đi ra dây. Vòng 6
sinh ra để lấp đúng khoảng trống đó, rồi khoá nó lại bằng CI.

Nguyên tắc giữ nguyên từ các vòng trước: **mỗi khẳng định mới phải có đỏ-trước** (cố ý phá bất biến ⇒
test/cổng đỏ, rồi phục hồi), và test mới phải import **production**, không đọc source.

---

## 1. Sáu pha, mỗi pha một commit

| Pha | Commit | Nội dung | Đỏ-trước (chạy thật) |
| --- | --- | --- | --- |
| P0 | *(không commit)* | `node .gitnexus/run.cjs analyze --index-only` ⇒ **1.219 node / 3.195 cạnh / 106 luồng** | — |
| P1 | `56eed69` | `__tests__/helpers/dom-stub.mjs` — stub browser giả dùng chung cho boot test, harness lái luồng, và `refactor-diff`; thêm `installBrowserEnv`/`restore` (không rò state giữa hai lượt chạy trong cùng tiến trình) và `innerHTML` **materialize** `id="…"` | `id="error-banner"` → `error-banner-zz` trong `webapp.html` ⇒ **2/3 test đỏ** (`TypeError: Cannot set properties of null…` + `[ 'error-banner' ] to deeply equal []`) |
| P2 | `21300cb` | `helpers/webapp-harness.mjs` (RPC giả trả lời bằng chính viem, ví EIP-1193 giả, REST giả) + `helpers/webapp-scenario.mjs` (19 bước) + `scripts/refactor-diff.mjs` (`npm run diff:refactor`) | 4 probe, mỗi cái chỉ đích danh trường khác: `gas` (0x30d40→0x33450), `marketId` mất trong body, nhãn tier trong DOM, và đảo `assets`/`shares` trong calldata |
| P3 | `0d6e71d` + `d69c60e` | `__tests__/webapp-flows.test.mjs` (19 test, thêm 1 ở P6 ⇒ 20) + `__tests__/fixtures/webapp-flows-trace.json` (19 bước · 46 lời gọi) | 6 probe; đáng chú ý: bỏ filter `validTiers` (lớp ngoài) ⇒ test **vẫn xanh** — ghi thẳng rằng lớp chặn thật là `continue` *bên trong* vòng ký |
| P4 | `f1fa863` | `scripts/lint.mjs` — đọc số file oxlint **báo đã quét** rồi đối chiếu `git ls-files`. Thiếu file ⇒ đỏ; không parse được ⇒ đỏ (fail closed) | Cắm `const zzProbeD10 = someUndefinedName123` vào module production ở gốc: lệnh cũ (literal `*.mjs` không expand) ⇒ **exit 0**; cổng mới ⇒ **exit 1** |
| P5 | `e110a9b` | `.github/workflows/ci.yml` (matrix ubuntu/windows × Node 20/22 + job image Docker) + `scripts/image-module-closure.mjs` + `.gitignore: ci-fixture/` | Build image rồi `rm /app/webapp-withdraw.mjs` ⇒ `❌ artifact /app THIẾU 1 file … webapp-withdraw.mjs`, exit 1 |
| P6 | *commit này* | Dọn doc mâu thuẫn + ghi lại vòng này + **D11** (xem §4) + CLAUDE.md | Xem §4: đổi `entry` về đường dẫn tuyệt đối ⇒ test mới đỏ |

## 2. Kết quả trung tâm — việc tách P5 không đổi hành vi (bằng chứng cơ học)

```text
$ npm run diff:refactor -- --base ee43de6
Cây cũ  : ee43de6
Cây mới : HEAD (webapp-app.mjs)
  cũ : 19 bước · 46 lời gọi (eth_sendTransaction=5, POST /api/bundle=2, DELETE /api/presign=1)
  mới: 19 bước · 46 lời gọi (eth_sendTransaction=5, POST /api/bundle=2, DELETE /api/presign=1)

✅ 0 khác biệt: cùng kịch bản ⇒ cùng calldata, cùng body, cùng trạng thái UI sau mỗi bước.
```

Đây là mức bằng chứng mạnh hơn hẳn "suite vẫn xanh": cùng một kịch bản 19 bước chạy trên cây **một
file 1.848 dòng** và cây **7 module**, so từng byte calldata gửi cho ví, từng body `POST /api/bundle`,
từng URL `DELETE`, và trạng thái UI sau mỗi bước. Lệnh này không nằm trong `npm run check` (cần lịch
sử git; CI checkout mặc định chỉ có 1 commit) — nó là công cụ chạy tay, và là công cụ dùng lại cho
mọi lần tách file sau này.

Đường tiền nay được khẳng định trên **artifact**, không đọc source: `assets` = số người dùng nhập ×
10^decimals và `shares = 0` khi rút theo số lượng; `shares` thật và `assets = 0` khi rút toàn bộ;
`onBehalf`/`receiver` = lender/ví đang kết nối; nonce gửi lên là nonce của **stepper** (12) chứ không
phải nonce on-chain thô (11), và stepper không xuống dưới sàn; gas = 2×baseFee + 2×priority; mốc để
TRỐNG hiện trong danh sách nhưng **không tốn tx** và không vào bundle (progress 2/2, không phải 2/3);
`DELETE /api/presign` phải kèm `market + nonce + tier`.

## 3. Cổng và artifact

```text
$ npm run check
 Found 0 warnings and 0 errors.                     # oxlint --deny no-undef --deny-warnings .
 [lint] ✅ độ phủ: oxlint quét 83 file .mjs (git theo dõi 83 file, phạm vi ".")
 ✅ node --check: 84/84 target OK (78 file .mjs + webapp.html no-inline-module)
 Test Files  37 passed (37)
      Tests  543 passed | 7 skipped (550)            # 7 skipped = block ntfy live (NTFY_LIVE=1)

$ docker build + boot webapp TỪ TRONG image
 ✅ artifact /app: đủ 11 file của đồ thị webapp (10 module + html)
 webapp-app|logic|render|wallet|state|shell|overview|presign-bundles|presign|withdraw .mjs -> 200
 webapp-nope.mjs -> 404 (mong đợi 404)     fail=0
```

Job `image` bắt được đúng lớp lỗi mà mọi test trên cây nguồn đều mù: `Dockerfile` chỉ `COPY *.mjs ./`,
nên một module bị quên khỏi danh sách copy (hoặc đặt trong thư mục con) làm browser nhận 404 và UI
chết lặng, mà build vẫn thành công và suite vẫn xanh.

## 4. Finding mới

### D11 (MEDIUM — portability, do chính vòng này tạo ra rồi tự bắt)

Fixture `__tests__/fixtures/webapp-flows-trace.json` ghim `entry` là **đường dẫn tuyệt đối của máy
sinh ra nó**:

```text
"entry": "C:\\Users\\VanPhanDinh\\Desktop\\morpho\\webapp-app.mjs"
```

Test so **nguyên chuỗi**, nên trên runner Linux (và trên bất kỳ checkout nào khác) suite sẽ đỏ dù hành
vi y hệt. Đây đúng là lớp lỗi mà job CI ở P5 tồn tại để bắt — nhưng CI chưa từng chạy, nên nó chỉ lộ
ra khi soạn tài liệu vòng này.

Sửa: `webapp-scenario.mjs` trả `entry` **tương đối gốc repo** (`path.relative` + `/`), nhãn vẫn phân
biệt được hai cây (`webapp-app.mjs` vs `.freebuff/ab-ee43de6/webapp-app.mjs`) nên `refactor-diff`
không đổi kết quả. Ghim bằng một test mới trong `webapp-flows.test.mjs`, đỏ-trước chạy thật:

```text
AssertionError: expected 'C:\\Users\\VanPhanDinh\\Desktop\\morpho\\w…' to be 'webapp-app.mjs'
```

### D12 (LOW — hành vi) — ĐÃ SỬA trong pha riêng, sau khi vòng 6 đóng

`signWithdrawAll()` gọi `onGasInputChange()` để đọc lại gas, và hàm đó gọi `invalidateSignatures()`
**vô điều kiện** ⇒ bấm "Ký Rút Toàn Bộ Shares" reset mọi tier đã ký về `pending` kèm báo "Gas đã thay
đổi" **dù gas không đổi**, đồng thời bật lại nút lưu. **Vòng 6 cố ý không sửa** vì đổi hành vi làm mất
phép so trung thành ở §2 — sửa là một pha riêng, và pha đó đã chạy như sau:

- `signWithdrawAll` gọi `readGasInputs()` (chỉ ĐỌC); `onGasInputChange()` chỉ invalidate khi
  `gasValuesChanged()` xác nhận gas thực sự đổi — so **trước khi** gán `presignedGas`.
- Đỏ-trước bước 1 (áp CHỈ guard lên code cũ): đúng 3 test đỏ — 2 test ghim hành vi cũ + fixture.
- Lỗi trong quá trình sửa, ghi thẳng: lần áp đầu tiên so gas SAU khi gán ⇒ so giá trị mới với chính
  nó ⇒ luôn false ⇒ bảo vệ vô hiệu. Lần thứ hai của cùng lớp lỗi: chỗ duy nhất gas đổi trong kịch
  bản (`autoFillGas`) ghi thẳng state rồi mới ghi ra ô nhập nên onchange không bắn — ca dương DƯƠNG
  phải là người dùng sửa ô gas. Cả hai nay được ghim bởi ca dương "D12: gas THỰC SỰ đổi thì chữ ký
  vẫn bị vô hiệu".
- Đỏ-trước bước 2: bỏ guard ⇒ 3 đỏ (hành vi cũ bị bắt); guard luôn-false ⇒ đúng ca dương đỏ.
  Probe "quay lại gọi `onGasInputChange()`" XANH — kết quả dự kiến vì guard đã sửa đúng; không nhặt
  nó làm bằng chứng.
- Fixture đóng băng lại: khác biệt chỉ ở `sign-withdraw-all` + `save-to-server-all-shares`; 12 bước
  trước đó 0 khác biệt so với cây trước P5; vẫn 19 bước · 46 lời gọi.

Cổng sau pha này: lint 0/0 (83 file), `node --check` 84/84, 544 passed | 7 skipped (551) / 37 file.

### Ghi chú kỹ thuật dễ mất khi "rút gọn" code

ABI `withdraw` của Morpho trả `(uint256, uint256)`. RPC giả phải trả dữ liệu thật, nếu không
`simulateContract` ném "returned no data" — tức **đường simulate phụ thuộc vào ABI output đúng**, không
chỉ vào name/inputs.

## 5. Điểm 4 chiều (so với vòng 5: SPEC 8 / DESIGN 8 / CORRECTNESS 8 / QUALITY 7)

| Chiều | Vòng 5 | Vòng 6 | Vì sao |
| --- | --- | --- | --- |
| SPEC | 8 | **8** | Không thêm tính năng; vòng này trả nợ *bằng chứng* cho tính năng đã có. Giữ nguyên vì `markets.json`/`.env` vẫn là config tay ngoài repo. |
| DESIGN | 8 | **8** | Harness theo mô hình "kịch bản cố định + adapter giả" và `refactor-diff` là công cụ tái dùng, nhưng chưa có gì thay đổi thiết kế production. |
| CORRECTNESS | 8 | **9** | Lần đầu tiên đường tiền có bằng chứng **hành vi**: 5 lời gọi `eth_sendTransaction` được giải mã và so từng tham số, 2 body bundle, 1 URL DELETE, cộng phép so trung thành 0-khác-biệt giữa cây trước/sau P5. Trừ 1: D12 còn mở và đường simulate phụ thuộc ABI output. |
| QUALITY | 7 | **9** | Cổng lint tự chứng minh độ phủ (không còn "xanh vì không quét gì"), CI chạy cả Windows (nơi D10 lộ ra), artifact image được kiểm, và tài liệu vòng 5 hết tự mâu thuẫn. Trừ 1: ~~chưa từng mở webapp trong Chromium thật~~ **đã mở và khớp 100% với kết luận stub** (xem §6.1), `refactor-diff`/`webapp-trace` chỉ chạy tay, và YAML được kiểm bằng parser chứ không phải `actionlint`. |

## 6. Rủi ro còn lại (đọc để không tưởng là "sạch tuyệt đối")

1. **ĐÃ XÁC MINH TRONG CHROMIUM THẬT (2026-09-25, sau pha D12).** Server thật (`node --env-file=.env
   webapp-server.mjs` + `WEBAPP_ALLOW_INSECURE=1`, dev local) mở trong Chromium qua Preview:
   importmap resolve, cả 10 module được fetch `200 text/javascript` rồi evaluate; 19/19 handler
   `window.*` probe là hàm sống (khớp hợp đồng 31 handler mà stub khẳng định); dữ liệu **mainnet
   thật** render: dCOMP/USDC, LLTV 62.50%, Total Supply 14.811.099 USDC, vị thế lender
   440.927,69 USDC; bấm nút thật: **Lấy Nonce** chạy đúng chốt chặn "Vui lòng kết nối ví trước",
   **Tự Động Gas** đi hết đường RPC thật ⇒ ô nhập nhận maxFee `0.995392056` / priority
   `0.000111316` Gwei (giá thị trường thật), **Kết Nối Ví** đúng nhánh tương thích "Vui lòng cài đặt
   MetaMask…" (Chromium test không có ví), **Thêm Mạng Proxy Vào Ví** cùng nhánh, stepper khoá khi
   chưa có nonce, Ký Tất Cả/Lưu khoá đúng trạng thái. RPC fallback chạy đúng tài liệu: `1rpc.io`
   chết DNS → `meowrpc` 200 rồi 429 → `publicnode` 200 ổn định. **Không có khác biệt nào so với
   kết luận từ DOM stub** — lỗi duy nhất của lần chạy là của *tôi*, không phải của app: quên
   `--env-file=.env` lần đầu (đúng lớp lỗi mà smoke CI đã bắt ở P5). Phần còn lại của món nợ này:
   ký/lưu/broadcast thật cần MetaMask + proxy + funder, thuộc phạm vi E2E tay của owner.
2. **CI chưa từng chạy thật.** Workflow chỉ hoạt động khi repo được push lên một remote có GitHub
   Actions. *(Đính chính: remote `origin` GitHub **có tồn tại** — tuyên bố "chưa có remote" ở đây là
   sai; đúng là **các commit của vòng 6 chưa từng được push**, nên CI vẫn chưa từng chạy cho chúng.)*
   Điều đã chứng minh là **từng bước** của nó chạy đúng ở local (kể cả `docker build` + boot từ image).
   YAML được kiểm bằng parser, không phải `actionlint`. Lần chạy thật đầu tiên sẽ là khi push nhánh
   tạo PR.
   *(Đính chính lần 2, 2026-09-26 — bằng chứng GitHub API: vế "CI vẫn chưa từng chạy cho chúng" ở
   trên cũng SAI. Nhánh ĐÃ được push và PR #1 đã mở trước vòng 7; run #10 (head `6dec4e2`) kết thúc
   `success` lúc 2026-09-25T18:57Z, và `check-runs` của `6dec4e2` có 10 check (2 run × 5 job) với job
   `image · build + smoke` success. Chi tiết + lệnh truy vấn: `docs/plans/2026-09-26-audit-round7-findings-and-fixes.md` §8.)*
3. ~~**Một commit đỏ ở giữa lịch sử**~~ **ĐÃ GIẢI QUYẾT (rebase 2026-09-25, trước khi tạo PR).** Commit
   đỏ cũ và commit vá của nó (2 SHA riêng biệt trong lịch sử trước rebase) đã được **gộp thành một
   commit xanh `ee43de6`** kèm ghi chú REPAIR trong message. Kiểm chứng: `monitor.mjs` của commit gộp
   khớp từng byte với cây sau khi vá, và **cả 16 commit trong dải viết lại đều xanh từng cái một**
   (`npm run check` chạy tại mỗi commit, không bỏ sót). `git bisect` qua dải này không còn gặp cây
   không chạy được. Lịch sử trước rebase còn nguyên ở nhánh **local** `backup/pre-rebase-20260925`
   (không push; xoá sau khi PR được merge). Tham chiếu SHA trong tài liệu, `CLAUDE.md` và mặc định
   `--base` của `refactor-diff` đã được đồng bộ sang SHA mới (33 chỗ, kiểm bằng grep độc lập = 0 SHA
   cũ còn sót).
4. **Quyết định vận hành còn treo:** `PROXY_RPC_RATE_LIMIT` / `PROXY_ALLOW_PUBLIC_RPC` đã code xong
   nhưng **mặc định tắt** (lựa chọn có chủ ý: không đổi hành vi đang chạy). Nếu bind proxy ra public
   mà không đặt biến, nhánh JSON-RPC vẫn không xác thực và không giới hạn.
5. **Lỗ hổng có chủ ý trong lưới test:** lưới id tĩnh chấp nhận id **tự chèn**, nên typo trong chính
   chuỗi inject vẫn lọt; hợp đồng `on*` chỉ chứng minh handler **tồn tại** — buổi chạy Chromium thật
   đã tăng thêm một lớp (handler thật sự chạy khi bấm), nhưng chỉ cho các nút được bấm; phần còn
   lại vẫn là suy luận.
6. **Số trong message của `e110a9b` lệch:** nó ghi cổng lint cũ quét "47 file thay vì 82"; số đo lại
   ở vòng 6 là **48** (`__tests__` + `scripts`) và tổng **83** file `.mjs` đang được git theo dõi
   (`git ls-files '*.mjs'`). Sai ở message, không sai ở code — không sửa được nếu không viết lại lịch sử.

## 7. Không làm trong vòng này

- Không bật `stickyMs` cho proxy/CLI (blast radius nhỏ — quyết định vòng 3 vẫn đúng).
- Không thêm bundler/codegen cho webapp (D7 + P3 giải quyết phần phát hiện lệch mà không cần build).
- Không rebase dọn commit đỏ giữa lịch sử, không đổi mặc định proxy limit, không thay endpoint ankr
  chết trong `.env` — cả ba đều là quyết định của owner.
- Không sửa D12 (xem §4).

## 8. Kế hoạch này sai ở đâu (ghi thẳng, theo bài học vòng 5)

1. **"Chưa thể chạy server để kiểm thật" là kết luận sai của vòng trước và của chính tôi lúc lập
   plan.** Chỉ cần **một lệnh tự chứa** (khởi động + `for` curl + `kill`) — không cần tiến trình nền
   sống giữa hai lệnh. Vòng 6 đã đo được 10 module `200` và boot cả image Docker.
2. **Tôi tưởng P3 chỉ cần "test thêm", nhưng nó cần một tiến trình mới cho mỗi biến thể.** Module ESM
   được cache theo URL, nên lượt chạy thứ hai trong cùng tiến trình không evaluate lại
   `webapp-state.mjs` và kết quả vô nghĩa. Đó là lý do sinh ra `scripts/webapp-trace.mjs`.
3. **Tôi đã coi "test xanh" là đủ cho fixture trace — sai hai lần:** lần một vì so nguyên chuỗi trên
   checkout CRLF (`d69c60e`), lần hai vì ghim đường dẫn tuyệt đối (D11). Cả hai là lỗi *portability*,
   tức đúng loại lỗi mà chính pha CI của vòng này sinh ra để bắt; vòng này chỉ bắt được vì tôi soạn
   tài liệu.
4. **`npm ci` với lockfile hiện tại phải được chạy thật trước khi tin job CI** — nó exit 0 (92 package,
   15s), nhưng nếu lock lệch thì mọi job sẽ đỏ ngay ở bước đầu và "CI đã thêm" sẽ là một tuyên bố sai.
