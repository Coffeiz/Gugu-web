#!/usr/bin/env bash
set -euo pipefail

# 分体 Compose 的 Docker 更新入口。可由受限 updater 调用，也可由管理员在部署主机执行；
# 不修改用户 Compose/.env，不允许任意服务名，不执行 down -v 或全局清理。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${COMPOSE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.prod.yml}"
MANIFEST=""
CONFIRMED=false
VERIFY_SIGNATURES=false
BACKUP_ROOT="${BACKUP_ROOT:-}"
VALIDATOR="${UPDATE_VALIDATOR:-$SCRIPT_DIR/validate-update-manifest.mjs}"
SCHEMA="${UPDATE_SCHEMA:-$SCRIPT_DIR/../../deploy/update-manifest.schema.json}"

usage() {
  cat <<'EOF'
用法：scripts/release/split-compose-update.sh --manifest <update-manifest.json> --confirm

环境变量：
  COMPOSE_PROJECT_DIR  分体 Compose 部署目录，默认使用当前仓库根目录
  COMPOSE_PROJECT_NAME Compose 项目名；若原部署用了 -p/自定义项目名则必须设置
  COMPOSE_FILE         Compose 文件，默认 docker-compose.prod.yml
  BACKUP_ROOT          受保护的备份目录，必须显式指定
  EXTERNAL_SANDBOX_CONTROL / EXTERNAL_SANDBOX_DOCKER_HOST
                       分体部署使用外置 Sandbox 时必填

此入口会校验发布镜像签名，依次拉取镜像、停止业务与 Sandbox、备份数据库和 users、
执行离线迁移并验证，然后才启动新版本。普通 Compose/NAS“拉取并重建”按钮不能替代此流程。
EOF
}

while (($# > 0)); do
  case "$1" in
    --manifest)
      [[ $# -ge 2 && -z "$MANIFEST" ]] || { echo '缺少或重复指定 --manifest' >&2; exit 2; }
      MANIFEST="$2"
      VERIFY_SIGNATURES=true
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
    -*)
      echo "未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      # 保留受限 updater 的旧调用形式；该调用方已在执行前验证发布签名。
      [[ -z "$MANIFEST" ]] || { echo '只能指定一个 manifest' >&2; exit 2; }
      MANIFEST="$1"
      shift
      ;;
  esac
done

[[ -n "$MANIFEST" ]] || { echo '必须指定 --manifest' >&2; exit 2; }
if [[ "$VERIFY_SIGNATURES" == true && "$CONFIRMED" != true ]]; then
  echo 'Docker 更新必须显式传入 --confirm' >&2
  exit 2
fi
[[ -n "$BACKUP_ROOT" ]] || { echo '必须指定受保护的 BACKUP_ROOT 备份目录' >&2; exit 2; }
[[ -n "$MANIFEST" && -f "$MANIFEST" ]] || { echo 'manifest 文件不存在' >&2; exit 2; }
[[ -f "$COMPOSE_FILE" && -f "$VALIDATOR" && -f "$SCHEMA" ]] || { echo '分体更新所需固定文件缺失' >&2; exit 1; }
[[ -f "$ROOT_DIR/backend/.env" && ! -L "$ROOT_DIR/backend/.env" ]] || { echo 'backend/.env 缺失或不是普通文件' >&2; exit 1; }
command -v docker >/dev/null && command -v node >/dev/null && command -v flock >/dev/null || { echo 'Docker CLI、Node.js 或 flock 不可用' >&2; exit 1; }

node "$VALIDATOR" --schema "$SCHEMA" >/dev/null
node "$VALIDATOR" "$MANIFEST" >/dev/null

COMPOSE=(docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" --profile sandbox)
CONFIG="$("${COMPOSE[@]}" config --format json)"
SERVICES="$(printf '%s' "$CONFIG" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(Object.keys(JSON.parse(s).services||{}).sort().join("\n")))')"
EXTERNAL_SANDBOX=false
MANAGER_EXTERNAL="$(printf '%s' "$CONFIG" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(String(JSON.parse(s).services?.backend?.environment?.GUGU_SANDBOX_MANAGER_MODE==="external")))')"
if ! grep -qx sandboxd <<<"$SERVICES" || [[ "$MANAGER_EXTERNAL" == true ]]; then
  EXTERNAL_SANDBOX=true
  [[ -n "${EXTERNAL_SANDBOX_CONTROL:-}" && -n "${EXTERNAL_SANDBOX_DOCKER_HOST:-}" ]] \
    || { echo 'external sandbox 未配置停服控制器和 Rootless socket，拒绝更新。' >&2; exit 1; }
fi
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

# 主机侧 Docker 更新入口不能依赖 updater daemon 的验签步骤，故在本地再次验证官方发布身份。
COSIGN_VERIFIER_IMAGE='ghcr.io/sigstore/cosign/cosign@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8'
COSIGN_IDENTITY_REGEXP='^https://github\.com/Coffeiz/Gugu-web/\.github/workflows/docker-release\.yml@refs/tags/v.*$'
COSIGN_OIDC_ISSUER='https://token.actions.githubusercontent.com'
if [[ "$VERIFY_SIGNATURES" == true ]]; then
  echo '验证 backend/frontend 发布签名'
  for image in "$TARGET_BACKEND" "$TARGET_FRONTEND"; do
    docker run --rm "$COSIGN_VERIFIER_IMAGE" verify \
      --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
      --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
      "$image" >/dev/null
  done
fi

PULL_SERVICES=(migrate backend worker gateway frontend)
SANDBOXD_UPDATE=false
if "${COMPOSE[@]}" ps --status running --services sandboxd 2>/dev/null | grep -x sandboxd >/dev/null; then
  SANDBOXD_ID="$("${COMPOSE[@]}" ps -q sandboxd | head -n1)"
  CURRENT_BACKEND_ID="$("${COMPOSE[@]}" ps -q backend | head -n1)"
  if [[ -n "$SANDBOXD_ID" && -n "$CURRENT_BACKEND_ID" ]]; then
    SANDBOXD_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$SANDBOXD_ID")"
    CURRENT_BACKEND_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CURRENT_BACKEND_ID")"
    # 仅当正在运行的 sandboxd 与 backend 使用完全相同的镜像引用时才同步更新。
    if [[ "$SANDBOXD_IMAGE" == "$CURRENT_BACKEND_IMAGE" \
        && "$SANDBOXD_IMAGE" =~ ^(docker\.io|index\.docker\.io|ghcr\.io)/coffeiz/gugu-web-backend(:[A-Za-z0-9_.-]{1,128}|@sha256:[a-f0-9]{64})$ ]]; then
      SANDBOXD_UPDATE=true
      PULL_SERVICES+=(sandboxd)
    fi
  fi
fi

DB_USER="${GUGU_DB_USER:-gugu}"
DB_NAME="${GUGU_DB_NAME:-gugu}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/split-update-$STAMP"
LOCK_DIR="$BACKUP_ROOT/.split-compose-update"
mkdir -p "$LOCK_DIR"
chmod 700 "$LOCK_DIR"
exec 9>"$LOCK_DIR/update.lock"
flock -n 9 || { echo '另一个分体 Compose 更新正在运行，拒绝并发更新' >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
cp "$ROOT_DIR/backend/.env" "$BACKUP_DIR/backend.env"
chmod 600 "$BACKUP_DIR/backend.env"
if [[ -f "$ROOT_DIR/.env" && ! -L "$ROOT_DIR/.env" ]]; then
  cp "$ROOT_DIR/.env" "$BACKUP_DIR/compose.env"
  chmod 600 "$BACKUP_DIR/compose.env"
fi

if ! "${COMPOSE[@]}" ps --status running --services | grep -x postgres >/dev/null; then
  echo 'PostgreSQL 未运行，拒绝更新' >&2
  exit 1
fi
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
  if [[ "$exit_code" != 0 && "$ROLLBACK_ARMED" == true ]]; then
    echo '离线更新失败：业务保持停服/新镜像状态，禁止只降级镜像；请用完整数据库与 users 备份人工恢复。' >&2
    printf 'manual-recovery\n' > "$BACKUP_DIR/recovery-required"
  fi
  exit "$exit_code"
}
trap rollback_on_exit EXIT

# 迁移目录前，关闭所有持有路径或数据库元数据的业务进程。
# sandboxd 不一定与 backend 同镜像，但无论是否更新都必须先停止。
STOP_SERVICES=(backend worker gateway)
if grep -qx sandboxd <<<"$SERVICES"; then STOP_SERVICES+=(sandboxd); fi
DATA_SOURCE="$(docker inspect --format '{{json .Mounts}}' "$PREVIOUS_BACKEND_ID" | node -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const m=JSON.parse(s).find(x=>x.Destination==="/data");if(!m||!m.Source||m.Source==="/")process.exit(1);process.stdout.write(m.Source)})')"
ROLLBACK_ARMED=true
"${COMPOSE[@]}" stop "${STOP_SERVICES[@]}"
if [[ "$EXTERNAL_SANDBOX" == true ]]; then
  export SANDBOX_DATA_SOURCE="$DATA_SOURCE" SANDBOX_STATE_FILE="$BACKUP_DIR/external-sandbox.state"
  bash "$SCRIPT_DIR/quiesce-external-sandbox.sh" stop
fi
# 临时 Shell/PTY 不属于 Compose；只停止挂载本部署数据的 Gugu 沙盒，不能操作其他部署。
SANDBOX_IDS="$(docker ps -q --filter label=com.gugu.sandbox=true)"
while read -r sandbox_id; do
  [[ -n "$sandbox_id" ]] || continue
  if docker inspect --format '{{json .Mounts}}' "$sandbox_id" | node -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const root=process.argv[1].replace(/\/$/,"");process.exit(JSON.parse(s).some(m=>m.Source===root||m.Source?.startsWith(root+"/"))?0:3)})' "$DATA_SOURCE"; then
    docker stop "$sandbox_id" >/dev/null
  else
    status=$?
    [[ "$status" == 3 ]] || exit "$status"
  fi
done <<<"$SANDBOX_IDS"
"${COMPOSE[@]}" exec -T postgres pg_dumpall -U "$DB_USER" > "$BACKUP_DIR/postgres.sql"
chmod 600 "$BACKUP_DIR/postgres.sql"
[[ -s "$BACKUP_DIR/postgres.sql" ]] || { echo '数据库备份为空，拒绝迁移' >&2; exit 1; }
"${COMPOSE[@]}" run --rm --no-deps --entrypoint tar backend -C /data -cpf - users > "$BACKUP_DIR/users.tar"
chmod 600 "$BACKUP_DIR/users.tar"
tar -tf "$BACKUP_DIR/users.tar" >/dev/null
echo '独立执行数据库与工作区离线迁移'
"${COMPOSE[@]}" run --rm --no-deps --entrypoint bash backend -ec \
  'alembic upgrade head && python -m scripts.migrations.migrate_workspace_layout --allow-real-data --apply --services-stopped'
"${COMPOSE[@]}" run --rm --no-deps --entrypoint python backend -m updater.database_check
echo '重新创建分体 backend'
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
elif grep -qx sandboxd <<<"$SERVICES"; then
  "${COMPOSE[@]}" start sandboxd
fi
if [[ "$EXTERNAL_SANDBOX" == true ]]; then
  bash "$SCRIPT_DIR/quiesce-external-sandbox.sh" start
fi
echo '更新完成；PostgreSQL、Redis、配置和数据卷未重建'
ROLLBACK_ARMED=false
