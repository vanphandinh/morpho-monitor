# Chẩn đoán: Ambire không ký được presign vì mô phỏng thấy `insufficient liquidity` (2026-10-30)

Repo: `morpho-monitor` · Nhánh: `feat/presign-sim-unlock` · Bắt đầu từ `4f3fefd` (`main`).

> **Kết quả (2026-10-30, test trên VPS):** **H2 được xác nhận** — Ambire mô phỏng bundle ở backend
> riêng, không gửi phép mô phỏng bị chặn qua proxy. Fix ở tầng RPC vì vậy vô hiệu với Ambire;
> PR #7 đã đóng. Bằng chứng và hệ quả: §8.

## 1. Triệu chứng (nguyên văn)

> Ví Ambire có mô phỏng kết quả giao dịch trước nên việc tạo trước giao dịch presign khi thanh khoản
> không đủ sẽ không thực hiện được.

Kèm một draft Tenderly (simulate) trả `Error code: insufficient liquidity`.

Đây **không phải** lỗi webapp/proxy/monitor. Giao dịch ký sẵn được tạo ra để **revert ngay lúc ký**:
nó rút một khoản lớn hơn thanh khoản hiện có, và monitor chỉ broadcast khi thanh khoản xuất hiện.
Ambire mô phỏng trước khi ký, thấy revert, và chặn popup ký ⇒ không tạo được bundle.

## 2. Bằng chứng

### 2.1 Trạng thái on-chain (mainnet, 2026-10-30)

Market đang cấu hình (`config/markets.json`):
`0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6`
(loan USDC, collateral `0x91d1…3292`, oracle `0x0798…05d7`, irm `0x870a…00bc`, LLTV 62,5 %).

| Đại lượng | Giá trị |
| --- | --- |
| `market().totalSupplyAssets` | 14 393 024 939 239 (= 14 393 024,939239 USDC) |
| `market().totalBorrowAssets` | 14 393 024 939 239 (= 14 393 024,939239 USDC) |
| **Thanh khoản** (`supply − borrow`) | **0** |
| `position(lender).supplyShares` | 414 649 453 043 776 137 (≈ 447 577,03 USDC) |

Lender: `0x0a5e1db3671faccd146404925bda5c59929f66c3`.
Vì thanh khoản = 0, **mọi** tier presign đều revert lúc ký.

### 2.2 Draft Tenderly của người dùng

Decode `rawFunctionInput` cho thấy call lồng `withdraw(…)` với đúng marketParams ở trên, `assets ≈
20 000 USDC`, `onBehalf = receiver = lender`. Calldata ngoài cùng là `execute([{ to: Morpho, value: 0,
data: withdraw }])` trên **chính account** `0x0a5e…66c3` — tức ví có thể mô phỏng qua wrapper chứ
không phải call trực tiếp tới Morpho. `from` trong draft là placeholder `0x…0001` của Tenderly.

### 2.3 Vì sao proxy là chỗ sửa được

- Ví bắt buộc trỏ RPC vào proxy (`:8545`) thì mới capture được `eth_sendRawTransaction`.
- Proxy đã mock có chủ đích cho ví: `eth_estimateGas` → `200000` cố định, `eth_getBalance` → 10 ETH,
  `eth_createAccessList` → rỗng, `debug_traceCall` → rỗng.
- `eth_call` hiện forward nguyên trạng, **kể cả `params[2]` state override** của ví (Ambire gửi
  override để spoof origin/portfolio). Vì vậy có thể gọi lại chính call đó kèm override bổ sung.
- Tab **Rút Tiền** không bị ảnh hưởng: `doWithdraw` tự `simulateContract` qua **public RPC** trước khi
  gọi ví (`webapp-withdraw.mjs`), nên che mô phỏng phía ví không thể làm tab đó báo sai.

> **Cập nhật 2026-10-30:** giả định "ví mô phỏng qua proxy" là **sai với Ambire** — xem §8.

### 2.4 Chi tiết Morpho cần ghim

- Revert của bản Morpho đang chạy là **string** `Error("insufficient liquidity")` (`0x08c379a0`),
  **không phải** custom error `InsufficientLiquidity()` (`0xbb55fd27`). Helper nhận cả hai.
- `mapping(Id => Market) public market` nằm ở **slot 3** (đã đối chiếu `eth_getStorageAt` với
  `market(id)` trên mainnet). Key: `keccak256(abi.encode(marketId, 3))`; word:
  `0x0000000000000000ba8e68fa79a45cc3000000000000000000000d17232384e7`
  (low 128 = `totalSupplyAssets`, high 128 = `totalSupplyShares`).

## 3. Vòng lặp đỏ → xanh (Phase 1/2)

Chỉ `eth_call`, không tốn phí, chạy trên mainnet với đúng market + lender:

```text
RED   eth_call { from: lender, to: Morpho, data: withdraw(20 000 USDC, onBehalf=receiver=lender) }
      → 0x08c379a0… "execution reverted: insufficient liquidity"
GREEN cùng call + stateDiff { market slot: totalSupplyAssets×2, totalSupplyShares×2 }
      → SUCCESS, trả (20000000000, 18679592027534151)
GREEN tier "rút toàn bộ shares" + cùng override
      → SUCCESS
RED/GREEN withdraw vượt số shares của lender
      → panic 0x11 (KHÔNG bị che) ✅
```

Thử riêng cơ chế override (đọc `market(id)` với `stateDiff` đặt assets về 0): 5/5 endpoint public
được thử đều áp override đúng ⇒ không phụ thuộc một provider cụ thể.

**Vì sao nhân đôi cả hai nửa:** conversion shares↔assets của Morpho dùng chính
`totalSupplyAssets/totalSupplyShares`. Chỉ bơm assets sẽ làm giá share tăng ⇒ mô phỏng tính ra số
shares khác thực tế. Nhân đôi cả hai giữ nguyên giá share (sai số làm tròn ≤ 1 wei) và thêm đúng
`totalSupplyAssets` thanh khoản ảo — đủ cho mọi vị thế hợp lệ, vì vị thế của lender ≤ tổng cung.
Đã kiểm chứng ×2 là đủ cho cả tier theo assets và tier theo shares.

## 4. Giả thuyết đã xếp hạng (Phase 3)

1. **H1 — Ambire mô phỏng qua RPC của ví (= proxy) và chặn.** *Dự đoán:* log proxy thấy `eth_call`
   chứa calldata withdraw đúng lúc bị chặn; cho mô phỏng thấy thanh khoản thì ký được.
   → **Đã sửa theo hướng này**; **chưa xác nhận end-to-end với Ambire thật** (xem §7).
2. **H2 — Ambire mô phỏng bằng backend riêng.** *Dự đoán:* proxy không thấy `eth_call` nào lúc bị
   chặn, và fix này vô hiệu. → Chưa loại trừ; log `🔓` sau deploy sẽ trả lời.
3. **H3 — Ví chặn vì lý do khác (chain/gas), không phải revert.** *Dự đoán:* log cho thấy lỗi khác,
   không có revert. → Loại trừ ở phạm vi repo: draft Tenderly đúng là `insufficient liquidity`.
4. **H4 — Ví mô phỏng qua wrapper `execute(...)`/deployless.** *Dự đoán:* `to` không phải Morpho,
   calldata withdraw nằm lồng bên trong. → **Đã xử lý** (`shape = "embedded"`, decode từ mọi vị trí
   selector).
5. **H5 — `eth_estimateGas` là thủ phạm.** *Dự đoán:* đổi estimateGas sẽ hết. → **Loại trừ**: proxy
   đã trả `200000` cố định từ trước.

## 5. Sửa (Phase 5)

### 5.1 `presign-simulation.mjs` (mới, thuần — không I/O)

- `findPresignTarget(call, { morpho, lender, markets })`:
  - `to === Morpho` + selector `0x5c2bea49`: decode `withdraw`, yêu cầu `assets>0 || shares>0`,
    `onBehalf == receiver == lender`, marketId ∈ allow-list → `{ marketId, shape: "direct" }`.
  - Ngược lại: quét **mọi** vị trí của selector withdraw trong data và thử decode phần đuôi
    (`shape: "embedded"`) — xử lý wrapper `execute(...)`/deployless mà không cần biết ABI của ví.
    Không dựa vào việc tìm chuỗi marketId: calldata chứa marketParams, **không** chứa id (id là hash).
  - Không khớp ⇒ `null` (proxy không can thiệp).
- `isInsufficientLiquidityRevert(err)`: nhận `0x08c379a0` + string, `0xbb55fd27`, hoặc message-only.
  Panic/unauthorized/… ⇒ `false`.
- `marketStorageKey(id)`, `doubleSupplyWord(word)` (saturate uint128), `mergeLiquidityOverride(...)`
  (merge vào override sẵn có của ví, giữ `balance`/account khác).

### 5.2 `proxy-dispatcher.mjs` — nhánh `eth_call`

- Dep mới `presignSimUnlock` (mặc định **bật**, `PRESIGN_SIM_UNLOCK=0` để tắt), truyền qua
  `createProxyRequestHandler` từ `proxy-rpc.mjs`.
- Trước khi forward: nhận diện target. Sau revert: nếu đúng target + đúng `insufficient liquidity` →
  `eth_getStorageAt` lấy word hiện tại → `doubleSupplyWord` → `eth_call` lần hai với override đã merge.
- Lỗi ở bất kỳ bước nào (storage, retry, params lạ) ⇒ trả **revert gốc**. Không có success giả.
- Log mỗi lần: `[proxy] 🔓 presign sim unlocked: market 0x… (direct|embedded)`.
- Khởi động proxy log trạng thái bật/tắt.

### 5.3 Webapp

- `webapp-config.mjs` inject `presignSimUnlock`; `webapp-state.mjs` expose `PRESIGN_SIM_UNLOCK`.
- `webapp.html` + `webapp-presign.mjs`: banner `#presign-sim-note` nói rõ giao dịch chỉ được lưu,
  không gửi tiền lúc ký; `renderPresignSimNote()` hiện/ẩn theo cờ.
- `walletSimulationBlockMessage(err)`: khi `sendTransaction` ném lỗi mô phỏng, hiện lời giải thích
  đúng bản chất ("dự kiến của ký sẵn") + đường sửa, thay vì chuỗi tiếng Anh thô. Áp ở cả
  `signAllTiers` và `signWithdrawAll`.

## 6. Test + cổng

Đỏ-trước (`__tests__/presign-sim-unlock.test.mjs`, chạy trên cây chưa nối dispatcher/config):

```text
Tests  5 failed | 18 passed (23)
  - dispatcher: revert liquidity ⇒ không retry (result là Error)
  - dispatcher: wrapper execute(...) ⇒ không retry
  - buildWebappConfig().presignSimUnlock ⇒ undefined
```

Sau khi nối:

```text
npx vitest run __tests__/presign-sim-unlock.test.mjs   → 23/23 passed

npm run check
  [lint] diagnostics: [] · 114 file .mjs (git theo dõi 112; 2 file mới chưa commit)
  ✅ node --check: 110/110 target OK (104 file .mjs + webapp.html no-inline-module)
  Test Files  57 passed (57)
       Tests  833 passed | 7 skipped (840)

npm run ui:check
  97/97 khẳng định đạt · 0 lỗi runtime · test-results/ui/report.json
```

GitNexus (`AGENTS.md`): `impact` — `createRpcDispatcher` **LOW**, `createProxyRequestHandler` **LOW**,
`buildWebappConfig` **LOW**; `signAllTiers`/`signWithdrawAll` **UNKNOWN** (gọi qua `window.*` +
`onclick`), đã xác nhận bằng text search: `webapp-app.mjs:467-468`,
`webapp.html:498,508`, `__tests__/webapp-{flows,gas-decimals,stale-nonce-guard,presign-nonce-readback}.test.mjs`.
`detect-changes --scope all` trước commit: 9 file, 26 symbol, 25 flow · risk **critical** (các hub
webapp `updatePresignWalletUI`/`buildPresignedBundle` + flow `HandleRpc`), **không** `partial`/
`truncated`. Thay đổi ở các hub là additive: thêm một lời gọi render có guard (`#presign-sim-note`
thiếu ⇒ return) và một nhánh error-mapping chỉ chạm `showPresignError`; toàn bộ hành vi cũ được ghim
bởi 833 test hiện có.

## 7. Rủi ro / còn mở

1. **ĐÃ KẾT LUẬN — H2 (2026-10-30, test trên VPS):** Ambire **không** gửi phép mô phỏng bị chặn qua
   proxy; nó mô phỏng bundle ở backend riêng. Fix vô hiệu với Ambire và PR #7 đã đóng. Bằng chứng
   đầy đủ ở §8. Phương án dự phòng: bỏ presign với Ambire (monitor báo khi có thanh khoản rồi rút
   tay) hoặc dùng ví ký raw tx (MetaMask/Rabby) với khoá EOA.
2. **Mặc định BẬT trong nhánh** (quyết định của operator, 2026-10-30; **§8.4 kết luận không merge**
   vì không có beneficiary đã biết). Nghĩa là mọi mô phỏng `withdraw` hợp lệ của lender tới market đã
   cấu hình đều được "cấp thanh khoản ảo" qua proxy, không chỉ trong lúc ký presign. Tab Rút Tiền
   vẫn an toàn vì tự simulate qua public RPC trước. `PRESIGN_SIM_UNLOCK=0` khôi phục đúng hành vi
   của chain.
3. **Lệch giá share do làm tròn**: với tier theo `shares`, số assets ví hiển thị trong mô phỏng lệch
   ~0,8 % so với thực (443 959 859 971 vs 447 577 029 273). Calldata ký vẫn là `shares`, nên giao
   dịch thật không đổi — chỉ con số preview của ví là xấp xỉ.
4. Override chỉ chạm **một** market slot; không đụng vị thế, allowance hay bất kỳ state nào khác.
   Proxy vẫn không bao giờ broadcast: `eth_sendRawTransaction` chỉ capture.

## 8. Kết quả kiểm chứng trên VPS (2026-10-30) — H2

Thử nghiệm trên deployment thật (Ethereum mainnet, ví Ambire), sau khi build nhánh này.

### 8.1 Lender là EOA uỷ quyền EIP-7702

`eth_getCode(0x0a5e…66c3)` trả 23 byte:

```
0xef0100 5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d
```

⇒ EOA đang delegate cho implementation `0x5a7f…6f6d` (mô hình smart-EOA của Ambire). Ambire gói giao
dịch thành bundle và mô phỏng bằng dịch vụ của nó; RPC của dApp chỉ là một phần trong luồng.

### 8.2 Proxy có được dùng — nhưng không cho phép mô phỏng quyết định

Bật log chẩn đoán tạm (`PROXY_DIAG_RPC=1`) ở đầu `handleRpc` và trong `catch` của `eth_call`:

```
14:34:02.204  eth_estimateGas from=0x0A5e1Db3 to=0xBBBBBbbB selector=0x5c2bea49 len=586 withdraw@2
14:34:02.141  eth_call ... selector=0xc501a06a len=2250 withdraw@1610
14:34:02.275  eth_call ... selector=0xae1473bf len=5322 withdraw@4682
14:34:02.208  eth_call ... selector=0x1385d5a9 len=4426 withdraw@1354
```

- `eth_estimateGas` đúng là withdraw của lender tới Morpho. Proxy trả cứng `200000` cho mọi
  `eth_estimateGas`, nên đường này luôn "thành công" — không thể là nguồn của lỗi.
- Logger đã được kiểm chứng bằng một `eth_call` revert nhân tạo (`to=Morpho, data=0xdeadbeef`):
  `[proxy][diag] eth_call ERROR target=none liquidity=false msg=execution reverted`.
- Ký lại một tier: **không có dòng `eth_call ERROR` nào** trong khoảng thời gian bấm ký.

⇒ Trong lúc chặn ký, **không có `eth_call` nào revert qua proxy**. Thông báo
`Transaction cannot be sent because of a contract error. Error code: insufficient liquidity` do
**backend mô phỏng riêng của Ambire** sinh ra, không phải từ RPC mà dApp cấu hình.

### 8.3 Cơ chế unlock vẫn đúng — chỉ sai giả định tích hợp

Probe trực tiếp qua proxy, dựng đúng calldata `withdraw` toàn bộ vị thế của lender:

| `presignSimUnlock` | Kết quả |
| --- | --- |
| BẬT (mặc định) | `PASS` — trả `assets` + `shares` (64 byte), ví sẽ thấy mô phỏng thành công |
| TẮT (`PRESIGN_SIM_UNLOCK=0`) | `execution reverted: insufficient liquidity` |

Nghĩa là code hoạt động đúng khi lời gọi đi qua proxy; giả định "Ambire mô phỏng qua proxy" mới là
thứ sai. Đây là lý do phải test bằng ví thật thay vì chỉ test đơn vị.

### 8.4 Kết luận

1. **H2 xác nhận.** Không có thay đổi nào ở proxy có thể ảnh hưởng tới quyết định chặn ký của
   Ambire, vì phép mô phỏng đó không đi qua proxy.
2. **Không merge mặc định BẬT.** Tính năng thay đổi hành vi mô phỏng của mọi `eth_call` withdraw hợp
   lệ (GitNexus xếp `critical`) mà không có beneficiary đã biết. PR #7 đóng; nhánh giữ làm hồ sơ.
3. **Presign chỉ khả thi với ví ký raw tx qua proxy** (MetaMask/Rabby + khoá EOA). Với Ambire: chờ
   monitor báo thanh khoản rồi rút tay ở tab Rút Tiền.
4. Nếu sau này muốn dùng cho ví khác: giữ code opt-in (**mặc định TẮT**) và lặp lại đúng quy trình
   log ở §8.2 trước khi bật — đừng suy đoán từ hành vi của một ví.
