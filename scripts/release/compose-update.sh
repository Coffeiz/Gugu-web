#!/usr/bin/env bash
set -euo pipefail

# 生产 Compose 安全更新入口。Phase 2 的 Admin 更新器通过同一边界调用。
# 明确禁止 down -v、无范围 prune 和覆盖用户配置。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${COMPOSE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
MANIFEST=""
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT_DIR/backup}"
VALIDATOR="${UPDATE_VALIDATOR:-$SCRIPT_DIR/validate-update-manifest.mjs}"
CONFIRMED=false
HANDOFF_EXIT_CODE=75

usage() {
  cat <<'EOF'
用法：scripts/release/compose-update.sh --manifest <update-manifest.json> --confirm

环境变量：
  COMPOSE_FILE   一体化生产 Compose 文件，默认 docker-compose.yml
  BACKUP_ROOT    更新备份目录，默认 ./backup

说明：脚本只更新 manifest 指定的 gugu-web 一体化应用 digest，不会更新基础服务、删除卷或全局清理。
EOF
}

while (($# > 0)); do
  case "$1" in
    --manifest)
      [[ $# -ge 2 ]] || { echo '缺少 --manifest 参数' >&2; exit 2; }
      MANIFEST="$2"
      shift 2
      ;;
    --confirm)
      CONFIRMED=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$MANIFEST" ]] || { echo '必须指定 --manifest' >&2; exit 2; }
[[ "$CONFIRMED" == true ]] || { echo '更新必须显式传入 --confirm' >&2; exit 2; }
[[ -f "$MANIFEST" ]] || { echo 'manifest 文件不存在' >&2; exit 1; }

# app 内的更新器不能在自己的容器里执行 stop app；否则后续 up 无法保证执行。
# 使用当前 app 镜像启动一次性 helper，helper 与 app 生命周期解耦，再由它完成整个 Compose 更新。
if [[ "${GUGU_UPDATE_HELPER:-0}" != 1 && -n "${GUGU_UPDATE_HELPER_IMAGE:-}" ]]; then
  command -v docker >/dev/null || { echo '未找到 Docker CLI' >&2; exit 1; }
  HELPER_IMAGE="$GUGU_UPDATE_HELPER_IMAGE"
  [[ "$HELPER_IMAGE" =~ ^(docker\.io|ghcr\.io)/coffeiz/gugu-web(@sha256:[a-f0-9]{64}|:[A-Za-z0-9_.-]{1,128})$ ]] \
    || { echo 'helper 镜像不在固定白名单内' >&2; exit 1; }
  APP_CONTAINER="$(cat /etc/hostname 2>/dev/null || true)"
  DATA_SOURCE="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$APP_CONTAINER" 2>/dev/null || true)"
  [[ -n "$DATA_SOURCE" && -d "$DATA_SOURCE" ]] || { echo '无法定位 /data 宿主机挂载，停止更新' >&2; exit 1; }
  DOCKER_SOCKET_SOURCE="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}{{.Source}}{{end}}{{end}}' "$APP_CONTAINER" 2>/dev/null || true)"
  [[ -n "$DOCKER_SOCKET_SOURCE" && -e "$DOCKER_SOCKET_SOURCE" ]] || { echo '无法定位 Docker socket 宿主机挂载，停止更新' >&2; exit 1; }
  HELPER_NAME="gugu-update-helper-${RANDOM}-${RANDOM}"
  docker run --rm --detach \
    --name "$HELPER_NAME" \
    --label com.coffeiz.gugu.update-helper=true \
    --entrypoint /bin/bash \
    --workdir "$ROOT_DIR" \
    --env GUGU_UPDATE_HELPER=1 \
    --env COMPOSE_PROJECT_DIR="$ROOT_DIR" \
    --env COMPOSE_FILE="$COMPOSE_FILE" \
    --env BACKUP_ROOT="$BACKUP_ROOT" \
    --env GUGU_UPDATER_CODE_DIR=/opt/gugu-updater \
    --env UPDATE_VALIDATOR=/opt/gugu-updater/scripts/release/validate-update-manifest.mjs \
    --env GUGU_WEB_IMAGE="${GUGU_WEB_IMAGE:-}" \
    --env GUGU_DB_PASSWORD \
    --env GUGU_DB_USER \
    --env GUGU_DB_NAME \
    --env DB__PASSWORD \
    --env DB__USER \
    --env DB__NAME \
    --env GUGU_UPDATE_WAIT_FOR_HANDOFF_FILE="${MANIFEST}.handoff" \
    --mount "type=bind,source=$ROOT_DIR,target=$ROOT_DIR,readonly" \
    --mount "type=bind,source=$DATA_SOURCE,target=/data" \
    --mount "type=bind,source=$DOCKER_SOCKET_SOURCE,target=/var/run/docker.sock" \
    "$HELPER_IMAGE" \
    /opt/gugu-updater/scripts/release/compose-update.sh --manifest "$MANIFEST" --confirm >/dev/null
  echo '更新任务已移交给独立 helper，当前 app 将按预期重启。'
  exit "$HANDOFF_EXIT_CODE"
fi
if [[ "${GUGU_UPDATE_HELPER:-0}" == 1 ]]; then
  if [[ -n "${GUGU_UPDATE_WAIT_FOR_HANDOFF_FILE:-}" ]]; then
    for _ in $(seq 1 600); do
      [[ -f "$GUGU_UPDATE_WAIT_FOR_HANDOFF_FILE" ]] && break
      sleep 0.1
    done
    [[ -f "$GUGU_UPDATE_WAIT_FOR_HANDOFF_FILE" ]] || { echo '更新 handoff 状态未确认，停止 helper' >&2; exit 1; }
    rm -f -- "$GUGU_UPDATE_WAIT_FOR_HANDOFF_FILE"
  fi
  trap 'rm -f -- "$MANIFEST"' EXIT
fi
[[ -f "$COMPOSE_FILE" ]] || { echo 'Compose 文件不存在' >&2; exit 1; }
[[ -f "$ROOT_DIR/backend/.env" ]] || { echo 'backend/.env 不存在，停止更新以保护运行配置' >&2; exit 1; }
command -v docker >/dev/null || { echo '未找到 Docker CLI' >&2; exit 1; }
command -v node >/dev/null || { echo '未找到 Node.js，无法校验 manifest' >&2; exit 1; }
[[ -n "${GUGU_DB_PASSWORD:-}" ]] || { echo '未设置 GUGU_DB_PASSWORD，停止更新' >&2; exit 1; }
grep -Eq '^[[:space:]]*ADMIN_PASSWORD[[:space:]]*=[^[:space:]]' "$ROOT_DIR/backend/.env" \
  || { echo 'backend/.env 未设置 ADMIN_PASSWORD，停止更新' >&2; exit 1; }

COMPOSE=(docker compose -f "$COMPOSE_FILE" --profile sandbox)
COMPOSE_SERVICES=$("${COMPOSE[@]}" config --services)
for required_service in app postgres; do
  grep -qx "$required_service" <<<"$COMPOSE_SERVICES" \
    || { echo "Compose 文件不支持一体化更新：缺少 $required_service 服务" >&2; exit 1; }
done

PREVIOUS_IMAGES=$("${COMPOSE[@]}" config --images)
SANDBOXD_WAS_RUNNING=false
if "${COMPOSE[@]}" ps --status running --services | grep -qx sandboxd; then
  SANDBOXD_WAS_RUNNING=true
fi

[[ -f "$VALIDATOR" ]] || { echo 'manifest 校验器不存在' >&2; exit 1; }
IMAGE_OUTPUT=$(node "$VALIDATOR" --print-images "$MANIFEST")
while IFS= read -r line; do
  case "$line" in
    GUGU_WEB_IMAGE=*) export "$line" ;;
    *) echo 'manifest 返回了未预期字段，停止更新' >&2; exit 1 ;;
  esac
done <<<"$IMAGE_OUTPUT"

[[ -n "${GUGU_WEB_IMAGE:-}" ]] || { echo 'manifest 缺少一体化应用镜像' >&2; exit 1; }

TARGET_SANDBOXD_IMAGE=$("${COMPOSE[@]}" config --format json | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => process.stdout.write(JSON.parse(input).services.sandboxd?.image ?? ""));
')
UPDATE_SANDBOXD=false
if [[ "$SANDBOXD_WAS_RUNNING" == true && "$TARGET_SANDBOXD_IMAGE" == "$GUGU_WEB_IMAGE" ]]; then
  UPDATE_SANDBOXD=true
fi

DB_USER="${GUGU_DB_USER:-gugu}"
DB_NAME="${GUGU_DB_NAME:-gugu}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/update-$STAMP"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# 备份只写入带时间戳目录，不写回仓库配置，也不在终端输出敏感内容。
cp "$ROOT_DIR/backend/.env" "$BACKUP_DIR/backend.env"
chmod 600 "$BACKUP_DIR/backend.env"
if [[ -f "$ROOT_DIR/.env" ]]; then
  cp "$ROOT_DIR/.env" "$BACKUP_DIR/compose.env"
  chmod 600 "$BACKUP_DIR/compose.env"
fi
printf '%s\n' "$PREVIOUS_IMAGES" > "$BACKUP_DIR/previous-images.txt"

if "${COMPOSE[@]}" ps --status running --services | grep -qx postgres; then
  "${COMPOSE[@]}" exec -T postgres pg_dump -U "$DB_USER" "$DB_NAME" > "$BACKUP_DIR/postgres.sql"
  chmod 600 "$BACKUP_DIR/postgres.sql"
else
  echo 'postgres 未运行，停止更新；未创建数据库备份' >&2
  exit 1
fi

echo '开始拉取 manifest 指定的一体化应用镜像...'
PULL_SERVICES=(app)
STOP_SERVICES=(app)
RECREATE_SERVICES=(app)
if [[ "$UPDATE_SANDBOXD" == true ]]; then
  PULL_SERVICES+=(sandboxd)
  STOP_SERVICES+=(sandboxd)
  RECREATE_SERVICES+=(sandboxd)
fi
"${COMPOSE[@]}" pull "${PULL_SERVICES[@]}"

# stop 不删除持久卷；仅在 sandboxd 使用同一一体化镜像且当前运行时才同步重建它。
"${COMPOSE[@]}" stop "${STOP_SERVICES[@]}"
echo '重新创建一体化应用服务...'
"${COMPOSE[@]}" up -d --no-deps --force-recreate "${RECREATE_SERVICES[@]}"

echo '等待应用健康检查...'
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T app curl -fsS http://127.0.0.1:9595/health >/dev/null; then
    echo "更新完成，备份目录：$BACKUP_DIR"
    exit 0
  fi
  sleep 2
done

echo '更新后应用健康检查失败；保留当前容器和备份，等待管理员按版本策略回滚' >&2
exit 1
