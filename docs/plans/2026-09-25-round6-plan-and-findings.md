# Vòng 6 — Harness hành vi đường tiền + CI (2026-09-25, nhánh `feat/multi-market-monitor`)

Repo: `morpho-monitor`. Điểm xuất phát: `4da1315` (hết vòng 5). Index GitNexus lúc đó **chậm 17 commit**,
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
| P1 | `d8f1643` | `__tests__/helpers/dom-stub.mjs` — stub browser giả dùng chung cho boot test, harness lái luồng, và `refactor-diff`; thêm `installBrowserEnv`/`restore` (không rò state giữa hai lượt chạy trong cùng tiến trình) và `innerHTML` **materialize** `id="…"` | `id="error-banner"` → `error-banner-zz` trong `webapp.html` ⇒ **2/3 test đỏ** (`TypeError: Cannot set properties of null…` + `[ 'error-banner' ] to deeply equal []`) |
| P2 | `6f6da6c` | `helpers/webapp-harness.mjs` (RPC giả trả lời bằng chính viem, ví EIP-1193 giả, REST giả) + `helpers/webapp-scenario.mjs` (19 bước) + `scripts/refactor-diff.mjs` (`npm run diff:refactor`) | 4 probe, mỗi cái chỉ đích danh trường khác: `gas` (0x30d40→0x33450), `marketId` mất trong body, nhãn tier trong DOM, và đảo `assets`/`shares` trong calldata |
| P3 | `683e491` + `658c952` | `__tests__/webapp-flows.test.mjs` (19 test, thêm 1 ở P6 ⇒ 20) + `__tests__/fixtures/webapp-flows-trace.json` (19 bước · 46 lời gọi) | 6 probe; đáng chú ý: bỏ filter `validTiers` (lớp ngoài) ⇒ test **vẫn xanh** — ghi thẳng rằng lớp chặn thật là `continue` *bên trong* vòng ký |
| P4 | `f63e1b5` | `scripts/lint.mjs` — đọc số file oxlint **báo đã quét** rồi đối chiếu `git ls-files`. Thiếu file ⇒ đỏ; không parse được ⇒ đỏ (fail closed) | Cắm `const zzProbeD10 = someUndefinedName123` vào module production ở gốc: lệnh cũ (literal `*.mjs` không expand) ⇒ **exit 0**; cổng mới ⇒ **exit 1** |
| P5 | `75e573c` | `.github/workflows/ci.yml` (matrix ubuntu/windows × Node 20/22 + job image Docker) + `scripts/image-module-closure.mjs` + `.gitignore: ci-fixture/` | Build image rồi `rm /app/webapp-withdraw.mjs` ⇒ `❌ artifact /app THIẾU 1 file … webapp-withdraw.mjs`, exit 1 |
| P6 | *commit này* | Dọn doc mâu thuẫn + ghi lại vòng này + **D11** (xem §4) + CLAUDE.md | Xem §4: đổi `entry` về đường dẫn tuyệt đối ⇒ test mới đỏ |

## 2. Kết quả trung tâm — việc tách P5 không đổi hành vi (bằng chứng cơ học)

```text
$ npm run diff:refactor -- --base 05b8342
Cây cũ  : 05b8342
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
biệt được hai cây (`webapp-app.mjs` vs `.freebuff/ab-05b8342/webapp-app.mjs`) nên `refactor-diff`
không đổi kết quả. Ghim bằng một test mới trong `webapp-flows.test.mjs`, đỏ-trước chạy thật:

```text
AssertionError: expected 'C:\\Users\\VanPhanDinh\\Desktop\\morpho\\w…' to be 'webapp-app.mjs'
```

### D12 (LOW — hành vi, ĐÃ ĐO, CHƯA SỬA)

`signWithdrawAll()` gọi `onGasInputChange()` để đọc lại gas, và hàm đó gọi `invalidateSignatures()`
**vô điều kiện** ⇒ bấm "Ký Rút Toàn Bộ Shares" reset mọi tier đã ký về `pending` kèm báo "Gas đã thay
đổi" **dù gas không đổi**, đồng thời bật lại nút lưu. Trace ghim đúng hành vi này ở cả hai cây (bước
`sign-withdraw-all`), nên nếu ai sửa thì `refactor-diff` sẽ lộ ngay. **Không sửa trong vòng 6** vì sửa
là đổi hành vi đường tiền, và đổi hành vi làm mất luôn phép so trung thành ở §2 — nó phải là một pha
riêng, có đỏ-trước. Ghi ở `CLAUDE.md` mục Sharp edges.

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
| QUALITY | 7 | **9** | Cổng lint tự chứng minh độ phủ (không còn "xanh vì không quét gì"), CI chạy cả Windows (nơi D10 lộ ra), artifact image được kiểm, và tài liệu vòng 5 hết tự mâu thuẫn. Trừ 1: chưa từng mở webapp trong Chromium thật, `refactor-diff`/`webapp-trace` chỉ chạy tay, và YAML được kiểm bằng parser chứ không phải `actionlint`. |

## 6. Rủi ro còn lại (đọc để không tưởng là "sạch tuyệt đối")

1. **Vẫn chưa mở trong browser thật.** Mọi khẳng định về hành vi đều từ DOM stub — stub chạy đúng
   code production và đúng import graph, nhưng *không* chứng minh Chromium resolve `importmap`, chạy
   viem trong browser, hay ví thật nối vào. Đây là món nợ lớn nhất còn lại, và giờ nó **đã có thể làm
   được** (server chạy bằng một lệnh tự chứa) chứ không còn bị chặn kỹ thuật.
2. **CI chưa từng chạy thật.** Workflow chỉ hoạt động khi repo được push lên một remote có GitHub
   Actions; máy này chưa có remote. Điều đã chứng minh là **từng bước** của nó chạy đúng ở local (kể
   cả `docker build` + boot từ image). YAML được kiểm bằng parser, không phải `actionlint`.
3. **Một commit đỏ ở giữa lịch sử:** `5e80a7e` thiếu `monitor.mjs` (vá bằng `05b8342`) ⇒ `git bisect`
   qua khoảng đó sẽ gặp cây không chạy được. Sửa được nhưng phải rebase — **không tự làm** trong
   checkout đang chia sẻ với agent/IDE khác.
4. **Quyết định vận hành còn treo:** `PROXY_RPC_RATE_LIMIT` / `PROXY_ALLOW_PUBLIC_RPC` đã code xong
   nhưng **mặc định tắt** (lựa chọn có chủ ý: không đổi hành vi đang chạy). Nếu bind proxy ra public
   mà không đặt biến, nhánh JSON-RPC vẫn không xác thực và không giới hạn.
5. **Lỗ hổng có chủ ý trong lưới test:** lưới id tĩnh chấp nhận id **tự chèn**, nên typo trong chính
   chuỗi inject vẫn lọt; hợp đồng `on*` chỉ chứng minh handler **tồn tại**, không chứng minh **chạy
   đúng** (P3 đã thu hẹp khoảng này nhưng chỉ cho các bước nằm trong kịch bản).
6. **Số trong message của `75e573c` lệch:** nó ghi cổng lint cũ quét "47 file thay vì 82"; số đo lại
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
   checkout CRLF (`658c952`), lần hai vì ghim đường dẫn tuyệt đối (D11). Cả hai là lỗi *portability*,
   tức đúng loại lỗi mà chính pha CI của vòng này sinh ra để bắt; vòng này chỉ bắt được vì tôi soạn
   tài liệu.
4. **`npm ci` với lockfile hiện tại phải được chạy thật trước khi tin job CI** — nó exit 0 (92 package,
   15s), nhưng nếu lock lệch thì mọi job sẽ đỏ ngay ở bước đầu và "CI đã thêm" sẽ là một tuyên bố sai.
