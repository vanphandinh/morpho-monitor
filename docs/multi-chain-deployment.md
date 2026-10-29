# Multi-chain deployment (full per-chain)

Mỗi chain chạy **một stack đầy đủ, độc lập**: monitor + webapp + proxy, registry
riêng, volume riêng, port/domain riêng. Code dùng **cùng một image/tag** — clone
chỉ khác `.env`, `config/markets.json` và `CHAIN_ID`; không copy source, không sửa
code cho từng chain.

## 1. Chain metadata

`config/chains.json` là nguồn duy nhất cho metadata công khai của chain:

- `id`, `name`, `viemChain` (nếu có trong `viem/chains`)
- `morphoBlueAddress`
- `explorerUrl` / `explorerName`
- `nativeCurrency`
- `publicRpcUrls` / `wsRpcUrls` (key-less, dùng cho browser và fallback server)

`CHAIN_ID` chọn entry. `RPC_URLS`, `WSS_URLS`, `PUBLIC_RPC_URLS`,
`MORPHO_BLUE_ADDRESS` trong `.env` chỉ là override; không set để lấy từ config.
Riêng `WSS_URLS=` (set rỗng) tắt hẳn WebSocket để chạy HTTP-only.
Sai địa chỉ Morpho so với chain đang chọn sẽ fail-fast (trừ khi cố ý chạy fork
với `ALLOW_CUSTOM_MORPHO=1`).

Các chain có sẵn: `1` Ethereum, `8453` Base, `143` Monad. Thêm chain mới bằng
một entry trong `config/chains.json`, không cần sửa module nào.

Lớp RPC công khai cho browser có thể tinh chỉnh bằng `PUBLIC_RPC_REFRESH_HOURS`,
`PUBLIC_RPC_MIN_ENDPOINTS`, `PUBLIC_RPC_MAX_ENDPOINTS`,
`PUBLIC_RPC_CACHE_MAX_AGE_HOURS`, `PUBLIC_RPC_HEALTH_PATH` và
`PUBLIC_RPC_PROBE_TIMEOUT_MS`; mặc định và giải thích nằm trong `.env.example`.

## 2. Tạo một deployment cho chain mới

Ví dụ Base, chạy cạnh deployment ETH trên cùng VPS:

```bash
# 1) Một thư mục/deploy riêng cho chain (không dùng chung volume với ETH)
mkdir -p /srv/morpho-base && cd /srv/morpho-base
git clone <repo> app && cd app

# 2) .env riêng
cp .env.example .env
#    CHAIN_ID=8453
#    CONTAINER_NAME=morpho-base   (bắt buộc khác clone ETH)
#    WEBAPP_URL=https://base.example.com
#    WEBAPP_PORT=3001
#    PROXY_PORT=8546
#    PROXY_RPC_URL=https://base.example.com:8546
#    PRESIGNED_FILE=./data/presigned-base.json
#    RPC_URLS=            (bỏ trống = publicRpcUrls của Base)
#    WSS_URLS=            (không set = wsRpcUrls của Base; set rỗng để tắt)
#    MORPHO_BLUE_ADDRESS= (bỏ trống = Base Morpho trong chains.json)
#    LENDER_ADDRESS=...   (ví lender; có thể khác chain)

# 3) Market allow-list riêng của chain
cp config/markets.example.json config/markets.json
#    thay id bằng market Base thật; minLiquidity/suddenDrainMultiplier theo token

# 4) Compose project riêng + port riêng
docker compose -p morpho-base --env-file .env up -d --build
```

Kiểm tra:

```bash
# JSON-RPC giả lập phải trả đúng chain
curl -s -X POST http://127.0.0.1:8546/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# → {"jsonrpc":"2.0","id":1,"result":"0x2105"} cho Base

# Webapp trả HTML + config đúng chain (mở trang, xem window.MORPHO_CONFIG)
curl -s http://127.0.0.1:3001/ | head
```

Trong webapp, kết nối ví sẽ tự `wallet_switchEthereumChain` sang `CHAIN_ID`;
nếu ví chưa có chain, webapp gọi `wallet_addEthereumChain` bằng RPC/explorer
của chain đó. Proxy trả `eth_chainId`/`net_version`/`morpho_proxyInfo` theo
`CHAIN_ID`, nên không còn cảnh ví Base bị đẩy về Ethereum.

## 3. Bất biến an toàn

- **Một volume `presigned_data` cho mỗi chain.** Registry chứa raw signed tx;
  trộn registry giữa các chain có thể khiến monitor chain này thấy bundle chain
  khác. Compose project khác nhau tạo volume khác nhau; đừng mount chung.
- **Không publish trùng port hoặc trùng container name.** `WEBAPP_PORT` /
  `PROXY_PORT` / `CONTAINER_NAME` phải khác nhau trên cùng host — compose
  project `-p` không tự đổi `container_name`, clone thứ hai sẽ không start nếu
  cả hai để mặc định `morpho`.
- **Bundle bị ràng buộc chain.** Chữ ký EIP-155 mang `chainId`; webapp,
  proxy, monitor và CLI verify đều kiểm `chainId` trước khi lưu/broadcast.
  Bundle của chain khác bị từ chối trước khi lưu/broadcast: webapp/proxy trả
  lỗi 400 nêu rõ `chainId`, monitor phân loại là `CONFIG_MISMATCH` và giữ
  nguyên bundle (không sửa nội dung, không đánh dấu là bundle hỏng).
- **WSS kiểm chain.** `createWssConnect` probe `eth_chainId` trước khi subscribe;
  endpoint trả sai chain bị đóng và loại, không subscribe im lặng.
- **HTTP RPC kiểm chain từng endpoint.** `createChainBoundPublicClient` probe
  `eth_chainId` của MỌI URL trước khi tạo client; endpoint sai chain bị loại và
  không bao giờ nhận `eth_call`/`eth_getLogs`/nonce. Một URL sai không làm chết
  service nếu còn URL đúng; tất cả sai mới fail-fast `CHAIN_ID_MISMATCH`.
- **Cache verified phải đủ ngưỡng.** `readVerifiedCache` trả `null` khi danh sách
  https hợp lệ dưới `PUBLIC_RPC_MIN_ENDPOINTS`; script refresh tay cũng không ghi
  cache dưới ngưỡng, nên browser không bao giờ nhận danh sách RPC bị cụt.
- **Explorer/alert theo chain.** Link tx, cảnh báo vòng đời và TTS đều lấy tên
  chain/explorer từ config, không hardcode Etherscan.
- **Quota alert độc lập.** Mỗi clone có `MAX_NOTIFICATIONS_PER_DAY` và
  `NTFY_TOPIC` riêng; một chain không ăn quota của chain khác.

## 4. Rollout khuyến nghị

1. **Monitor-only** (Plan 1): bật monitor cho Base/Monad trước, chưa dùng webapp
   để ký. Xác nhận market id, liquidity, alert và explorer.
2. **Webapp đọc** (Plan 2): mở webapp, kết nối ví, kiểm tra market/position và
   `window.MORPHO_CONFIG` đúng chain; chưa ký.
3. **Ký/rút** (Plan 3): chỉ bật sau khi đã xác nhận `eth_chainId`, Morpho
   address và một bundle thử trên chain đó. ETH hiện có giữ nguyên deployment
   và volume cho tới khi Base/Monad ổn định.

## 5. Migration deployment ETH hiện tại

Checklist đầy đủ (backup, chọn đúng volume, cập nhật `.env`, probe RPC, verify
sau start và rollback) nằm ở
[migration-chain-config.md](./migration-chain-config.md). Có thể chạy tự động
bằng script, nhưng copy nó ra ngoài repo trước (ví dụ
`bash /srv/morpho/migrate-chain-config.sh --yes`) để tránh xung đột file
untracked khi merge; xem hướng dẫn trong tài liệu đó.

Tóm tắt tối thiểu cho deployment ETH:

```bash
# trong .env của deployment ETH
CHAIN_ID=1
CHAIN_CONFIG_FILE=./config/chains.json
MORPHO_BLUE_ADDRESS=      # bỏ trống, lấy từ chains.json
```

Sau đó copy `config/chains.json` lên host (Docker đã mount `./config`), rebuild
image rồi restart. Hành vi ETH (market, RPC, explorer, webapp, ký) giữ nguyên,
nhưng mọi endpoint trong `RPC_URLS` giờ phải trả đúng chain 1.
