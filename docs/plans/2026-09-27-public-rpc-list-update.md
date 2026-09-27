# Cập nhật danh sách public RPC + lớp hybrid chainlist-probe (2026-09-27)

## Bối cảnh

User báo `https://eth.meowrpc.com` hay dính HTTP 429 trong webapp, yêu cầu bỏ
khỏi `PUBLIC_RPC_URLS` và tìm RPC chất lượng tốt hơn. Mở rộng thành hai lớp:

1. **Sửa tĩnh**: loại meowrpc, bổ sung 3 endpoint đã probe thật.
2. **Lớp hybrid** (kế hoạch được duyệt): thay vì danh sách hardcode chết theo
   thời gian, webapp-server tự fetch catalog chainlist định kỳ, probe từng ứng
   viên chủ động, và cache danh sách ĐÃ KIỂM CHỨNG cho browser; probe hỏng thì
   rơi về danh sách tĩnh, không bao giờ cụt hóa config.

## Bằng chứng probe thật — 2026-09-27 (POST JSON-RPC từ máy thật, Origin giả lập browser)

Vòng 1 — `eth_chainId`:

| Endpoint | Kết quả | Ghi chú |
|---|---|---|
| `ethereum-rpc.publicnode.com` | 200, CORS `*`, 0.48s | giữ |
| `eth.drpc.org` | DNS chết từ máy local | giữ (round-6 ghi nhận chạy tốt trên VPS) |
| `eth-mainnet.public.blastapi.io` | 200, CORS reflect origin, 0.63s | giữ |
| `gateway.tenderly.co/public/mainnet` | DNS chết từ máy local | giữ (lý do như drpc) |
| `1rpc.io/eth` | DNS chết từ máy local | giữ (lý do như drpc) |
| `eth.meowrpc.com` ×3 | **200 → 429 → 200** | **429 tái hiện thật** — loại |
| `eth-pokt.nodies.app` | 200, CORS `*`, 0.65s | **thêm** |
| `ethereum-public.nodies.app` | 200, CORS `*`, 0.55s | **thêm** |
| `eth.merkle.io` | **429 ngay request đầu** | loại |
| `eth.llamarpc.com` | HTTP 525 SSL handshake fail | loại (giống round-4) |
| `rpc.notadegen.com` | TLS fail | loại |
| `eth.rpc.blxrbdn.com` | 200 nhưng thiếu eth_getLogs | loại |
| `rpc.mevblocker.io` | 200, CORS reflect origin, 0.53s | **thêm** |
| `rpc.flashbots.net` | 200 nhưng **từ chối eth_call** ("not whitelisted") | loại |

Vòng 2 — đầy đủ `eth_call` (USDC.decimals) + `eth_getLogs` (Morpho Blue) + receipt:

| Endpoint | eth_call | getLogs | receipt |
|---|---|---|---|
| eth-pokt.nodies.app | OK 0.47s | OK 0.52s | OK 0.53s |
| rpc.mevblocker.io | OK 0.49s | OK 0.39s | OK 0.34s |
| rpc.flashbots.net | ❌ không whitelisted | OK | OK |
| eth.rpc.blxrbdn.com | OK | ❌ method not available | OK |
| ethereum-public.nodies.app | OK 0.49s | OK 0.46s | OK 0.51s |

Vòng 3 — bổ sung ứng viên từ chainlist `tracking=none`:

| Endpoint | Kết quả |
|---|---|
| `eth.api.pocket.network` (gateway chính chủ POKT) | 200 đủ method, 0.87–1.19s — thêm vào list trong audit vòng 2 |
| `ethereum-json-rpc.stakely.io` | đủ method nhưng 6.7–7.7s/request — loại |
| `0xrpc.io/eth` | DNS chết từ máy local |
| `rpc.fullsend.to` | 200 đủ method 0.46–1.33s — loại: preflight OPTIONS không ACAO (audit vòng 2) |
| `eth.blockrazor.xyz` (+`/maxbackrun`, `/fullprivacy`) | 200 đủ method 0.21–0.27s, preflight đạt — thêm vào list trong audit vòng 2 |
| `rpc-eth.blockmachine.io` | 200 đủ method 0.37–0.79s, preflight đạt — thêm vào list trong audit vòng 2 |

## Audit vòng 2 (cùng ngày): blind spot CORS preflight + 5 lỗi phát sinh

Kiểm tra chéo bằng curl OPTIONS preflight (browser phải qua preflight trước
MỌI POST cross-origin mang content-type) cho thấy **probe cũ chỉ nhìn ACAO
trên POST response** — cùng blind spot kiểu này đã duyệt nhầm flashbots/
merkle/blxrbdn từ round-4:

| # | Lỗi | Bằng chứng | Cách sửa |
|---|---|---|---|
| F1 | Probe không kiểm OPTIONS preflight ⇒ duyệt endpoint browser không dùng được | `eth-pokt/ethereum-public.nodies.app`, `rpc.fullsend.to`: OPTIONS 200 KHÔNG ACAO (×2 runs) dù POST có | `probePublicRpc` gửi OPTIONS trước POST, yêu cầu ACAO; test ghim kịch bản nodies |
| F2 | `PUBLIC_RPC_PROBE_TIMEOUT_MS` dead config | chỉ xuất hiện ở shared.mjs | thành default timeout duy nhất của probe |
| F3 | ETag tuyên bố 3 chỗ nhưng không implement | fetch không gửi If-None-Match | cache thêm `catalogEtag`+`candidateUrls`; 304 ⇒ tái dùng candidate; test pin 200→304 |
| F4 | 2/8 endpoint tĩnh mới (nodies) chết trong browser | preflight rớt như F1 | thay bằng `eth.blockrazor.xyz` + `rpc-eth.blockmachine.io` (đã verify preflight + method); pin `not.toMatch(/nodies\.app/)` |
| F5 | Không có test cho cơ chế rebuild HTML (`content` dạng hàm) | grep trống trong __tests__ | ĐÃ ĐÓNG: tách orchestration thành `webapp-serving.mjs` (factory injectable) + `__tests__/webapp-serving.test.mjs` (10 test, trong đó pin "getHtml() đổi sau refreshOnce() mà không restart") |
| F6 | Probe race: 4 worker song song, endpoint yếu 429 tùy thứ tự | phân tích code + triệu chứng meowrpc | retry đúng 1 lần cho lỗi TẠM THỜI (429/-32005/timeout/mạng), không retry lỗi logic |

## Kích thước catalog chainlist (đầu vào lớp hybrid)

- `https://chainlist.org/rpcs.json`: HTTP 200 + CORS `*` + ETag, 2946 chains,
  2.3MB raw / **~272KB gzip**; Ethereum mainnet: 65 RPC, 24 cái `tracking:"none"`.
- KHÔNG có endpoint JSON theo từng chain (đã thử 3 dạng URL — 404) ⇒ phải tải
  cả file. Fetch 1 lần/ngày: chu kỳ sau gửi If-None-Match, 304 ⇒ tái dùng
  candidateUrls đã cache trong cache file, không parse lại ~2.3MB (đã
  implement + test ghim; audit vòng 2 phát hiện lời hứa ETag trước đây
  chưa từng được code).
- **Phát hiện then chốt**: meowrpc (429), merkle (429), flashbots (không có
  eth_call) đều vẫn nằm trong nhóm `tracking:"none"` của chainlist ⇒ catalog
  là nơi liệt kê, KHÔNG phải health probe. Chainlist trả lời "không tracking",
  không trả lời "đang khỏe" — probe server-side là bộ lọc chất lượng thực.

## Danh sách mặc định mới (fallback tĩnh — shared.mjs / webapp-state.mjs)

1. `https://ethereum-rpc.publicnode.com`
2. `https://eth.drpc.org`
3. `https://eth-mainnet.public.blastapi.io`
4. `https://gateway.tenderly.co/public/mainnet`
5. `https://1rpc.io/eth`
6. `https://eth.blockrazor.xyz` ← mới (audit vòng 2 thay nodies)
7. `https://rpc-eth.blockmachine.io` ← mới (audit vòng 2 thay nodies)
8. `https://rpc.mevblocker.io` ← mới

Loại kèm bằng chứng (đừng thêm lại): meowrpc (429 thất thường — tái hiện
200→429→200 trong 3 request liên tiếp), ankr key-less (chết từ round-4),
merkle (429 request đầu), flashbots (không có eth_call), blxrbdn (thiếu
getLogs), llamarpc (525), notadegen (TLS), stakely (7s/request),
2×nodies + fullsend (preflight OPTIONS không ACAO — audit vòng 2).

## Thiết kế lớp hybrid

```
chainlist.org/rpcs.json ──fetch (ETag, 24h/lần)──▶ [public-rpc-health.mjs]
                                                    1. extractCandidates: chain 1,
                                                       https, tracking:"none"
                                                    2. guard: loại credential
                                                       (urlLooksCredentialed),
                                                       host private/loopback (SSRF)
                                                    3. probePublicRpc: chainId +
                                                       blockNumber + eth_call +
                                                       getLogs + receipt +
                                                       feeHistory, yêu cầu CORS
                                                       header, nghiêm cấm 429
                                                    4. chọn ≤ MAX endpoint nhanh
                                                       nhất, ghi cache JSON v1
                              cache: data/public-rpcs-verified.json
webapp-server ──boot đọc cache; refresh nền mỗi PUBLIC_RPC_REFRESH_HOURS──▶
     └─ buildWebappConfig({ verifiedRpcUrls, verifiedAt }) → inject vào HTML
browser ◀── window.MORPHO_CONFIG.rpcUrls (+ rpcVerifiedAt để UI hiển thị)
Probe hỏng / catalog lỗi / cache cũ ──▶ giữ/fallback danh sách tĩnh (KHÔNG ghi cache)
```

### Quy tắc precedence

```
env PUBLIC_RPC_URLS (operator override) > verified cache > default tĩnh 8 URL
```

- `buildWebappConfig` mù nguồn: verified được truyền thì thắng (server chịu
  trách nhiệm không truyền khi operator override — nó đọc `process.env`).
- Guard credential chạy trên DANH SÁCH HIỆU QUẢ cuối cùng (verified đến từ
  catalog bên ngoài nên phải qua cùng cửa chặn, fail closed như cũ).
- Verified rỗng/cũ/hỏng ⇒ bỏ qua lớp động, KHÔNG BAO GIÒ để config rpcUrls
  trống hay cụt dưới ngưỡng probe tối thiểu.

### Biến môi trường mới (shared.mjs)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PUBLIC_RPC_REFRESH_HOURS` | 24 | Chu kỳ refresh; **0 = tắt lớp động** |
| `PUBLIC_RPC_MIN_ENDPOINTS` | 4 | Ngưỡng tối thiểu đạt probe mới được ghi cache |
| `PUBLIC_RPC_MAX_ENDPOINTS` | 8 | Trần endpoint đưa cho browser |
| `PUBLIC_RPC_CACHE_MAX_AGE_HOURS` | 48 | Cache cũ hơn ⇒ bỏ qua (fallback tĩnh) |
| `PUBLIC_RPC_HEALTH_PATH` | `./data/public-rpcs-verified.json` | Đường dẫn cache |
| `PUBLIC_RPC_PROBE_TIMEOUT_MS` | 8000 | Timeout mỗi request probe (dùng chung probe + verify) |

### Hành vi mới đáng chú ý

- Boot webapp KHÔNG chờ probe (request đầu dùng cache hoặc danh sách tĩnh);
  refresh chạy nền, xong thì HTML được build lại — handler đọc `content` MỖI
  request nên tab mở lâu cũng nhận config RPC mới mà không cần F5.
- Probe chỉ gửi OPTIONS preflight + 6 method CHỈ ĐỌC, nhịp 150ms giữa request,
  concurrency 4 ⇒ ≤ ~250 request đọc/ngày — không tạo burst, không tốn phí.
  Lỗi tạm thời (429/timeout/mạng) retry đúng 1 lần; lỗi logic (thiếu method)
  thì không.
- UI: 1 dòng nhỏ dưới header (`renderRpcVerifiedNote` — webapp-shell.mjs)
  hiện "🩺 Danh sách RPC cho trình duyệt đã được server kiểm chứng lúc …"
  khi lớp động bật và đã từng probe thành công; ẩn khi fallback tĩnh.
- Script tay: `node scripts/refresh-public-rpcs.mjs [--out=<path>]` — probe
  ngay + in chi tiết đạt/rớt kèm lý do (429? thiếu method? CORS?) hoặc ghi
  cache với `--out`. Probe đúng danh sách operator khi `PUBLIC_RPC_URLS` set.

## Files thay đổi

| File | Thay đổi |
|---|---|
| `shared.mjs` | Default 8 endpoint; loại meowrpc kèm comment bằng chứng; 6 env mới |
| `webapp-state.mjs` | Đồng bộ fallback 8 URL; export `RPC_VERIFIED_AT`/`RPC_REFRESH_HOURS` |
| `public-rpc-health.mjs` | **MỚI** — catalog + guard + probe + cache (thuần, injectable) |
| `webapp-config.mjs` | `verifiedRpcUrls`/`verifiedAt`/`refreshHours`; guard trên danh sách hiệu quả |
| `webapp-serving.mjs` | **MỚI (đóng F5)** — factory `createHybridRpcServing`: sở hữu state verified/serving, boot đọc cache, refresh nền rebuild HTML; mọi dep injectable |
| `webapp-server.mjs` | Bootstrap thuần: gọi factory, `content: () => serving.getHtml()` |
| `webapp-handler.mjs` | Chấp nhận `content` là string hoặc `() => string` |
| `webapp.html` | Khối `#rpc-verified-note` |
| `webapp-shell.mjs` | `renderRpcVerifiedNote()` |
| `webapp-app.mjs` | Gọi `renderRpcVerifiedNote()` trong `init()` |
| `scripts/refresh-public-rpcs.mjs` | **MỚI** — probe tay/chẩn đoán/ghi cache |
| `__tests__/webapp-config-public-urls.test.mjs` | Ghim 8 URL mới + 5 test lớp hybrid |
| `__tests__/public-rpc-health.test.mjs` | **MỚI** — 31 test (mock fetch, không ra Internet) |
| `__tests__/webapp-serving.test.mjs` | **MỚI (đóng F5)** — 10 test orchestration: rebuild giữa chừng, guard operator/refresh-off, timer callback |

## Xác minh

- Lượt 1 (xây lớp hybrid): `npx vitest run` — 50 files / 676 passed / 7 skipped,
  oxlint 0 warning; UI checks 97/97; smoke boot thật: probe 18 ứng viên → 8/18
  đạt → cache ghi → config mang `rpcVerifiedAt`.
- Audit vòng 2 (sau fix F1–F6): `npx vitest run` — 50 files / 682 passed /
  7 skipped, oxlint 0 warning; smoke boot lại với probe preflight; UI checks lại
  trên danh sách mới.
- Đóng F5 (tách `webapp-serving.mjs` + test): `npx vitest run` — **51 files /
  692 passed / 7 skipped**, oxlint 0 warning. Smoke end-to-end trên server thật:
  GET / lúc t+2s (trước probe) trả `rpcVerifiedAt: null` + fallback tĩnh; GET /
  lúc t+28s (sau probe nền, KHÔNG restart) trả `rpcVerifiedAt` + verified list
  (blockrazor 95ms đứng đầu) — đúng cơ chế "tab mở lâu không cần F5".
- Chưa chạy thật từ VPS trong đợt này: khi deploy, chạy
  `node --env-file=.env scripts/refresh-public-rpcs.mjs` một lần để (a) tạo
  cache verified từ đúng mạng VPS, (b) xác nhận drpc/tenderly/1rpc sống hay
  chết từ VPS (máy dev bị DNS hỏng với 3 endpoint này — nghi mạng vùng, round-6
  ghi nhận 1rpc hoạt động đúng từ VPS). Nếu VPS cũng chết endpoint nào, lớp
  hybrid sẽ tự loại nó ở chu kỳ probe đầu tiên — không cần sửa code.

## Rủi ro & biên

- 2 gateway Nodies cùng operator POKT (tương quan lỗi cụm) — chấp nhận: browser
  round-robin 8 URL, probe sẽ tự loại cả hai nếu cụm POKT hỏng (còn 6 tĩnh).
- Chainlist là phụ thuộc bên ngoài: cả URL nguồn (pin cứng, không nhận từ env)
  lẫn dữ liệu đều qua 4 lớp chặn trước khi tới browser; catalog chết ⇒ probe
  hỏng ⇒ fallback tĩnh, webapp vẫn chạy.
- Server `RPC_URLS` (có key) và proxy không đổi; luồng nonce/bundle không đụng.
