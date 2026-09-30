# Chẩn đoán 2026-09-30 — Ladder đã chết vẫn gắn dấu “(nonce kế tiếp sẽ broadcast)”

Người dùng báo: đã ký 2 tier ở 2 nonce liên tiếp khác nhau; sau đó on-chain nonce tăng vượt qua **cả hai**,
trạng thái hai rung chuyển `expired`; nhưng trong mục “📦 Bundle Hiện Tại Trên Server”, rung thấp hơn vẫn
hiển thị `expired (nonce kế tiếp sẽ broadcast)`.

Đợt này chạy theo skill `diagnosing-bugs`: **dựng loop đỏ trước, không dựng giả thuyết trước khi có loop**.

---

## 1. Vòng lặp đỏ (Phase 1–2)

Test mới trong `__tests__/webapp-stale-nonce-guard.test.mjs`: ladder `[expired@2550, expired@2551]` (đúng ca
“2 nonce liên tiếp rồi cùng chết”), lái qua đúng đường UI `switchTab("presign")` → `fetchExistingBundle()`,
assertion trên DOM thật do server giả trả về.

```text
npx vitest run __tests__/webapp-stale-nonce-guard.test.mjs

× CẢ ladder đã chết (2 rung expired liên tiếp) ⇒ KHÔNG rung nào mang dấu 'nonce kế tiếp sẽ broadcast'
AssertionError: không còn rung sống ⇒ không được gắn dấu head:
  expected '<div class="row">…' not to contain 'nonce kế tiếp sẽ broadcast'
Received: … nonce-display">2550 … expired … (nonce kế tiếp sẽ broadcast) …
Test Files  1 failed (1) | Tests  1 failed | 7 passed (8)
```

Output đỏ **chính là triệu chứng người dùng tả**: rung 2550 (thấp nhất) hiển thị `expired` + dấu head.
Loop chạy ~2 giây, 7 test cũ vẫn xanh — đỏ đúng một ca, không đỏ lây.

## 2. Giả thuyết xếp hạng (Phase 3)

1. **Fallback `?? ladder[0]` của `head`.** Khi không còn rung `pending`/`broadcasting`, head lùi về rung
   thấp nhất; nếu rung đó `expired` thì dấu “kế tiếp sẽ broadcast” gắn vào một rung đã chết.
   *Dự đoán*: bỏ fallback ⇒ hết triệu chứng, ca `[expired, pending]` (test cũ) vẫn xanh.
   → **Đúng** — chứng minh trực tiếp bằng output đỏ (dấu nằm đúng 2550, rung thấp nhất của ladder đã chết).
2. Server trả status “sống” cho rung thấp, UI chỉ hiển thị lệch. → Loại: fixture `expired` tái hiện đủ.
3. Trang giữ render cũ chưa refetch. → Loại: repro đi qua `switchTab` (refetch từ server mỗi lần).
4. Chỉ sai wording của dấu. → Loại: tài liệu D18 ghim dấu thuộc rung HOẠT ĐỘNG đầu tiên
   (`docs/plans/2026-09-26-diagnosis-four-webapp-symptoms.md`); “expired (nonce kế tiếp sẽ broadcast)” tự mâu thuẫn.

## 3. Fix (Phase 4–5)

`webapp-presign-bundles.mjs` — `fetchExistingBundle()` (một biến duy nhất):

- `const head = ladder.find(live) ?? null;` (bỏ hậu tố `?? ladder[0]`).
- Banner “Bundle head đang pending” guard `head?.status === "pending"` (không còn dựa vào head luôn tồn tại).

Khi cả ladder đã chết, **không rung nào mang dấu**; hướng dẫn đúng là banner `♻️ Có bundle đã expired…`
đã có sẵn (ký lại với nonce mới).

## 4. Cổng kiểm tra (đo trên cây sau fix)

- `npx vitest run __tests__/webapp-stale-nonce-guard.test.mjs`: **8/8 xanh** (ca mới + ca cũ `[expired, pending]`).
- Vùng ảnh hưởng webapp/presigned (12 file: webapp-*, presigned-*, money-path-e2e, proxy-nonce-freshness):
  **146/146 xanh, 2/2 lần chạy**.
- `npm run lint`: 0 warning/0 error trên 105 file; `node scripts/check-syntax.mjs`: 101/101 target.
- `npx vitest run` toàn bộ: **51/51 file xanh** (695 passed | 7 skipped). Hai lần chạy full trước đó có 1 test
  đỏ ở **file khác nhau** (`public-rpc-health`, `verify-presigned-cli`) — cả hai pass khi chạy riêng, không
  import gì từ webapp, và `verify-presigned.mjs` chỉ import `node:fs` + `viem`; flake sẵn có dưới tải song song,
  không do fix này.

## 5. Phân tích đồ thị (AGENTS.md)

- `impact fetchExistingBundle --direction upstream`: **8 caller** (7 trực tiếp: `init`, `signIn`, `signOut`,
  `switchTab`, `saveToServer`, `deleteTierFromBundle`, `deleteRungFromBundle`) — risk **CRITICAL** đã đọc
  TRƯỚC khi sửa; thay đổi chỉ nằm trong logic render của chính hàm, bị ghim bởi test cũ + test mới.
- `detect-changes --scope all --repo .`: **2 file, 2 symbol, 4 flow · risk medium** — không `partial`/`truncated`.

## 6. Dọn dẹp (Phase 6)

- Không thêm tag `[DEBUG-…]`; không prototype tạm nào.
- Test hồi quy: ca “CẢ ladder đã chết” trong `__tests__/webapp-stale-nonce-guard.test.mjs`.
- Giả thuyết đúng đã ghi ở mục 2 (thay cho commit message — đợt này chưa commit).
