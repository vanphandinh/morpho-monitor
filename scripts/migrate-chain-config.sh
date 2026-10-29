#!/usr/bin/env bash
#
# migrate-chain-config.sh — nâng deployment Ethereum từ da1c3f4 lên bản có
# chain-config (d4d74f0 trở lên).
#
# Script chạy TRÊN VPS, trong thư mục compose. Nó không tự xoá volume và
# không tự ý sửa lịch sử git. Trước khi dừng stack, script:
#   - kiểm tra repo đúng commit cũ và không có thay đổi tracked;
#   - backup .env, config, data trong container, image cũ và trạng thái compose;
#   - từ chối chạy nếu registry có bundle đang "broadcasting" hoặc version lạ.
#
# Luồng chính:
#   backup -> merge main -> cập nhật .env -> build -> preflight/probe
#   -> dừng stack cũ -> start stack mới -> verify proxy/webapp
#
# Nếu bước nào sau khi dừng stack thất bại, script in lệnh rollback. Có thể
# chạy lại với --resume khi repo đã ở bản chain-config nhưng lần trước bị lỗi.
#
# Usage:
#   bash scripts/migrate-chain-config.sh
#   bash scripts/migrate-chain-config.sh --yes
#   bash scripts/migrate-chain-config.sh --yes --project morpho
#   bash scripts/migrate-chain-config.sh --yes --resume
#
set -Eeuo pipefail

OLD_COMMIT="da1c3f4"
CHAIN_CONFIG_MERGE="d4d74f0"
REMOTE="${REMOTE:-origin}"
BRANCH="main"
CANONICAL_MORPHO="0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"

REPO_ROOT="$(pwd)"
BACKUP_ROOT=""
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
ASSUME_YES=0
RESUME=0
STACK_STOPPED=0
STACK_STARTED=0
BACKUP=""
ROLLBACK_HEAD="$OLD_COMMIT"

info() { printf '\n==> %s\n' "$*"; }
ok() { printf '✅ %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*"; }
fail() { printf '❌ %s\n' "$*" >&2; exit 1; }

# Compose project đã dò được (hoặc truyền qua --project). In kèm -p để lệnh
# rollback chạy đúng project thay vì project mặc định của thư mục hiện tại.
compose_cmd() {
  if [ -n "${PROJECT_NAME:-}" ]; then
    printf 'docker compose -p %s' "$PROJECT_NAME"
  else
    printf 'docker compose'
  fi
}

# In hướng dẫn rollback khi script dừng giữa chừng. Đăng ký trap NGAY từ đầu
# để lỗi ở bất kỳ bước nào (kể cả trước khi backup) cũng có thông tin.
on_exit() {
  local status=$?
  if [ "$status" -eq 0 ]; then
    return 0
  fi
  printf '\n❌ Migration dừng với exit %s.\n' "$status" >&2
  if [ -n "$BACKUP" ]; then
    printf 'Backup: %s\n' "$BACKUP" >&2
  fi
  if [ "$STACK_STARTED" -eq 1 ]; then
    printf 'Stack mới đang chạy nhưng verify thất bại; xem: %s logs --tail=200 morpho\n' "$(compose_cmd)" >&2
    printf 'Rollback nếu cần:\n' >&2
    printf '  cd %s\n' "$REPO_ROOT" >&2
    printf '  %s down\n' "$(compose_cmd)" >&2
    printf '  git switch --detach %s\n' "$ROLLBACK_HEAD" >&2
    printf '  %s up -d --build\n' "$(compose_cmd)" >&2
  elif [ "$STACK_STOPPED" -eq 1 ]; then
    printf 'Stack đang dừng. Rollback:\n' >&2
    printf '  cd %s\n' "$REPO_ROOT" >&2
    printf '  git switch --detach %s\n' "$ROLLBACK_HEAD" >&2
    printf '  %s up -d --build\n' "$(compose_cmd)" >&2
  else
    printf 'Stack cũ vẫn đang chạy (nếu có). Sửa lỗi rồi chạy lại; nếu repo đã có chain-config thì thêm --resume.\n' >&2
  fi
  return "$status"
}
trap on_exit EXIT

usage() {
  cat <<'EOF'
Usage: bash scripts/migrate-chain-config.sh [options]

Script nâng deployment Ethereum đang ở commit da1c3f4 lên bản chain-config
hiện tại trên main. Chạy trong thư mục compose (nơi có .env và docker-compose.yml);
thư mục clone mặc định của repo là morpho-monitor, không phải morpho/app.

Options:
  -y, --yes              Không hỏi xác nhận
  --project NAME         Compose project name (mặc định tự dò từ container/volume)
  --backup-dir DIR       Thư mục backup (mặc định: ../backup cạnh repo)
  --resume               Repo đã có chain-config nhưng lần migrate trước bị gián đoạn:
                         bỏ qua merge, chỉ backup/cấu hình/build/start lại
  --remote NAME          Git remote (mặc định: origin)
  -h, --help             In hướng dẫn này

Ví dụ:
  cd /srv/morpho-monitor
  bash /srv/migrate-chain-config.sh --yes

Lưu ý:
  - Không chạy script từ bản sao nằm trong repo nếu origin/main cũng chứa
    chính file này; git merge có thể từ chối vì file untracked. Copy script
    ra ngoài repo (ví dụ /srv/) rồi chạy.
  - Script không chạy `docker compose down -v` và không xoá volume.
  - Backup chứa .env và registry đã ký; giữ ngoài repo, không commit.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --resume) RESUME=1 ;;
    --project)
      [ "$#" -ge 2 ] || fail "--project cần một giá trị"
      PROJECT_NAME="$2"; shift ;;
    --project=*)
      PROJECT_NAME="${1#*=}" ;;
    --backup-dir)
      [ "$#" -ge 2 ] || fail "--backup-dir cần một đường dẫn"
      BACKUP_ROOT="$2"; shift ;;
    --backup-dir=*)
      BACKUP_ROOT="${1#*=}" ;;
    --remote)
      [ "$#" -ge 2 ] || fail "--remote cần một giá trị"
      REMOTE="$2"; shift ;;
    --remote=*)
      REMOTE="${1#*=}" ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      fail "Tham số không hợp lệ: $1 (dùng --help)" ;;
  esac
  shift
done

# ------------------------------------------------------------
# 0. Kiểm tra môi trường
# ------------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "Không tìm thấy git"
command -v docker >/dev/null 2>&1 || fail "Không tìm thấy docker"
command -v curl >/dev/null 2>&1 || fail "Không tìm thấy curl"
command -v awk >/dev/null 2>&1 || fail "Không tìm thấy awk"

docker compose version >/dev/null 2>&1 \
  || fail "Cần Docker Compose plugin (docker compose), không phải docker-compose v1"
docker info >/dev/null 2>&1 \
  || fail "Không kết nối được Docker daemon (kiểm tra quyền docker group)"

cd "$REPO_ROOT" 2>/dev/null || fail "Không vào được thư mục hiện tại: $REPO_ROOT"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" \
  || fail "Thư mục hiện tại không phải git repository"
cd "$REPO_ROOT"
[ -n "$BACKUP_ROOT" ] || BACKUP_ROOT="$(dirname "$REPO_ROOT")/backup"
[ -f .env ] || fail "Thiếu .env trong $REPO_ROOT"
[ -f docker-compose.yml ] || fail "Thiếu docker-compose.yml trong $REPO_ROOT"

# ------------------------------------------------------------
# 1. Đọc/ghi .env không làm mất secret hay comment
# ------------------------------------------------------------
env_get() {
  [ -f .env ] || return 0
  awk -v key="$1" '
    {
      line=$0
      sub(/\r$/, "", line)
      if (line ~ ("^[[:space:]]*(export[[:space:]]+)?" key "=")) {
        sub(/^[^=]*=/, "", line)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
        print line
        exit
      }
    }
  ' .env
}

env_set() {
  local key="$1" value="$2" tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/morpho-env.XXXXXX")
  awk -v key="$key" -v value="$value" '
    BEGIN { done=0 }
    {
      raw=$0
      line=raw
      sub(/\r$/, "", line)
      if (line ~ ("^[[:space:]]*(export[[:space:]]+)?" key "=")) {
        if (!done) { print key "=" value; done=1 }
        next
      }
      print raw
    }
    END { if (!done) print key "=" value }
  ' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

strip_rpc_placeholders() {
  printf '%s' "$1" | tr ',' '\n' | awk '
    {
      gsub(/^[ \t]+|[ \t]+$/, "", $0)
      if ($0 != "" && $0 !~ /YOUR_PROVIDER|YOUR_RPC_KEY/) {
        out = (out == "" ? $0 : out "," $0)
      }
    }
    END { print out }
  '
}

# ------------------------------------------------------------
# 2. Xác định compose project (kể cả khi stack đã dừng)
# ------------------------------------------------------------
project_from_volume() {
  local volumes count
  volumes=$(docker volume ls --format '{{.Name}}' | grep '_presigned_data$' || true)
  count=$(printf '%s\n' "$volumes" | grep -c . || true)
  [ "$count" -eq 1 ] || return 1
  printf '%s' "$volumes" | sed 's/_presigned_data$//'
}

ENV_CONTAINER=$(env_get CONTAINER_NAME || true)
if [ -z "$PROJECT_NAME" ]; then
  CANDIDATES=("morpho")
  [ -n "$ENV_CONTAINER" ] && CANDIDATES+=("$ENV_CONTAINER")
  for name in "${CANDIDATES[@]}"; do
    candidate=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$name" 2>/dev/null || true)
    candidate=$(printf '%s' "$candidate" | tr -d '\r')
    [ "$candidate" = "<no value>" ] && candidate=""
    if [ -n "$candidate" ]; then
      PROJECT_NAME="$candidate"
      break
    fi
  done
fi
if [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME=$(project_from_volume || true)
fi
[ -n "$PROJECT_NAME" ] \
  || fail "Không xác định được compose project; chạy lại với --project <tên>"
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"

CID=$(docker compose ps -q morpho 2>/dev/null | head -1 || true)
ACTUAL_CONTAINER="morpho"
OLD_IMAGE_ID=""
if [ -n "$CID" ]; then
  ACTUAL_CONTAINER=$(docker inspect -f '{{.Name}}' "$CID" | sed 's#^/##')
  OLD_IMAGE_ID=$(docker inspect -f '{{.Image}}' "$CID")
fi

# Migration lần đầu bắt buộc stack cũ đang chạy: nếu không, rất dễ tạo volume
# mới và bỏ mất registry đang có. Chỉ --resume mới được phép khi stack dừng.
if [ "$RESUME" -ne 1 ] && [ -z "$CID" ]; then
  fail "Không thấy container morpho đang chạy trong project '$PROJECT_NAME'. Kiểm tra --project hoặc start stack cũ trước."
fi

info "Thông tin deployment"
printf '  Repo:      %s\n' "$REPO_ROOT"
printf '  Project:   %s\n' "$PROJECT_NAME"
printf '  Container: %s\n' "${CID:-"(chưa chạy)"}"
printf '  Backup:    %s\n' "$BACKUP_ROOT"

# ------------------------------------------------------------
# 3. Kiểm tra repo, commit và remote
# ------------------------------------------------------------
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" >&2
  fail "Có thay đổi tracked chưa commit. Commit/stash thủ công rồi chạy lại."
fi

has_chain_config() {
  local rev="$1"
  git cat-file -e "$rev:chain-config.mjs" 2>/dev/null \
    && git cat-file -e "$rev:config/chains.json" 2>/dev/null
}

CURRENT_HEAD=$(git rev-parse HEAD)

if has_chain_config "$CURRENT_HEAD"; then
  if [ "$RESUME" -ne 1 ]; then
    if [ -n "$CID" ]; then
      ok "Repo đã có chain-config và stack đang chạy — không cần migrate."
      exit 0
    fi
    fail "Repo đã có chain-config nhưng stack chưa chạy. Dùng --resume để build/start lại."
  fi
  info "Chế độ --resume: bỏ qua merge, tiếp tục cấu hình/build/start."
  NEW_HEAD="$CURRENT_HEAD"
else
  [ "$RESUME" -eq 1 ] && fail "--resume chỉ dùng khi repo đã có chain-config"
  [ "$CURRENT_HEAD" = "$(git rev-parse "$OLD_COMMIT")" ] \
    || fail "Script chỉ hỗ trợ từ $OLD_COMMIT; HEAD hiện tại là $(git rev-parse --short HEAD)"

  info "Fetch $REMOTE/$BRANCH..."
  git fetch "$REMOTE" "$BRANCH"
  NEW_HEAD=$(git rev-parse "$REMOTE/$BRANCH")
  has_chain_config "$NEW_HEAD" \
    || fail "$REMOTE/$BRANCH chưa có chain-config ($CHAIN_CONFIG_MERGE)"
  git merge-base --is-ancestor "$CURRENT_HEAD" "$NEW_HEAD" \
    || fail "Không thể fast-forward: local HEAD không phải ancestor của $REMOTE/$BRANCH"

  # `git merge` sẽ từ chối nếu một file SẮP được thêm bởi commit mới đang tồn
  # tại nhưng untracked. Gặp trước khi backup/merge để không phải đoán lỗi git.
  UNTRACKED_CONFLICTS=$(git diff --name-only --diff-filter=A "$CURRENT_HEAD" "$NEW_HEAD" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    if [ -e "$file" ] && ! git ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
      printf '%s\n' "$file"
    fi
  done)
  if [ -n "$UNTRACKED_CONFLICTS" ]; then
    printf 'Các file sau đang untracked nhưng commit mới sẽ thêm chúng:\n%s\n' "$UNTRACKED_CONFLICTS" >&2
    fail "Di chuyển các file trên ra ngoài repo (hoặc xoá nếu chỉ là bản copy) rồi chạy lại."
  fi
fi

# ------------------------------------------------------------
# 4. Kiểm tra .env trước khi backup/dừng stack
# ------------------------------------------------------------
CHAIN_ID=$(env_get CHAIN_ID || true)
case "$CHAIN_ID" in
  ""|1) ;;
  *) fail "CHAIN_ID hiện tại là '$CHAIN_ID'; script chỉ migrate deployment Ethereum (CHAIN_ID=1)" ;;
esac

MORPHO=$(env_get MORPHO_BLUE_ADDRESS || true)
MORPHO_LOWER=$(printf '%s' "$MORPHO" | tr '[:upper:]' '[:lower:]')
if [ -n "$MORPHO_LOWER" ] && [ "$MORPHO_LOWER" != "$CANONICAL_MORPHO" ]; then
  ALLOW_CUSTOM=$(env_get ALLOW_CUSTOM_MORPHO || true)
  case "$ALLOW_CUSTOM" in
    1|true|TRUE|yes|YES) ;;
    *) fail "MORPHO_BLUE_ADDRESS=$MORPHO không phải địa chỉ Morpho ETH chuẩn. Nếu là fork, đặt ALLOW_CUSTOM_MORPHO=1 trong .env rồi chạy lại." ;;
  esac
fi

RPC_OLD=$(env_get RPC_URLS || true)
RPC_NEW=$(strip_rpc_placeholders "$RPC_OLD")
if [ "$RPC_OLD" != "$RPC_NEW" ]; then
  warn "RPC_URLS có endpoint placeholder (YOUR_PROVIDER/YOUR_RPC_KEY); script sẽ xoá các mục đó."
  [ -n "$RPC_NEW" ] || warn "Sau khi xoá, RPC_URLS trống — bản mới sẽ dùng publicRpcUrls của Ethereum."
fi

if [ -n "$CID" ]; then
  docker compose config --quiet
else
  docker compose config --quiet || fail "docker compose config không hợp lệ"
fi

# ------------------------------------------------------------
# 5. Xác nhận và backup
# ------------------------------------------------------------
printf '\nKế hoạch:\n'
printf '  - Commit:    %s -> %s\n' "$(git rev-parse --short "$CURRENT_HEAD")" "$(git rev-parse --short "$NEW_HEAD")"
printf '  - Project:   %s\n' "$PROJECT_NAME"
printf '  - Backup:    %s\n' "$BACKUP_ROOT/migrate-<timestamp>"
printf '  - Dữ liệu:   %s\n' "$([ -n "$CID" ] && echo "container $ACTUAL_CONTAINER" || echo "không có container đang chạy")"
printf '  - Không xoá volume, không dùng git reset --hard.\n'

if [ "$ASSUME_YES" -ne 1 ]; then
  if [ ! -t 0 ]; then
    fail "Không có TTY để xác nhận; chạy lại với --yes"
  fi
  printf '\nTiếp tục migrate? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) info "Đã huỷ."; exit 0 ;;
  esac
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$BACKUP_ROOT/migrate-$STAMP"
[ ! -e "$BACKUP" ] || fail "Backup đã tồn tại: $BACKUP"
mkdir -p "$BACKUP/data"
cp -a .env "$BACKUP/.env"
cp -a config "$BACKUP/config"

if [ -n "$CID" ]; then
  docker cp "$CID":/app/data/. "$BACKUP/data/" 2>/dev/null || true
  [ -n "$OLD_IMAGE_ID" ] && docker tag "$OLD_IMAGE_ID" morpho-monitor:pre-chain-config
fi

git rev-parse HEAD > "$BACKUP/commit.txt"
docker compose config > "$BACKUP/compose.rendered.yml"
docker compose ls > "$BACKUP/compose-projects.txt"
docker volume ls | grep "${PROJECT_NAME}_presigned_data" > "$BACKUP/volumes.txt" 2>/dev/null || true
[ -n "$OLD_IMAGE_ID" ] && printf '%s\n' "$OLD_IMAGE_ID" > "$BACKUP/image-id.txt"
[ -n "$CID" ] && printf '%s\n' "$ACTUAL_CONTAINER" > "$BACKUP/container-name.txt"
chmod -R go-rwx "$BACKUP"
ok "Backup: $BACKUP"

# Registry: không migrate dữ liệu, nhưng không được restart giữa lúc broadcast.
REGISTRY="$BACKUP/data/presigned.json"
VERIFY_PATH="/app/data/presigned.json"
PRESIGNED_ENV=$(env_get PRESIGNED_FILE || true)
if [ -n "$PRESIGNED_ENV" ] && [ -n "$CID" ]; then
  case "$PRESIGNED_ENV" in
    ./*) CONTAINER_PRESIGNED="/app/${PRESIGNED_ENV#./}" ;;
    /*) CONTAINER_PRESIGNED="$PRESIGNED_ENV" ;;
    *) CONTAINER_PRESIGNED="/app/$PRESIGNED_ENV" ;;
  esac
  if [ "$CONTAINER_PRESIGNED" != "/app/data/presigned.json" ]; then
    docker cp "$CID:$CONTAINER_PRESIGNED" "$BACKUP/presigned-custom.json" 2>/dev/null || true
    if [ -f "$BACKUP/presigned-custom.json" ]; then
      REGISTRY="$BACKUP/presigned-custom.json"
      VERIFY_PATH="$CONTAINER_PRESIGNED"
    fi
  fi
fi
if [ -f "$REGISTRY" ]; then
  VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*[0-9]\+' "$REGISTRY" | head -1 | grep -o '[0-9]\+' || true)
  case "$VERSION" in
    2|3) ;;
    *) fail "Registry version '$VERSION' không được hỗ trợ; giữ stack cũ và xử lý registry trước." ;;
  esac
  BROADCASTING=$(grep -c '"status"[[:space:]]*:[[:space:]]*"broadcasting"' "$REGISTRY" || true)
  if [ "${BROADCASTING:-0}" -ne 0 ]; then
    fail "Registry còn ${BROADCASTING} bundle đang broadcasting. Đợi receipt/mined rồi chạy lại."
  fi
  ok "Registry v$VERSION, không có bundle broadcasting."
fi

# ------------------------------------------------------------
# 6. Merge code (chỉ lần đầu)
# ------------------------------------------------------------
if [ "$RESUME" -ne 1 ]; then
  info "Cập nhật source lên $REMOTE/$BRANCH..."
  if git show-ref --verify --quiet refs/heads/main; then
    git switch main
  else
    git switch -c main --track "$REMOTE/$BRANCH"
  fi
  git merge --ff-only "$NEW_HEAD"
  [ "$(git rev-parse HEAD)" = "$NEW_HEAD" ] || fail "Merge không đưa HEAD tới $NEW_HEAD"
fi

has_chain_config HEAD \
  || fail "HEAD hiện tại không có chain-config"
[ -f config/chains.json ] \
  || fail "Thiếu config/chains.json trên host (bind mount ./config)"

# ------------------------------------------------------------
# 7. Cập nhật .env
# ------------------------------------------------------------
info "Cập nhật .env..."
[ -n "$(env_get CHAIN_ID || true)" ] || env_set CHAIN_ID 1
[ -n "$(env_get CHAIN_CONFIG_FILE || true)" ] || env_set CHAIN_CONFIG_FILE "./config/chains.json"
[ -n "$(env_get CONTAINER_NAME || true)" ] || env_set CONTAINER_NAME "$ACTUAL_CONTAINER"

if [ "$RPC_OLD" != "$RPC_NEW" ]; then
  env_set RPC_URLS "$RPC_NEW"
  ok "Đã xoá placeholder khỏi RPC_URLS."
fi

# ------------------------------------------------------------
# 8. Build, preflight và probe (trước khi dừng stack cũ)
# ------------------------------------------------------------
info "Build image mới..."
docker compose build --pull
# `docker compose build` KHÔNG build service thuộc profile chưa bật. Service
# `probe` nằm trong profile "debug" và có image riêng; nếu image đó còn từ bản
# cũ, `docker compose run probe` sẽ dùng shared.mjs cũ và fail trước khi start.
info "Build probe image (profile debug)..."
docker compose --profile debug build probe

info "Kiểm tra chain registry bằng code mới..."
CONFIG_OUT=$(docker compose run --rm --no-deps --entrypoint node morpho \
  --env-file=/app/.env \
  -e "import('./shared.mjs').then(m => console.log(JSON.stringify({chainId:m.CHAIN_ID, chain:m.CHAIN_NAME, morpho:m.MORPHO_BLUE_ADDRESS, rpc:m.RPC_URLS.length, publicRpc:m.PUBLIC_RPC_URLS.length, wss:m.WSS_URLS.length})))")
printf '%s\n' "$CONFIG_OUT"
printf '%s' "$CONFIG_OUT" | grep -Eq '"chainId"[[:space:]]*:[[:space:]]*1([^0-9]|$)' \
  || fail "Preflight không trả CHAIN_ID=1; kiểm tra .env và config/chains.json"
printf '%s' "$CONFIG_OUT" | grep -Eq '"chain"' \
  || fail "Preflight không trả thông tin chain"

info "Probe toàn bộ RPC_URLS..."
docker compose --profile debug run --rm probe

# ------------------------------------------------------------
# 9. Dừng stack cũ và start bản mới
# ------------------------------------------------------------
if [ "$RESUME" -eq 1 ] && [ -n "$CID" ]; then
  info "Recreate stack với image mới..."
  STACK_STOPPED=1
  docker compose up -d --force-recreate
else
  if [ -n "$CID" ]; then
    info "Dừng stack cũ..."
    docker compose down
    STACK_STOPPED=1
  else
    STACK_STOPPED=1
  fi
  docker compose up -d
fi
STACK_STARTED=1

# ------------------------------------------------------------
# 10. Verify sau start
# ------------------------------------------------------------
PROXY_PORT=$(env_get PROXY_PORT || true)
WEBAPP_PORT=$(env_get WEBAPP_PORT || true)
PROXY_PORT=${PROXY_PORT:-8545}
WEBAPP_PORT=${WEBAPP_PORT:-3000}

# Webapp/proxy chuyển sang HTTPS khi có đủ cặp cert/key (xem webapp-server.mjs
# và proxy-rpc.mjs). Verify qua 127.0.0.1 nên chứng chỉ theo domain sẽ không
# khớp CN ⇒ dùng https kèm -k; nếu không, deployment có Let's Encrypt sẽ báo đỏ
# dù stack đang chạy khỏe.
SCHEME=http
CURL_TLS=""
if [ -n "$(env_get SSL_CERT_PATH || true)" ] && [ -n "$(env_get SSL_KEY_PATH || true)" ]; then
  SCHEME=https
  CURL_TLS="-k"
fi

info "Verify proxy ($SCHEME, port $PROXY_PORT)..."
PROXY_OK=0
for _ in $(seq 1 30); do
  body=$(curl -fsS $CURL_TLS --max-time 3 "$SCHEME://127.0.0.1:${PROXY_PORT}/" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null || true)
  if printf '%s' "$body" | grep -Eq '"result"[[:space:]]*:[[:space:]]*"0x1"'; then
    PROXY_OK=1
    break
  fi
  sleep 2
done
if [ "$PROXY_OK" -ne 1 ]; then
  docker compose logs --tail=80 morpho >&2 || true
  fail "Proxy không trả eth_chainId=0x1 sau 60s"
fi
ok "Proxy trả eth_chainId=0x1."

info "Verify webapp ($SCHEME, port $WEBAPP_PORT)..."
WEBAPP_OK=0
for _ in $(seq 1 30); do
  html=$(curl -fsS $CURL_TLS --max-time 3 "$SCHEME://127.0.0.1:${WEBAPP_PORT}/" 2>/dev/null || true)
  if printf '%s' "$html" | grep -Eq '"chainId"[[:space:]]*:[[:space:]]*1([^0-9]|$)'; then
    WEBAPP_OK=1
    break
  fi
  sleep 2
done
if [ "$WEBAPP_OK" -ne 1 ]; then
  docker compose logs --tail=80 morpho >&2 || true
  fail "Webapp không inject chainId=1 sau 60s"
fi
ok "Webapp inject chainId=1."

info "Verify monitor đọc market/position..."
docker compose exec -T morpho node --env-file=/app/.env index.mjs

if [ -f "$REGISTRY" ]; then
  info "Verify registry (không chặn migrate nếu chỉ có cảnh báo)..."
  if ! docker compose exec -T morpho node --env-file=/app/.env verify-presigned.mjs "$VERIFY_PATH"; then
    warn "Registry verify thất bại; kiểm tra thủ công trước khi ký tiếp."
  fi
fi

docker compose ps
ok "Migration thành công: $(git rev-parse --short "$CURRENT_HEAD") -> $(git rev-parse --short HEAD)"
printf '  Backup: %s\n' "$BACKUP"
printf '  Rollback nếu cần: cd %s && git switch --detach %s && %s up -d --build\n' "$REPO_ROOT" "$ROLLBACK_HEAD" "$(compose_cmd)"
