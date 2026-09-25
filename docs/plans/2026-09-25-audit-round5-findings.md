# Audit vòng 5 — 2026-09-25 (nhánh `feat/multi-market-monitor`)

Repo: `morpho-monitor` · Branch: `feat/multi-market-monitor`
Phạm vi: **chính 4 commit vừa tạo** (`06d5887` P1 tách module, `ba077b0` P0 fix, `66a01b3` P2 tách
UI, `e333c5f` docs) + toàn bộ module production. Đây là vòng kiểm tra lại **các thay đổi mới
nhất** — không lặp lại vòng 4 (quota RPC) hay các vòng trước.

Phương pháp: mỗi kết luận — kể cả kết luận "không phải lỗi" — phải có **lệnh chạy được trên
production code**; mỗi test mới phải chứng minh **đỏ-trước** (cố tình phá bất biến ⇒ test đỏ, rồi
khôi phục). Không suy luận từ tên test, docstring, hay từ việc "suite đang xanh".

---

## 1. Điểm 4 chiều (so với vòng audit gắt trước: SPEC 7 / DESIGN 6 / CORRECTNESS 7 / QUALITY 6)

| Chiều | Trước | Sau | Vì sao |
| --- | --- | --- | --- |
| SPEC | 7 | **8** | Ba defect đã tái hiện được đều đóng và **có test ghim** (P0.1–P0.3); plan P0/P1/P2 hoàn tất đúng phạm vi đã duyệt. Trừ 1 điểm: `.env.example`/`markets.json` vẫn là config tay ngoài repo nên hành vi "1–9 market" chỉ được mô tả, không được thực thi. |
| DESIGN | 6 | **8** | `shared.mjs` hết là túi hỗn hợp (config/format ≠ rule ≠ auth ≠ lock), `monitor.mjs` thành factory có DI, UI tách theo trách nhiệm, và **handler phục vụ module qua route map** nên thêm module không phải sửa handler. Trừ 2: `webapp.html` vẫn là điểm ghim duy nhất giữa HTML ↔ module (không có bundler/codegen), và `ntfy.test.mjs` vẫn mirror payload. |
| CORRECTNESS | 7 | **8** | Thay đổi lớn (tách module + di chuyển validate ra ngoài lock) được chứng minh **tương đương hành vi** chứ không chỉ "test vẫn xanh": đối chiếu export cũ/mới, diff bỏ thụt lề, so từng chỗ gọi đã gộp. Trừ 2: vòng này vẫn tìm được một lỗ test THẬT (D7) và một vấn đề vận hành (D8) trong chính code vừa tách. |
| QUALITY | 6 | **7** | Không còn test mirror logic production (trừ ntfy), test import đúng module thật, `npm run check` đóng cả lint + `node --check` + vitest. Trừ 3: `webapp.html`/inline vẫn không được lint, `.freebuff/` untracked, và D9 — chính vòng này để lại 2 vết định dạng. |

Gate ở cuối vòng:

```text
$ npm run check
 Found 0 warnings and 0 errors.                     # oxlint --deny no-undef --deny-warnings
 ✅ node --check: 68/68 target OK (62 file .mjs + webapp.html no-inline-module)
 Test Files  32 passed (32)
      Tests  512 passed | 7 skipped (519)            # 7 skipped = block ntfy live (NTFY_LIVE=1 để chạy)
```

## 2. Bằng chứng bắt buộc theo AGENTS.md

```text
$ node .gitnexus/run.cjs impact "createMarketReader" --direction upstream --repo .
 impactedCount: 4 · direct: 2 · processes_affected: 2 · risk: LOW · epistemic: exact

$ node .gitnexus/run.cjs detect-changes --scope all --repo .      # TRƯỚC commit P0/P1/P2
 Changes: 21 files, 63 symbols · Affected processes: 34 · Risk level: critical

$ node .gitnexus/run.cjs detect-changes --scope all --repo .      # sau khi sửa theo audit này
 Changes: 4 files, 7 symbols · Affected processes: 2 · Risk level: medium
 (không có partial/truncated ở cả hai lần)
```

Đọc đúng con số `critical`: đây là **bán kính nổ của một refactor đổi tên/di chuyển hàm trên 21
file & 34 flow**, không phải một defect đường tiền. Mọi flow bị ảnh hưởng đều nằm trong test
(`presigned-*`, `monitor-cycle`, `webapp*`, `voip`, `market-reader`, `file-lock`) và gate xanh;
vòng này bổ sung phần còn thiếu (D7). Không có cảnh báo HIGH/CRITICAL nào bị bỏ qua.

---

## 3. Findings

### D7 (MEDIUM — lớp "UI chết lặng") — đồ thị module browser không có test khép kín

Ba danh sách phải khớp nhau mới làm SPA chạy, nhưng **mỗi test chỉ ghim một cặp**:

1. app import gì (`webapp-app.mjs`: `./webapp-logic.mjs`, `./webapp-render.mjs`,
   `./webapp-wallet.mjs`) — ghim bởi `scripts/check-syntax.mjs`;
2. server wire gì (`webapp-server.mjs` → `scripts` map) — ghim bởi `webapp.test.mjs`;
3. bare specifier resolve thế nào (`importmap` trong `webapp.html` → `viem`) — chỉ được kiểm JSON
   hợp lệ, **không** kiểm module nào thực sự import gì.

Không có test nào kiểm "(1) ⊆ (2) ⊆ (3)". Hệ quả: đổi khoá route map mà vẫn giữ tên file thì
browser nhận 404 cho một module ⇒ **cả đồ thị import chết** (ESM là all-or-nothing) ⇒ UI trắng,
trong khi toàn bộ suite + `node --check` vẫn xanh.

Bằng chứng đỏ (cố tình đổi `"webapp-render.mjs": renderScript` → `"webapp-renderz.mjs": renderScript`
trong `webapp-server.mjs`, chạy suite cũ + mới):

```text
     × vòng 5: đồ thị module browser khép kín — import ⊆ route map ⊆ importmap 15ms
AssertionError: webapp-app.mjs import ./webapp-render.mjs nhưng server/handler không wire
  "webapp-render.mjs" vào route map: expected false to be true
      Tests  1 failed | 64 passed (65)
```

Chạy **toàn bộ suite** với khoá sai đó: `Test Files 1 failed | 31 passed (32)` — **đúng một test đỏ, và nó là test mới**. Nghĩa là trước vòng này, cùng phép phá ấy không test nào phát hiện được.

Đã sửa: thêm test trong `__tests__/webapp.test.mjs` quét **file thật** của 4 module browser, mỗi
`./x.mjs` phải (a) nằm trong danh sách module browser, (b) có khoá `"x.mjs":` trong
`webapp-server.mjs`/`webapp-handler.mjs`, và mỗi bare specifier phải có trong `importmap`; kèm chốt
chống-regex-hỏng (`relative ≥ 3`, `bare ≥ 1`) để test không thể xanh vì match rỗng.

### D8 (LOW — vận hành) — fail-fast chỉ báo market id sai ĐẦU TIÊN

`market-reader.mjs` (P0.3) `throw` ngay trong vòng lặp khởi tạo. `markets.json` cho phép 1–9
market, nên một bộ id gõ sai khiến người vận hành sửa một dòng → restart → mới thấy id sai tiếp
theo (`docker restart` lặp; mỗi lần một vòng). Bằng chứng đỏ (giả lập "chỉ báo 1 id"):

```text
     × nhiều id sai ⇒ MỘT lỗi liệt kê ĐỦ mọi id, không đọc token của id sai
      Tests  1 failed | 7 passed (8)
```

Đã sửa: vòng lặp **thu thập** mọi id có params toàn-zero (không throw tại chỗ, và không tốn RPC
đọc token của market chắc chắn sai), rồi mới throw một lỗi liệt kê đủ danh sách:

```text
❌ 2 market id không tồn tại on-chain (params toàn zero):
   • 0xaaa…  • 0xbbb…
   → Kiểm tra lại `id` trong config/markets.json (MARKETS_FILE).
```

Giữ nguyên hợp đồng cũ (`.code = MARKET_PARAMS_ZERO`, `.marketId` = id đầu tiên) và thêm
`.marketIds` (đủ danh sách) nên không phá caller/test hiện có.

### D9 (QUALITY — do chính vòng này) — hai vết định dạng từ P2.8

`webapp-app.mjs`: banner comment bị dán vào dòng code (`};    // =====…`) và một dòng trống thừa
trong `window.fetchNonce`. Không ảnh hưởng hành vi, nhưng là dấu hiệu sửa máy móc — đã sửa lại.

### D10 (MEDIUM — công cụ, tìm thấy khi làm P5) — cổng lint KHÔNG quét `.mjs` ở gốc

`npm run lint` là `oxlint --deny no-undef --deny-warnings *.mjs __tests__ scripts`. Trên Windows,
npm chạy script bằng shell của HĐH (cmd.exe) — shell này **không** expand `*.mjs`, nên oxlint nhận
literal `*.mjs` và bỏ qua nó: lần chạy thật chỉ lint **38 file** (`__tests__/` + `scripts/`; 39 sau khi
P5 thêm `__tests__/helpers/browser-modules.mjs`), tức
**không một file `.mjs` nào ở gốc repo** — trong đó có toàn bộ production (`monitor.mjs`,
`proxy-dispatcher.mjs`, các module browser) mà chính ghi chú trong `CLAUDE.md` nói là cổng bắt lỗi C1.

Hệ quả kép: (1) mọi lần "lint xanh" trước đây trong môi trường này chỉ chứng minh được `__tests__`
+ `scripts` sạch; (2) dòng tổng kết `Found 0 warnings and 0 errors` **không** phân biệt được "quét
rồi thấy sạch" với "không quét gì".

**Đỏ-trước (đã chạy):** thêm `const zzProbe = someUndefinedName123;` vào `webapp-shell.mjs`:

| Lệnh | Kết quả |
| --- | --- |
| `npm run lint` (cũ) | exit **0**, `Found 0 warnings and 0 errors`, 39 file (38 trước P5) |
| `npm run lint` sau khi đổi target thành `.` | exit **1**, `eslint(no-undef): 'someUndefinedName123' is not defined.`, 74 file |

**Đã sửa:** target thành `.` (oxlint tự glob, tôn trọng `.gitignore`, cùng tập file một cách xác định),
và sửa 2 finding mà nó phơi ra ở lần đầu quét thật: tham số chết `httpOptions` trong `circuitHttp`
(`rpc-client.mjs` — JSDoc hứa "forwarded to viem's http()" nhưng hàm ấn định policy, và call site duy
nhất chỉ truyền 1 tham số) và `...(scripts ?? {})` trong `webapp-handler.mjs`. **Từ nay tin exit code,
đừng tin dòng `Found N errors`.**

---

## 4. Đã kiểm tra và KHÔNG phải lỗi (ghi để khỏi audit lại)

1. **Toàn bộ import nội bộ đều tồn tại**: quét `import ... from "./x.mjs"` trên 61 file (root +
   `scripts/` + `__tests__/`) đối chiếu export thật của file đích ⇒ **285 named import, 0 thiếu**.
2. **Tách `shared.mjs` không làm mất hàm nào**: 52 export cũ ⇒ chỉ mất `createClient`, và nó là
   export chết (không importer nào — chính vì thế bị xoá ở P1.4).
3. **`voip.mjs` DI không đổi hành vi**: `pollCallStatus` vẫn `60000/2000`, `retryDelayMs`/token
   cache/`expiresAt - 60_000` giữ nguyên; đổi tên `clearTokenCache → clearVoipTokenCache` an toàn
   vì `oxlint --deny no-undef` sẽ đỏ nếu còn caller sót.
4. **`monitor.mjs` factory tương đương 1-1 với bootstrap cũ**: thứ tự `reader → log → scheduler →
   WSS → request() → setInterval → SIGINT/SIGTERM`, `stickyMs: 2_000` giữ nguyên, và `stop()` gọi
   `scheduler.close()` / `wssWatcher.close()` — cả hai API **có thật**
   (`monitor-triggers.mjs:32-40` và `:140-146`) nên shutdown không ném.
5. `import("./monitor.mjs")` **không ném** khi `process.argv[1]` undefined (`node --input-type=module
   -e 'await import("./monitor.mjs")'` → `IMPORT OK`): guard `Boolean(process.argv[1])` có mặt.
6. **P2.8 `invalidateSignatures` tương đương từng dòng** với 3 chỗ gọi cũ, kể cả các chi tiết dễ
   mất khi gộp: `amountWei = null`, và `renderTierList()` chỉ khi thực sự có chữ ký bị vô hiệu.
7. **`webapp-render.mjs` import bare `"viem"` là hợp lệ trong browser**: `webapp.html:459-466` có
   `importmap` map cả `viem` và `viem/chains` (đây chính là lý do D7 cần assert (3)).
8. **Không có vòng import**: `auth.mjs → shared.mjs` một chiều; `file-lock.mjs` chỉ dùng
   `node:fs`/`node:os`; `monitor-rules.mjs` không import gì.
9. **P0.2 (validate trước lock) không bỏ sót kiểm tra nào cần registry**: phần sau lock vẫn giữ
   toàn bộ logic merge + kiểm `idx >= withdrawals.length`; test HTTP ghim rằng body rỗng/market lạ
   trả **400/404** (không phải 500 do lock) và **không để lại file `.lock`**.

## 5. Rủi ro còn lại (đọc để không tưởng là "sạch tuyệt đối")

1. **Chưa xác minh bằng browser thật trong vòng này.** Harness không giữ được tiến trình nền giữa
   các lệnh nên phiên trước chỉ curl được `200 + text/javascript` cho 4 module — thứ **không**
   chứng minh browser resolve/execute được đồ thị. Bù lại bằng D7 (test tĩnh khép kín 3 danh sách),
   nhưng vẫn nên F5 tay một lần trước khi coi là "đã xác minh đầu-cuối".
2. **Fail-fast market id chỉ ở startup** và cũng nuốt luôn lỗi mạng của `fetchParams` (hành vi cũ,
   không đổi): một lần RPC lỗi lúc khởi động làm monitor không lên — chấp nhận được vì có restart
   policy và thông báo nằm trong log/exit code, khác hẳn lớp "im lặng" mà P0.3 đóng.
3. `webapp.html` được kiểm cú pháp nhưng **không được lint** (oxlint chỉ quét `.mjs`); `ntfy.test.mjs`
   vẫn mirror payload; `.freebuff/` (AI tooling) untracked và **không** được commit.

## 6. Không làm trong vòng này

- Không bật `stickyMs` cho proxy/CLI (giữ blast radius nhỏ — quyết định của vòng 3 vẫn đúng).
- Không thêm bundler/codegen cho `webapp.html` (D7 giải quyết phần "phát hiện lệch" mà không cần
  thêm bước build).
