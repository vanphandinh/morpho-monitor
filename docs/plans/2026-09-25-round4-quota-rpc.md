# Round-4 findings — quota RPC (2026-09-25)

Câu hỏi vận hành: *vì sao chỉ chạy 1 market mà ankr/infura báo vượt hoặc gần vượt quota?*

Kết quả điều tra: monitor nền chỉ tiêu ~6 req/phút (1 `eth_blockNumber` + 1 multicall
+ 1 `eth_getTransactionCount` presign mỗi chu kỳ 30s), **không phải thủ nhân chính**.
Ba cơ chế sau mới là nguyên nhân, theo thứ tự nghiêm trọng. Cả 3 đã fix, mỗi fix
một commit với test đỏ-trước.

Lưu ý: trong 11 URL của `RPC_URLS` không có Infura — cảnh báo quota Infura (nếu có)
đến từ RPC trong ví (MetaMask/Rabby), không phải app này.

## 1. Webapp public bóc lịch toàn bộ API key (FIXED — `c8ee4e2`)

**Bằng chứng:**
- `buildWebappConfig()` (webapp-config.mjs) inject nguyên `RPC_URLS` vào
  `window.MORPHO_CONFIG` — danh sách được serve công khai tại `/`.
- Kiểm tra `.env` thật: **tất cả 11 URL đều mang credential** — drpc/alchemy
  key trong path (`/v2/<hex>`, `/ethereum/<key>`), ankr `<64-hex>`, chainstack
  `<32-hex>`, onfinality `?apikey=`.
- docker-compose.yml publish port 3000 ra public. Comment trong webapp-app.mjs
  ("danh sách thật do server inject" + fallback key-less) cho thấy ý đồ design
  là list key-less, nhưng server inject đúng list CÓ key.
- Mỗi visitor mở tab = client riêng xoay 11 URL kèm key ⇒ vừa bóc lịch key,
  vừa đốt quota của server.

**Fix:**
- `shared.mjs`: thêm `PUBLIC_RPC_URLS` (mặc định `https://ethereum-rpc.publicnode.com`
  — quyết định user: webapp chỉ inject endpoint này).
- `webapp-config.mjs`: `buildWebappConfig({ publicRpcUrls = PUBLIC_RPC_URLS })`
  thay cho `rpcUrls = RPC_URLS`; URL khớp mẫu credential (query `apikey=`,
  key-in-path của alchemy/drpc/chainstack/ankr) bị chặn **fail closed** lúc
  cấu hình (`urlLooksCredentialed`). Shape config không đổi ⇒ webapp-app.mjs
  không phải sửa.

**Việc còn lại (ngoài code):** rotate toàn bộ key từng nằm trong danh sách
inject (drpc ×2, alchemy ×2, chainstack ×2, onfinality ×2) — coi như đã lộ.

## 2. Bão retry ×44 (FIXED — `9196ee8`)

**Bằng chứng:** rpc-client.mjs `circuitHttp` cấu hình viem `http()` per-URL
`retryCount: 1` (×2 attempt), rotation `retryCount: 1` (×2 lượt) ⇒ 1 logical
call thất bại toàn URL = 2 × 11 × 2 = **44 upstream call**. Browser (trước fix
leak) còn tệ: viem default `retryCount: 3` × 11 URL = 44. Provider rate-limit
⇒ mỗi chu kỳ 30s failed là một cơn bão tự đập vào quota.

**Fix:** per-URL `retryCount: 0`. Dự phòng đã có: rotation 11 URL + circuit
breaker (429 mở circuit ngay sau 1 lần, skip tức thì ở lượt sau). Worst case
1 logical call: 44 → **22**. Test ghim `retryCount=0` qua options truyền vào
`http()` (mock thay toàn bộ viem nên call log không quan sát được per-URL
retry — bẫy "xanh giả" đã bị bắt và xử lý trong chính quá trình viết test).

## 3. Nonce-read phí khi registry idle (FIXED — `bb56036`)

**Bằng chứng:** `broadcastEligible()` chạy **mỗi chu kỳ** monitor (30s) và luôn
gọi `eth_getTransactionCount(pending)` trước, dù `data/presigned.json` **không
tồn tại** ⇒ ~2.880 request/ngày để kết luận "không có gì để làm".

**Fix:** Phase 0 thuần trước mọi RPC: `registryHasWork(readRegistry(filePath))`
— chỉ `pending` và `broadcasting` là trạng thái đòi hỏi I/O. Idle ⇒ return
`{ idle: true }` với 0 RPC call. Fail closed: registry không đọc được (garbage/
v1) ⇒ không bao giờ coi là idle. Race với bundle vừa ký qua webapp không mất
an toàn: phase 1 vẫn là thẩm quyền duy nhất, bundle mới chỉ được claim ở chu kỳ
kế tiếp như cũ. Nhánh "terminal history" diagnostic giữ nguyên cho registry
hỗn hợp (có pending tương lai); registry chỉ toàn terminal giờ là idle 0-RPC.

## Tổng phát thải request (trạng thái idle, sau 3 fix)

| Nguồn | Trước | Sau |
|---|---|---|
| Monitor nền (1 market, 30s) | 6 req/phút | 4 req/phút (bỏ nonce-read idle) |
| Retry storm khi toàn URL fail | ≤ 44 call/logical | ≤ 22 call/logical |
| Visitor webapp (mỗi tab) | xoay 11 URL CÓ key | 1 URL key-less |
| Key exposure | 11 URL public | 0 (chặn fail closed) |

## Bài học quy trình

1. **Mock thay toàn bộ `viem` nuốt hết retry policy** — call log không quan
   sát được per-URL retry; test "xanh" đầu tiên của commit 2 là bằng chứng.
   Quan sát đúng chỗ cấu hình được đưa vào (`opts.retryCount`).
2. **Đỏ-trước phải xác thực bằng code cũ thật** (`git stash push -- <file>`
   → run → pop), không phải bằng kỳ vọng trên giấy: commit 2 và 3 đều bắt
   được sai số assertion trong lúc xác thực.
3. **Pin hành vi cũ phải được diễn giải lại khi chủ đích thay đổi** (commit 3:
   registry chỉ-toàn-terminal chuyển từ "terminalSummary" sang "idle 0-RPC").

## Phụ lục — probe public RPC cho browser (cùng ngày, theo yêu cầu user)

Default `PUBLIC_RPC_URLS` được mở từ 1 endpoint (publicnode) lên **6 endpoint
key-less đã probe thật** từ máy triển khai (POST JSON-RPC, header Origin giả lập
browser, timeout 8s). Tiêu chí: `eth_chainId` = 0x1, head block trả về, CORS mở
cho browser (browser gọi trực tiếp — không CORS thì vô dụng dù endpoint khỏe).

| Endpoint | Latency đo được | CORS | Ghi chú |
|---|---|---|---|
| `https://ethereum-rpc.publicnode.com` | 110–562ms | `*` | giữ vị trí 1 |
| `https://eth.drpc.org` | 100–490ms | `*` | nhanh nhất vòng probe |
| `https://eth-mainnet.public.blastapi.io` | 281–453ms | reflect origin | |
| `https://gateway.tenderly.co/public/mainnet` | 421–474ms | `*` | |
| `https://1rpc.io/eth` | 449–769ms | `*` | head chậm hơn 1 block ở 1 lần đo |
| `https://eth.meowrpc.com` | 466–527ms | `*` | |

**Loại, kèm bằng chứng probe:**

| Endpoint | Kết quả |
|---|---|
| `https://rpc.ankr.com/eth` (key-less) | HTTP 200 nhưng `-32000 "Unauthorized: You must authenticate your request with an API key"` — **ankr đã bỏ free key-less**; khớp 2 URL ankr chết (401) trong `.env`. ĐÃ REMOVE khỏi fallback của webapp-app.mjs và cấm trong test. |
| `https://cloudflare-eth.com` | `-32046 Cannot fulfill request` |
| `https://eth.llamarpc.com` | HTTP 525 (SSL handshake fail) |
| `https://ethereum.blockpi.network/v1/rpc/public` | HTTP 521 |
| `https://rpc.builder0x69.io` | DNS chết (EAI_AGAIN) |
| `https://api.zan.top/node/v1/eth/mainnet/public` | HTTP 403 |
| `https://rpc.particle.network/ethereum` | HTTP 404 |

Ghi chú: mặc định 1-endpoint của mục 1 (quyết định user cùng ngày) được user
mở rộng thành 6 endpoint này — vẫn nguyên tắc key-less, guard
`urlLooksCredentialed` không đổi và pin rằng cả 6 đều vượt guard. Public free
RPC có thể đổi chính sách bất kỳ lúc nào (ankr là ví dụ mới nhất); rotation 6
URL thì chết 1 không ảnh hưởng browser. Override bằng `PUBLIC_RPC_URLS` khi cần.
