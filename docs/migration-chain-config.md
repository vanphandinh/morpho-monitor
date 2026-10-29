# Migration lên bản chain-config

Tài liệu này hướng dẫn nâng một deployment đang chạy bản **trước chain-config**
lên `main` hiện tại. Đây là migration cấu hình + image, **không phải** migration
database.

> **VPS đang ở `da1c3f4`?** Đây là bản **trước chain-config**. Phải làm đầy đủ
> các mục 2–8 bên dưới; chỉ `git pull` rồi restart là chưa đủ, vì image mới cần
> `CHAIN_ID`, `config/chains.json` và sẽ kiểm tra chain của từng RPC.

## 0. Bản nào với bản nào?

Repo không có tag release; version được xác định bằng commit:

| Mốc | Commit | Nội dung |
| --- | --- | --- |
| Bản cũ trước chain-config | `da1c3f4` | Monitor/webapp/proxy hardcode Ethereum |
| Merge chain-config | `d4d74f0` | `CHAIN_ID`, `config/chains.json`, chain-binding từng RPC |
| Merge test PR #3 | `e155dd7` | Chỉ thêm test reject wrong-chain startup |
| Merge test PR #4 | `c46ab21` | Chỉ thêm test mixed-chain RPC; **không đổi runtime** |

- **`da1c3f4`:** bản trước chain-config ⇒ phải migrate theo tài liệu này.
- **`d4d74f0`, `e155dd7`, `c46ab21`:** đã có chain-config. PR #3 và #4 chỉ thêm
  file test, không đổi runtime; **không cần migrate** vì các PR đó. Chỉ cần
  `git pull` nếu muốn lấy test. Image Docker cũng không đổi vì `Dockerfile`
  không copy `__tests__/`.

Phần còn lại của tài liệu dành cho việc nâng deployment cũ lên bản có
chain-config (`d4d74f0` trở lên, hiện là `776c3d3`).

Các ví dụ bên dưới dùng `/srv/morpho-monitor` — thư mục clone mặc định của
repo, **không phải** `morpho/app`. Đổi theo đường dẫn thật; xác định bằng
`git rev-parse --show-toplevel`.

## Script tự động

Nếu không muốn gõ tay từng bước, dùng script
[`scripts/migrate-chain-config.sh`](../scripts/migrate-chain-config.sh). Script
chỉ hỗ trợ deployment Ethereum đang ở `da1c3f4`, tự backup, kiểm tra registry,
merge, sửa `.env`, build/probe, start và verify. Nó không xoá volume và không
dùng `git reset --hard`.

Khuyến nghị copy script ra **ngoài repo** để tránh xung đột file untracked khi
merge:

```bash
scp scripts/migrate-chain-config.sh user@vps:/srv/
ssh user@vps
cd /srv/morpho-monitor          # thư mục clone thật
bash /srv/migrate-chain-config.sh --yes
```

Các option:

- `--yes`: không hỏi xác nhận.
- `--project <tên>`: chỉ định compose project nếu script không tự dò được.
- `--backup-dir <dir>`: đổi thư mục backup (mặc định `../backup` cạnh repo).
- `--resume`: repo đã có chain-config nhưng lần trước lỗi giữa chừng; bỏ qua
  merge, chỉ backup/cấu hình/build/start lại.
- `--remote <tên>`: đổi git remote (mặc định `origin`).

Script dừng ngay nếu còn bundle `broadcasting`, registry version lạ, RPC probe
đỏ, hoặc preflight không trả `chainId: 1`. Nó cũng từ chối
`MORPHO_BLUE_ADDRESS` không phải địa chỉ ETH chuẩn nếu thiếu
`ALLOW_CUSTOM_MORPHO=1`. Lần chạy đầu yêu cầu stack cũ đang chạy; nếu đã dừng,
dùng `--resume`. Nếu đã dừng stack mà bước sau lỗi, script in lệnh rollback về
`da1c3f4`.

## 1. Thay đổi ảnh hưởng vận hành

| Hạng mục | Bản cũ | Bản mới | Việc cần làm |
| --- | --- | --- | --- |
| Chain metadata | Hardcode Ethereum | `config/chains.json` + `CHAIN_ID` | Thêm file config, đặt `CHAIN_ID=1` cho ETH |
| Morpho address | Mặc định địa chỉ ETH, giá trị nào cũng nhận | Bỏ trống ⇒ lấy theo chain; sai chain ⇒ fail-fast | Bỏ trống, hoặc giữ đúng địa chỉ ETH; fork mới set `ALLOW_CUSTOM_MORPHO=1` |
| `RPC_URLS` | Mặc định một publicnode | Bỏ trống ⇒ `publicRpcUrls` của chain | Giữ endpoint riêng nếu có; **mọi URL phải đúng chain** |
| `PUBLIC_RPC_URLS` | Danh sách ETH tĩnh | Bỏ trống ⇒ `publicRpcUrls` của chain; rỗng không còn là override | Để trống hoặc chỉ set URL key-less |
| `WSS_URLS` | Mặc định publicnode | Không set ⇒ `wsRpcUrls` của chain; set rỗng ⇒ tắt WSS | Chọn rõ: bỏ dòng để dùng chain, `WSS_URLS=` để HTTP-only |
| Kiểm chain RPC | Chỉ kiểm một endpoint | Probe `eth_chainId` **mọi** URL, loại URL sai chain | Xem log `[rpc] ... loại sai chain`; sửa danh sách nếu cần |
| Cache public RPC | Có thể dùng cache ngắn | Cache dưới `PUBLIC_RPC_MIN_ENDPOINTS` (mặc định 4) bị bỏ qua | Không cần xoá; webapp fallback danh sách tĩnh rồi tự probe lại |
| Explorer/alert/proxy | Hardcode Ethereum | Theo chain đã chọn | Kiểm tra link tx, alert, `eth_chainId` sau khi lên |
| Docker | Container `morpho`, port cứng 3000/8545 | `CONTAINER_NAME`, `WEBAPP_PORT`, `PROXY_PORT` từ `.env` | Giữ nguyên project name/volume; đặt port và tên container |
| Registry presigned | v3/v2 | Không đổi schema; v2 đọc được, ghi lại v3 ở lần mutation sau | Backup trước; **v1 không được hỗ trợ** |

Không có thay đổi dependency, không có migration SQL, và `package.json` vẫn yêu
cầu Node `>=20` (Docker dùng Node 22).

## 2. Chốt đường tiền trước khi restart

Restart sẽ làm mất buffer capture trong RAM của proxy. Trước khi dừng stack:

1. Không còn tab nào đang ký/rút dở.
2. Không còn bundle `broadcasting` chưa có receipt.
3. Nếu đang có capture chưa lưu, hoàn tất hoặc export `/captured` trước.

Kiểm tra registry (đổi `CID` nếu compose project khác):

```bash
cd /srv/morpho-monitor
CID=$(docker compose ps -q morpho)
[ -n "$CID" ] || { echo "Không thấy container morpho — kiểm tra project name."; exit 1; }
rm -f /tmp/presigned-before.json
docker cp "$CID":/app/data/presigned.json /tmp/presigned-before.json 2>/dev/null || true
if [ -f /tmp/presigned-before.json ]; then
  jq '[.bundles[] | select(.status == "broadcasting")] | length' /tmp/presigned-before.json
else
  echo "Chưa có registry — bỏ qua kiểm tra bundle"
fi
```

Kết quả phải là `0`. Nếu có bundle `broadcasting`, xem cảnh báo lifecycle và
đợi receipt/mined trước khi migrate; đừng restart giữa lúc tx đang được theo dõi.

Nếu máy không có `jq`, mở file bằng editor và tìm `"status": "broadcasting"`.

## 3. Backup

Chạy trong thư mục compose, khi container cũ vẫn còn chạy:

```bash
set -euo pipefail
cd /srv/morpho-monitor

# Giữ đúng project name cũ để không tạo volume rỗng.
# Xem tên bằng `docker compose ls`, rồi đổi giá trị dưới cho khớp.
export COMPOSE_PROJECT_NAME=morpho
# Biến này chỉ sống trong shell hiện tại; mở shell mới thì export lại.

docker compose ls

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
# Để backup ngoài repo: tránh vô tình commit .env và data.
BACKUP="/srv/backup/migrate-$STAMP"
mkdir -p "$BACKUP/data"

# Cấu hình và secret
cp -a .env "$BACKUP/.env"
cp -a config "$BACKUP/config"

# Toàn bộ data trong container (registry, cache public RPC, lock cũ nếu có)
CID=$(docker compose ps -q morpho)
[ -n "$CID" ] || { echo "Không thấy container morpho — kiểm tra project name."; exit 1; }
docker cp "$CID":/app/data/. "$BACKUP/data/" 2>/dev/null || true

# Ảnh cũ để rollback nhanh
docker inspect --format '{{.Image}}' "$CID" > "$BACKUP/image-id.txt"
docker tag "$(cat "$BACKUP/image-id.txt")" morpho-monitor:pre-chain-config

# Trạng thái triển khai để đối chiếu
git rev-parse HEAD > "$BACKUP/commit.txt"
docker compose config > "$BACKUP/compose.rendered.yml"
docker compose ls > "$BACKUP/compose-projects.txt"
docker volume ls | grep presigned_data > "$BACKUP/volumes.txt" || true

chmod -R go-rwx "$BACKUP"
echo "Backup: $BACKUP"
```

Lưu ý:

- `.env` chứa secret; giữ backup ngoài repo và không commit thư mục backup.
- Không chạy `docker compose down -v`; `-v` sẽ xoá volume registry.
- Ghi lại **project name** và **volume name**. Nếu trước đây chạy
  `docker compose -p morpho ...`, tiếp tục dùng đúng `-p morpho`; đổi project
  name sẽ tạo volume rỗng và deployment mới sẽ không thấy bundle cũ.

Kiểm tra registry trước khi migrate:

```bash
if [ -f "$BACKUP/data/presigned.json" ]; then
  jq '{version, bundles: (.bundles | length), consumedNonce}' "$BACKUP/data/presigned.json"
else
  echo "Chưa có registry — bản mới sẽ tạo file rỗng khi cần"
fi
```

- `version: 3` hoặc `2`: tương thích, không cần convert tay.
- `version: 1` hoặc file bare bundle: bản mới **không đọc được**. Giữ image cũ
  và ký lại bundle theo registry v2/v3 trước khi chuyển; đừng start bản mới với
  file này.

## 4. Dừng stack cũ

```bash
cd /srv/morpho-monitor
docker compose down
docker compose ps
```

`down` không có `-v` sẽ giữ volume. Kiểm tra volume vẫn còn:

```bash
docker volume ls | grep presigned_data
```

## 5. Cập nhật source

```bash
cd /srv/morpho-monitor
git status --short
git fetch origin
git switch main 2>/dev/null || git switch -c main --track origin/main
git merge --ff-only origin/main
git rev-parse --short HEAD
git cat-file -e HEAD:chain-config.mjs && git cat-file -e HEAD:config/chains.json \
  && echo "đã có chain-config"
```

Kỳ vọng `c46ab21` hoặc commit mới hơn trên `main`. Nếu remote không tên
`origin`, thay bằng tên thật (`git remote -v`). Nếu `git merge --ff-only`
thất bại, local `main` đang có commit riêng: đừng `reset --hard`; kiểm tra
`git log --oneline --left-right main...origin/main` rồi xử lý thủ công.

- Không dùng `git reset --hard` nếu đang có thay đổi chưa commit.
- `.env`, `config/markets.json`, `data/` là file local/gitignored; `git pull`
  không ghi đè chúng.
- Nếu bạn từng sửa `docker-compose.yml` (bind IP, volume ngoài, network), backup
  file đó và merge thay đổi thủ công; đừng để `git pull` nuốt mất.
- Đảm bảo host có `config/chains.json` trong thư mục được mount vào
  `/app/config`. Nếu config nằm ngoài repo:
  `cp config/chains.json /đường/dẫn/config/chains.json`.

## 6. Cập nhật `.env`

Nếu bản cũ còn ở thời **single-market** (trước multi-market), tạo
`config/markets.json` trước khi start. Các key cũ `MARKET_ID`,
`MIN_LIQUIDITY_THRESHOLD_USDC`, `SUDDEN_DRAIN_MULTIPLIER` không còn được đọc;
chuyển market id và ngưỡng tương ứng vào file JSON (kiểm tra decimals của loan
token khi đổi ngưỡng):

```json
{
  "version": 1,
  "markets": [
    { "id": "0x...64-hex...", "minLiquidity": "100", "suddenDrainMultiplier": 2 }
  ]
}
```

Thêm/sửa tối thiểu cho deployment Ethereum:

```dotenv
CHAIN_ID=1
CHAIN_CONFIG_FILE=./config/chains.json
CONTAINER_NAME=morpho
MORPHO_BLUE_ADDRESS=
```

Nếu `.env` cũ được copy từ `.env.example` cũ, nó có thể còn dòng
`RPC_URLS=...,https://YOUR_PROVIDER.example/YOUR_RPC_KEY`. Hãy xoá endpoint
placeholder đó hoặc thay bằng endpoint thật trước khi probe; giữ nguyên sẽ làm
probe đỏ dù các endpoint còn lại vẫn tốt.

`MORPHO_BLUE_ADDRESS=` để trống là cách khuyến nghị: địa chỉ được lấy từ
`config/chains.json`. Nếu giữ địa chỉ ETH cũ `0xBBB...FFCb` thì vẫn hợp lệ vì
khớp chain. Chỉ dùng `ALLOW_CUSTOM_MORPHO=1` khi thật sự chạy fork/testnet có
Morpho contract khác.

Kiểm tra tiếp các biến sau:

- `RPC_URLS`: giữ endpoint riêng nếu có. **Mọi endpoint phải trả chain 1.**
  Bỏ trống để dùng `publicRpcUrls` của Ethereum trong `chains.json`.
- `PUBLIC_RPC_URLS`: để trống để dùng danh sách của chain, hoặc set danh sách
  key-less. Không đưa URL có API key vào đây: webapp public sẽ fail-fast.
- `WSS_URLS`: hành vi nhất quán với bản cũ: bỏ hẳn dòng này ⇒ dùng
  `wsRpcUrls` của Ethereum (mặc định publicnode); set `WSS_URLS=` (rỗng) ⇒
  HTTP-only.
- `WEBAPP_PORT`, `PROXY_PORT`: phải khớp port muốn publish. Compose mới map
  `${WEBAPP_PORT}:${WEBAPP_PORT}` và `${PROXY_PORT}:${PROXY_PORT}`.
- `PROXY_RPC_URL`: chỉ set nếu proxy ở host/port khác; nếu không, để trống để
  derive từ `WEBAPP_URL` + `PROXY_PORT`.
- `WEBAPP_PASSWORD`: phải có khi bind public (webapp fail-fast nếu trống).
- `MARKETS_FILE`: phải trỏ tới file JSON hợp lệ, 1–9 market.
- `CONTAINER_NAME`: giữ `morpho` nếu chỉ có một deployment; đặt tên khác nếu
  chạy nhiều chain trên cùng host.

Không copy đè `.env.example` lên `.env`; file example chứa placeholder và sẽ
xoá secret hiện có.

## 7. Kiểm tra cấu hình trước khi start

Build image mới trước:

```bash
cd /srv/morpho-monitor
docker compose build --pull
# Service probe nằm trong profile "debug": `build` mặc định bỏ qua profile,
# nên phải build riêng. Nếu không, `run probe` có thể dùng image cũ và import
# shared.mjs cũ (thiếu CHAIN_ID) — lỗi trước cả khi start stack.
docker compose --profile debug build probe
```

Kiểm tra chain registry + env bằng chính code mới:

```bash
docker compose run --rm --no-deps --entrypoint node morpho \
  --env-file=/app/.env \
  -e "import('./shared.mjs').then(m => console.log(JSON.stringify({chainId:m.CHAIN_ID, chain:m.CHAIN_NAME, morpho:m.MORPHO_BLUE_ADDRESS, rpc:m.RPC_URLS.length, publicRpc:m.PUBLIC_RPC_URLS.length, wss:m.WSS_URLS.length}, null, 2)))"
```

Kỳ vọng thấy `chainId: 1`, `chain: "Ethereum"`, địa chỉ Morpho ETH, và số RPC
lớn hơn 0.

Probe toàn bộ `RPC_URLS` từ trong môi trường Docker:

```bash
docker compose --profile debug run --rm probe
```

Nếu image `probe` đã từng được build trước bản chain-config, luôn build lại
service đó trước khi chạy (lệnh ở trên). Compose chỉ tự build khi image **chưa
tồn tại**, không tự phát hiện image cũ.

Script trả exit 1 nếu có endpoint sai chain, không đọc được `eth_chainId`, hoặc
`eth_call` lỗi. Sửa danh sách RPC trước khi start nếu command này đỏ.

## 8. Start và kiểm tra sau migration

```bash
docker compose up -d
docker compose ps
docker compose logs --tail=200 morpho
```

Log khởi động mong đợi (số market/RPC thay đổi theo cấu hình):

```text
[monitor] Ethereum (1) — 1 market(s), 2/2 HTTP RPC endpoint(s), 1 WSS, topic=...
[proxy] Chain: Ethereum (1) — Khởi tạo với 2/2 RPC endpoint(s)
⛓️  Chain:              Ethereum (1) — Morpho 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
📡 Browser RPC URLs:    ... (verified ... hoặc fallback tĩnh)
```

Nếu thấy `[rpc] chain 1: dùng X/Y endpoint; loại sai chain: ...` hoặc
`không phản hồi: ...`, endpoint bị loại không nhận `eth_call`/nonce nữa. Chỉ
cần xử lý nếu số endpoint còn lại quá ít hoặc bằng 0.

Kiểm tra proxy (đổi `8545` nếu `PROXY_PORT` khác). Nếu deployment bật
`SSL_CERT_PATH`/`SSL_KEY_PATH`, thay `http://` bằng `https://` và thêm `-k`
(chứng chỉ cấp cho domain nên không khớp `127.0.0.1`):

```bash
curl -s http://127.0.0.1:8545/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# → result "0x1"

curl -s http://127.0.0.1:8545/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"net_version","params":[]}'
# → result "1"

curl -s http://127.0.0.1:8545/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"morpho_proxyInfo","params":[]}'
# → chainId 1
```

Kiểm tra webapp và đọc market/position qua code mới:

```bash
curl -s http://127.0.0.1:3000/ | grep -o 'window.MORPHO_CONFIG=' | head -1
curl -s http://127.0.0.1:3000/ | grep -o '"chainId":[0-9]*' | head -1
# (đổi 3000 nếu WEBAPP_PORT khác)
# → "chainId":1

docker compose run --rm --no-deps --entrypoint node morpho \
  --env-file=/app/.env index.mjs
```

Mở webapp, đăng nhập, kiểm tra:

- `window.MORPHO_CONFIG.chainId === 1`
- `window.MORPHO_CONFIG.morphoBlueAddress` đúng địa chỉ ETH
- `rpcUrls` không chứa API key
- đọc được market/position, không có lỗi console
- kết nối ví yêu cầu switch sang chain 1, không bị đẩy sang chain khác

Kiểm tra registry đã có bundle (bỏ qua nếu chưa từng ký):

```bash
docker compose run --rm --no-deps --entrypoint node morpho \
  --env-file=/app/.env verify-presigned.mjs /app/data/presigned.json
```

Kiểm tra WSS và cache:

- Log có `[WSS] connected wss://...` nếu dùng WSS; `[WSS] không có endpoint —
  chạy HTTP-only` nếu `WSS_URLS=` rỗng.
- Webapp boot lần đầu có thể ghi `fallback tĩnh`; probe nền chạy xong sẽ ghi
  `verified ...`. Cache cũ dưới `PUBLIC_RPC_MIN_ENDPOINTS` (mặc định 4) bị bỏ
  qua nhưng không bị xoá.

## 9. Rollback

Nếu bản mới fail trước khi ghi gì vào registry:

```bash
cd /srv/morpho-monitor
docker compose -p morpho down
git switch --detach da1c3f4
docker compose -p morpho up -d --build
```

(Đổi `morpho` nếu compose project của bạn khác.)

Nếu chỉ muốn dùng lại image cũ đã tag, lấy đúng tên image compose đang dùng
rồi retag image cũ về tên đó:

```bash
IMAGE=$(docker compose -p morpho config --images | head -1)
OLD_ID=$(cat /srv/backup/migrate-<STAMP>/image-id.txt)
docker tag "$OLD_ID" "$IMAGE"
docker compose -p morpho down
docker compose -p morpho up -d --no-build
```

Bản `da1c3f4` đã dùng cùng registry v3, nên rollback **không cần restore data**;
chỉ checkout commit cũ và build lại. Không chạy lệnh xoá volume hay `down -v`.
Nếu registry thực tế là v2, bản mới đọc được và ghi lại v3; rollback vẫn đọc
được v3 nên cũng không cần restore.

## 10. Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
| --- | --- | --- |
| `CHAIN_CONFIG_MISSING` | Host thiếu `config/chains.json`, hoặc bind mount `./config` che file trong image | Copy `config/chains.json` vào đúng thư mục host; kiểm tra `CHAIN_CONFIG_FILE` |
| `UNSUPPORTED_CHAIN` | `CHAIN_ID` không có trong registry | Thêm entry vào `chains.json` hoặc sửa `CHAIN_ID` |
| `MORPHO_ADDRESS_MISMATCH` | `MORPHO_BLUE_ADDRESS` khác chain | Bỏ trống hoặc set đúng; fork mới dùng `ALLOW_CUSTOM_MORPHO=1` |
| `CHAIN_ID_MISMATCH` | Tất cả `RPC_URLS` trả sai chain | Chạy `docker compose --profile debug run --rm probe`; sửa/loại endpoint sai |
| `PUBLIC_RPC_URLS đang trống` | Không có URL browser hợp lệ | Để trống để dùng chain config, hoặc set URL key-less https |
| Webapp fail vì URL có credential | `PUBLIC_RPC_URLS` chứa API key | Bỏ URL đó khỏi danh sách browser; key chỉ nằm trong `RPC_URLS` |
| Container thứ hai không start | Trùng `CONTAINER_NAME`/project/port | Đặt `CONTAINER_NAME`, `WEBAPP_PORT`, `PROXY_PORT` khác nhau |
| Không thấy bundle cũ | Đổi compose project name ⇒ volume mới | Dùng đúng `-p`/project cũ; kiểm tra `docker volume ls` |
| `Presigned registry must use version 3 (or legacy version 2)` | Registry v1/bare bundle | Không start bản mới; giữ image cũ và ký lại registry v2/v3 |
| WSS không chạy | `WSS_URLS=` rỗng | Đây là HTTP-only có chủ ý; bỏ dòng để dùng WSS của chain |

## 11. Checklist ngắn

- [ ] Không còn bundle `broadcasting`; không có tab đang ký dở.
- [ ] Đã backup `.env`, `config/`, `/app/data`, image cũ, project/volume name.
- [ ] Đã `git pull` đúng `main`; `config/chains.json` có trên host.
- [ ] `.env` có `CHAIN_ID`, `CHAIN_CONFIG_FILE`, `CONTAINER_NAME`; `MORPHO_BLUE_ADDRESS` trống hoặc đúng chain.
- [ ] `RPC_URLS` toàn endpoint đúng chain; `PUBLIC_RPC_URLS` key-less.
- [ ] `docker compose build --pull` và `docker compose --profile debug build probe`; probe RPC xanh.
- [ ] Stack start; log có chain đúng và số RPC active > 0.
- [ ] Proxy trả `eth_chainId=0x1`, `net_version=1`.
- [ ] Webapp đọc market/position; `window.MORPHO_CONFIG.chainId=1`.
- [ ] Registry verify được; WSS/cache đúng như mong muốn.
