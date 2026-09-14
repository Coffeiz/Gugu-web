#!/usr/bin/env bash
# 从 v1.2.x 单容器部署（docker run / NAS 面板，内嵌 PostgreSQL/Redis）迁移到 Compose 部署。
#
# 背景：新版应用镜像不再内置数据库（PostgreSQL/Redis 由 Compose 独立服务提供），
# 直接重建旧容器会丢掉整个匿名卷——包括内嵌数据库。数据库从 17 跨版本到 18
# 不能直接拷数据目录，必须走 pg_dump/restore，这是本脚本存在的核心原因。
#
# 脚本做什么：
#   1. 从旧容器导出数据库（pg_dump，写入 backups/）；
#   2. 停旧容器；匿名卷部署把 /data 卷中的用户文件、BYOK 主密钥等复制到宿主机
#      Gugu-data 目录（剔除已导出的 postgres/、redis/ 数据目录）；目录映射
#      （bind）部署的数据已在宿主机，跳过复制、直接复用原目录；
#   3. 把旧 /data/.env 中的凭据（SECRET_KEY、ADMIN_PASSWORD 等）与容器环境
#      变量中的应用级键静默合并进 backend/.env，缺 GUGU_DB_PASSWORD 时自动生成；
#   4. 启动 Compose 的 postgres 服务并恢复数据库，再启动完整应用
#      （应用启动时自动把表结构迁移到新版）。
#
# 旧容器与匿名卷全程保留不删除；验证登录和历史数据完好后，按脚本结尾输出的
# 命令手动清理。回滚：docker compose stop && docker start <旧容器名>。
#
# 用法（在部署机上执行；--compose-dir 需包含仓库的 docker-compose.yml）：
#   scripts/migrate-single-container-to-compose.sh [--container gugu-web] \
#       [--compose-dir .] [--data-host-dir ./Gugu-data] [--force-restore] [--dry-run]
#
# 本脚本不回显任何密钥；凭据只写文件。

set -euo pipefail

OLD_CONTAINER="gugu-web"
COMPOSE_DIR="$(pwd)"
DATA_HOST_DIR="${GUGU_DATA_HOST_DIR:-}"
FORCE_RESTORE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --container) OLD_CONTAINER="$2"; shift 2 ;;
    --compose-dir) COMPOSE_DIR="$2"; shift 2 ;;
    --data-host-dir) DATA_HOST_DIR="$2"; shift 2 ;;
    --force-restore) FORCE_RESTORE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

log()  { printf '%s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi
}
trap 'warn "迁移中断：旧容器与旧匿名卷均未删除，可排查后重跑本脚本"' ERR

command -v docker >/dev/null 2>&1 || { warn "未找到 docker 命令"; exit 1; }

# ── 1. 确认旧容器是单容器（内嵌数据库）形态 ─────────────────────────────
docker inspect "$OLD_CONTAINER" >/dev/null 2>&1 || { warn "找不到容器：$OLD_CONTAINER"; exit 1; }
OLD_IMAGE=$(docker inspect "$OLD_CONTAINER" --format '{{.Config.Image}}')
if ! docker exec "$OLD_CONTAINER" sh -c 'test -f /data/postgres/PG_VERSION' 2>/dev/null; then
  warn "容器 $OLD_CONTAINER 内没有 /data/postgres，不是单容器（内嵌数据库）部署，无需本脚本"
  exit 1
fi
DB_USER=$(docker exec "$OLD_CONTAINER" sh -c 'printenv DB__USER' 2>/dev/null || true)
DB_USER=${DB_USER:-gugu}
DB_NAME=$(docker exec "$OLD_CONTAINER" sh -c 'printenv DB__NAME' 2>/dev/null || true)
DB_NAME=${DB_NAME:-gugu}

DATA_MOUNT_TYPE=$(docker inspect "$OLD_CONTAINER" --format \
  '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}{{end}}{{end}}')
case "$DATA_MOUNT_TYPE" in
  volume)
    DATA_VOLUME=$(docker inspect "$OLD_CONTAINER" --format \
      '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
    [ -n "$DATA_VOLUME" ] || { warn "旧容器 /data 卷名为空，无法定位数据"; exit 1; }
    DATA_DESC="匿名卷 $DATA_VOLUME"
    ;;
  bind)
    DATA_BIND_SOURCE=$(docker inspect "$OLD_CONTAINER" --format \
      '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')
    [ -n "$DATA_BIND_SOURCE" ] || { warn "旧容器 /data 为 bind 挂载但源路径为空"; exit 1; }
    DATA_DESC="目录映射 $DATA_BIND_SOURCE"
    ;;
  *)
    warn "旧容器 /data 挂载类型无法识别：${DATA_MOUNT_TYPE:-无挂载}"
    exit 1
    ;;
esac
WAS_RUNNING=$(docker inspect "$OLD_CONTAINER" --format '{{.State.Running}}')

log "旧容器：$OLD_CONTAINER（镜像 $OLD_IMAGE，/data $DATA_DESC）"
log "数据库：$DB_NAME（用户 $DB_USER）"

# ── 2. 导出数据库（趁内嵌 PG 还在运行）─────────────────────────────────
if [ "$WAS_RUNNING" != "true" ]; then
  log "旧容器未在运行，先临时启动以导出数据库"
  run docker start "$OLD_CONTAINER"
  sleep 5
fi
DUMP_FILE="$COMPOSE_DIR/backups/gugu-single-container-$(date +%Y%m%d-%H%M%S).sql"
if [ "$DRY_RUN" = "1" ]; then
  BYTES=$(docker exec "$OLD_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | wc -c)
  log "[dry-run] pg_dump 验证通过，导出体积 ${BYTES} 字节（未写文件）"
else
  mkdir -p "$COMPOSE_DIR/backups"
  chmod 700 "$COMPOSE_DIR/backups"
  docker exec "$OLD_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" > "$DUMP_FILE"
  [ -s "$DUMP_FILE" ] || { warn "导出文件为空，中止"; exit 1; }
  log "数据库已导出：$DUMP_FILE"
fi

# ── 3. 停旧容器；匿名卷部署复制数据文件，bind 部署直接复用原目录 ────────
run docker stop "$OLD_CONTAINER"
if [ "$DATA_MOUNT_TYPE" = "bind" ]; then
  if [ -n "$DATA_HOST_DIR" ] && [ "$DATA_HOST_DIR" != "$DATA_BIND_SOURCE" ]; then
    warn "--data-host-dir 与旧 bind 源不同；bind 部署的数据已在宿主机，忽略该参数"
  fi
  DATA_HOST_DIR="$DATA_BIND_SOURCE"
  log "bind 挂载：数据已在宿主机 $DATA_HOST_DIR，跳过文件复制"
  log "注意：目录中的 postgres/ 子目录是旧内嵌数据库，已不再使用，验证后可手动删除"
else
  [ -n "$DATA_HOST_DIR" ] || DATA_HOST_DIR="$COMPOSE_DIR/Gugu-data"
  log "复制 /data 数据文件到 $DATA_HOST_DIR（剔除 postgres/、redis/，已单独导出）"
  run docker run --rm --entrypoint sh \
    -v "$DATA_VOLUME:/from:ro" -v "$DATA_HOST_DIR:/to" \
    "$OLD_IMAGE" -c 'cp -a /from/. /to/ && rm -rf /to/postgres /to/redis'
fi

# ── 4. 旧 /data/.env 凭据静默合并进 backend/.env ───────────────────────
BACKEND_ENV="$COMPOSE_DIR/backend/.env"
run mkdir -p "$COMPOSE_DIR/backend"
if [ "$DRY_RUN" != "1" ] && [ ! -f "$BACKEND_ENV" ]; then
  : > "$BACKEND_ENV"
  chmod 600 "$BACKEND_ENV"
fi
if [ "$DATA_MOUNT_TYPE" = "volume" ]; then
  DATA_MOUNT_REF="$DATA_VOLUME:/from:ro"
else
  DATA_MOUNT_REF="$DATA_BIND_SOURCE:/from:ro"
fi
OLD_ENV_LINES=$(docker run --rm --entrypoint sh \
  -v "$DATA_MOUNT_REF" "$OLD_IMAGE" -c 'cat /from/.env' 2>/dev/null || true)
MERGED=0
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key=${line%%=*}
  [ -n "$key" ] || continue
  if [ "$DRY_RUN" = "1" ]; then
    MERGED=$((MERGED + 1))
  elif ! grep -q "^${key}=" "$BACKEND_ENV" 2>/dev/null; then
    printf '%s\n' "$line" >> "$BACKEND_ENV"
    MERGED=$((MERGED + 1))
  fi
done <<EOF
$OLD_ENV_LINES
EOF

# 面板/docker run 用户常把管理员密码等放在容器环境变量里；按白名单把应用级键
# （刻意排除 DB__* 等基础设施变量，新拓扑由 Compose 注入）合并进 backend/.env。
CONTAINER_ENV=$(docker inspect "$OLD_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}')
while IFS= read -r line; do
  case "$line" in
    ADMIN_USERNAME=*|ADMIN_PASSWORD=*|SECRET_KEY=*|PUBLIC_APP_URL=*|GUGU_PUBLIC_APP_URL=*) ;;
    *) continue ;;
  esac
  key=${line%%=*}
  [ -n "$key" ] || continue
  if [ "$DRY_RUN" = "1" ]; then
    MERGED=$((MERGED + 1))
  elif ! grep -q "^${key}=" "$BACKEND_ENV" 2>/dev/null; then
    printf '%s\n' "$line" >> "$BACKEND_ENV"
    MERGED=$((MERGED + 1))
  fi
done <<EOF
$CONTAINER_ENV
EOF
log "旧 /data/.env 与容器环境变量：$MERGED 个应用级键迁移到 backend/.env（凭据不回显）"

# ── 5. 确保根 .env 有 Compose 数据库密码 ───────────────────────────────
ROOT_ENV="$COMPOSE_DIR/.env"
if grep -q '^GUGU_DB_PASSWORD=.\+' "$ROOT_ENV" 2>/dev/null; then
  log "根 .env 已有 GUGU_DB_PASSWORD"
else
  GEN=$(head -c 16 /dev/urandom | md5sum | cut -c1-32)
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] 将生成 GUGU_DB_PASSWORD 写入 $ROOT_ENV"
  elif grep -q '^GUGU_DB_PASSWORD=' "$ROOT_ENV" 2>/dev/null; then
    sed -i "s/^GUGU_DB_PASSWORD=.*/GUGU_DB_PASSWORD=${GEN}/" "$ROOT_ENV"
    log "根 .env 的空 GUGU_DB_PASSWORD 已替换为随机密码"
  else
    printf 'GUGU_DB_PASSWORD=%s\n' "$GEN" >> "$ROOT_ENV"
    log "已生成 GUGU_DB_PASSWORD 写入 $ROOT_ENV"
  fi
fi

# ── 6. 启动 Compose 的 postgres 并恢复数据库 ───────────────────────────
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || { warn "$COMPOSE_DIR 下没有 docker-compose.yml，请用 --compose-dir 指定仓库部署目录"; exit 1; }
cd "$COMPOSE_DIR"
run docker compose up -d postgres
if [ "$DRY_RUN" != "1" ]; then
  log "等待 postgres 就绪…"
  i=0
  until docker compose exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -ge 60 ] && { warn "postgres 60 秒内未就绪，请查看 docker compose logs postgres"; exit 1; }
    sleep 1
  done
  TABLES=$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" \
    -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" || echo 0)
  if [ "${TABLES:-0}" -gt 0 ] && [ "$FORCE_RESTORE" != "1" ]; then
    warn "目标库已有 ${TABLES} 张表，为防覆盖中止恢复；确认是新库后加 --force-restore 重跑"
    exit 1
  fi
  log "恢复数据库…"
  docker compose exec -T postgres psql -q -v ON_ERROR_STOP=1 \
    -U "$DB_USER" -d "$DB_NAME" < "$DUMP_FILE"
  log "数据库恢复完成"
fi

# ── 7. 启动完整应用 ────────────────────────────────────────────────────
run docker compose up -d
log ""
log "迁移完成。应用启动时会自动把表结构迁移到新版，稍等 1-2 分钟后访问"
log "站点验证管理员登录与历史数据。以下资源被保留，确认无误后可手动清理："
log "  旧容器：docker rm $OLD_CONTAINER"
if [ "$DATA_MOUNT_TYPE" = "volume" ]; then
  log "  旧数据卷：docker volume rm $DATA_VOLUME"
else
  log "  旧内嵌数据库目录：$DATA_BIND_SOURCE/postgres（已不再使用）"
fi
log "需要回滚时：docker compose stop && docker start $OLD_CONTAINER"
