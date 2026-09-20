#!/usr/bin/env bash
set -euo pipefail

# 分体 Compose 固定服务更新入口。仅由挂载 Docker socket 的 updater sidecar 调用；
# 不修改用户 Compose/.env，不允许任意服务名，不执行 down -v 或全局清理。

ROOT_DIR="${COMPOSE_PROJECT_DIR:?必须指定 Compose 项目目录}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.prod.yml}"
MANIFEST="${1:-}"
BACKUP_ROOT="${BACKUP_ROOT:?必须指定受保护的 updater 备份目录}"
VALIDATOR="${UPDATE_VALIDATOR:-/opt/gugu-updater/scripts/release/validate-update-manifest.mjs}"
SCHEMA="${UPDATE_SCHEMA:-/opt/gugu-updater/deploy/update-manifest.schema.json}"
[[ -n "$MANIFEST" && -f "$MANIFEST" ]] || { echo 'manifest 文件不存在' >&2; exit 2; }
[[ -f "$COMPOSE_FILE" && -f "$VALIDATOR" && -f "$SCHEMA" ]] || { echo '分体更新所需固定文件缺失' >&2; exit 1; }
[[ -f "$ROOT_DIR/backend/.env" && ! -L "$ROOT_DIR/backend/.env" ]] || { echo 'backend/.env 缺失或不是普通文件' >&2; exit 1; }
command -v docker >/dev/null && command -v node >/dev/null || { echo 'Docker CLI 或 Node.js 不可用' >&2; exit 1; }

node "$VALIDATOR" --schema "$SCHEMA" >/dev/null
node "$VALIDATOR" "$MANIFEST" >/dev/null

COMPOSE=(docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" --profile sandbox)
CONFIG="$("${COMPOSE[@]}" config --format json)"
SERVICES="$(printf '%s' "$CONFIG" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(Object.keys(JSON.parse(s).services||{}).sort().join("\n")))')"
for name in postgres redis migrate backend worker gateway frontend nginx; do
  grep -qx "$name" <<<"$SERVICES" || { echo "分体 Compose 缺少固定服务：$name" >&2; exit 1; }
done

IMAGES="$(node -e '
  const m=require(process.argv[1]);
  process.stdout.write([m.split_images.backend_image,m.split_images.frontend_image].join("\n"));
' "$MANIFEST")"
TARGET_BACKEND="$(sed -n '1p' <<<"$IMAGES")"
TARGET_FRONTEND="$(sed -n '2p' <<<"$IMAGES")"
[[ "$TARGET_BACKEND" =~ ^(docker\.io|ghcr\.io)/coffeiz/gugu-web-backend@sha256:[a-f0-9]{64}$ ]] || { echo 'backend 镜像不符合白名单' >&2; exit 1; }
[[ "$TARGET_FRONTEND" =~ ^(docker\.io|ghcr\.io)/coffeiz/gugu-web-frontend@sha256:[a-f0-9]{64}$ ]] || { echo 'frontend 镜像不符合白名单' >&2; exit 1; }
ROLLBACK_SUPPORTED="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.rollback_supported === true ? "true" : "false")' "$MANIFEST")"

UPDATE_SERVICES=(backend worker gateway frontend)
PULL_SERVICES=(migrate backend worker gateway frontend)
SANDBOXD_UPDATE=false
if "${COMPOSE[@]}" ps --status running --services sandboxd 2>/dev/null | grep -qx sandboxd; then
  SANDBOXD_ID="$("${COMPOSE[@]}" ps -q sandboxd | head -n1)"
  CURRENT_BACKEND_ID="$("${COMPOSE[@]}" ps -q backend | head -n1)"
  if [[ -n "$SANDBOXD_ID" && -n "$CURRENT_BACKEND_ID" ]]; then
    SANDBOXD_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$SANDBOXD_ID")"
    CURRENT_BACKEND_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CURRENT_BACKEND_ID")"
    # 仅当正在运行的 sandboxd 与 backend 使用完全相同的镜像引用时才同步更新。
    if [[ "$SANDBOXD_IMAGE" == "$CURRENT_BACKEND_IMAGE" \
        && "$SANDBOXD_IMAGE" =~ ^(docker\.io|index\.docker\.io|ghcr\.io)/coffeiz/gugu-web-backend(:[A-Za-z0-9_.-]{1,128}|@sha256:[a-f0-9]{64})$ ]]; then
      SANDBOXD_UPDATE=true
      UPDATE_SERVICES+=(sandboxd)
      PULL_SERVICES+=(sandboxd)
    fi
  fi
fi

DB_USER="${GUGU_DB_USER:-gugu}"
DB_NAME="${GUGU_DB_NAME:-gugu}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/split-update-$STAMP"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
cp "$ROOT_DIR/backend/.env" "$BACKUP_DIR/backend.env"
chmod 600 "$BACKUP_DIR/backend.env"
if [[ -f "$ROOT_DIR/.env" && ! -L "$ROOT_DIR/.env" ]]; then
  cp "$ROOT_DIR/.env" "$BACKUP_DIR/compose.env"
  chmod 600 "$BACKUP_DIR/compose.env"
fi

if ! "${COMPOSE[@]}" ps --status running --services | grep -qx postgres; then
  echo 'PostgreSQL 未运行，拒绝更新' >&2
  exit 1
fi
"${COMPOSE[@]}" exec -T postgres pg_dumpall -U "$DB_USER" > "$BACKUP_DIR/postgres.sql"
chmod 600 "$BACKUP_DIR/postgres.sql"
[[ -s "$BACKUP_DIR/postgres.sql" ]] || { echo '数据库备份为空，拒绝更新' >&2; exit 1; }

echo '拉取分体业务镜像'
GUGU_BACKEND_IMAGE="$TARGET_BACKEND" GUGU_FRONTEND_IMAGE="$TARGET_FRONTEND" \
  "${COMPOSE[@]}" pull "${PULL_SERVICES[@]}"

OVERRIDE="$BACKUP_DIR/update.override.json"
ROLLBACK_OVERRIDE="$BACKUP_DIR/rollback.override.json"
PREVIOUS_BACKEND_ID="$("${COMPOSE[@]}" ps -q backend | head -n1)"
PREVIOUS_FRONTEND_ID="$("${COMPOSE[@]}" ps -q frontend | head -n1)"
[[ -n "$PREVIOUS_BACKEND_ID" && -n "$PREVIOUS_FRONTEND_ID" ]] || { echo '无法确认当前 backend/frontend 容器，拒绝更新' >&2; exit 1; }
PREVIOUS_BACKEND="$(docker inspect --format '{{.Config.Image}}' "$PREVIOUS_BACKEND_ID")"
PREVIOUS_FRONTEND="$(docker inspect --format '{{.Config.Image}}' "$PREVIOUS_FRONTEND_ID")"
[[ "$PREVIOUS_BACKEND" =~ ^(docker\.io|index\.docker\.io|ghcr\.io)/coffeiz/gugu-web-backend(:[A-Za-z0-9_.-]{1,128}|@sha256:[a-f0-9]{64})$ ]] || { echo '当前 backend 镜像超出恢复白名单' >&2; exit 1; }
[[ "$PREVIOUS_FRONTEND" =~ ^(docker\.io|index\.docker\.io|ghcr\.io)/coffeiz/gugu-web-frontend(:[A-Za-z0-9_.-]{1,128}|@sha256:[a-f0-9]{64})$ ]] || { echo '当前 frontend 镜像超出恢复白名单' >&2; exit 1; }
SANDBOXD_UPDATE="$SANDBOXD_UPDATE" node -e '
  const fs=require("node:fs");
  const [backend,frontend,path]=process.argv.slice(1);
  const services={migrate:{image:backend},backend:{image:backend},worker:{image:backend},gateway:{image:backend},frontend:{image:frontend}};
  if(process.env.SANDBOXD_UPDATE === "true") services.sandboxd={image:backend};
  fs.writeFileSync(path,JSON.stringify({services}));fs.chmodSync(path,0o600);
' "$TARGET_BACKEND" "$TARGET_FRONTEND" "$OVERRIDE"
SANDBOXD_UPDATE="$SANDBOXD_UPDATE" node -e '
  const fs=require("node:fs");
  const [backend,frontend,path]=process.argv.slice(1);
  const services={migrate:{image:backend},backend:{image:backend},worker:{image:backend},gateway:{image:backend},frontend:{image:frontend}};
  if(process.env.SANDBOXD_UPDATE === "true") services.sandboxd={image:backend};
  fs.writeFileSync(path,JSON.stringify({services}));fs.chmodSync(path,0o600);
' "$PREVIOUS_BACKEND" "$PREVIOUS_FRONTEND" "$ROLLBACK_OVERRIDE"
COMPOSE=(docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" -f "$OVERRIDE" --profile sandbox)

ROLLBACK_ARMED=false
rollback_on_exit() {
  local exit_code=$?
  if [[ "$ROLLBACK_ARMED" == true && "$ROLLBACK_SUPPORTED" == true ]]; then
    trap - EXIT
    echo '更新阶段失败，manifest 允许回滚，正在恢复原分体镜像...' >&2
    local rollback_compose=(docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" -f "$ROLLBACK_OVERRIDE" --profile sandbox)
    if "${rollback_compose[@]}" up -d --pull never --no-deps --force-recreate "${UPDATE_SERVICES[@]}" \
      && "${rollback_compose[@]}" exec -T backend curl -fsS http://127.0.0.1:8000/health >/dev/null; then
      echo '已恢复原 backend/frontend 镜像；数据库未自动回滚。' >&2
      exit 76
    else
      echo '自动恢复失败；原镜像与数据库备份均保留，需管理员介入。' >&2
    fi
  fi
  exit "$exit_code"
}
trap rollback_on_exit EXIT

echo '迁移检查'
"${COMPOSE[@]}" run --rm --no-deps --entrypoint python backend -m updater.database_check
echo '重新创建分体 backend'
ROLLBACK_ARMED=true
"${COMPOSE[@]}" up -d --no-deps --force-recreate backend
echo '健康检查'
HEALTHY=false
for _ in $(seq 1 45); do
  if "${COMPOSE[@]}" exec -T backend curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 2
done
if [[ "$HEALTHY" != true ]]; then
  echo 'backend 健康检查失败；保留新旧镜像与备份，要求管理员执行恢复' >&2
  exit 1
fi

echo '重新创建 worker、gateway 与 frontend'
"${COMPOSE[@]}" up -d --no-deps --force-recreate worker gateway frontend
if [[ "$SANDBOXD_UPDATE" == true ]]; then
  "${COMPOSE[@]}" up -d --no-deps --force-recreate sandboxd
fi
echo '更新完成；PostgreSQL、Redis、配置和数据卷未重建'
ROLLBACK_ARMED=false
