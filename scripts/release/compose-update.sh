#!/usr/bin/env bash
set -euo pipefail

# 生产 Compose 安全更新入口。Phase 2 的 Admin 更新器通过同一边界调用。
# 明确禁止 down -v、无范围 prune 和覆盖用户配置。

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.prod.yml}"
MANIFEST=""
MANIFEST_BUNDLE=""
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT_DIR/backup}"
CONFIRMED=false
COSIGN_IDENTITY_REGEXP="${COSIGN_IDENTITY_REGEXP:-https://github\\.com/Coffeiz/Gugu-web/.github/workflows/docker-release\\.yml@refs/tags/v.*}"
COSIGN_OIDC_ISSUER="${COSIGN_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"

usage() {
  cat <<'EOF'
用法：scripts/release/compose-update.sh --manifest <update-manifest.json> --bundle <manifest.bundle> --confirm

环境变量：
  COMPOSE_FILE   生产 Compose 文件，默认 docker-compose.prod.yml
  BACKUP_ROOT    更新备份目录，默认 ./backup

说明：脚本只更新 manifest 指定的 backend/frontend digest，不会更新基础服务、删除卷或全局清理。
EOF
}

while (($# > 0)); do
  case "$1" in
    --manifest)
      [[ $# -ge 2 ]] || { echo '缺少 --manifest 参数' >&2; exit 2; }
      MANIFEST="$2"
      shift 2
      ;;
    --bundle)
      [[ $# -ge 2 ]] || { echo '缺少 --bundle 参数' >&2; exit 2; }
      MANIFEST_BUNDLE="$2"
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
[[ -n "$MANIFEST_BUNDLE" ]] || { echo '必须指定 --bundle' >&2; exit 2; }
[[ "$CONFIRMED" == true ]] || { echo '更新必须显式传入 --confirm' >&2; exit 2; }
[[ -f "$MANIFEST" ]] || { echo 'manifest 文件不存在' >&2; exit 1; }
[[ -f "$MANIFEST_BUNDLE" ]] || { echo 'manifest 签名 bundle 不存在' >&2; exit 1; }
[[ -f "$COMPOSE_FILE" ]] || { echo 'Compose 文件不存在' >&2; exit 1; }
[[ -f "$ROOT_DIR/backend/.env" ]] || { echo 'backend/.env 不存在，停止更新以保护运行配置' >&2; exit 1; }
command -v docker >/dev/null || { echo '未找到 Docker CLI' >&2; exit 1; }
command -v node >/dev/null || { echo '未找到 Node.js，无法校验 manifest' >&2; exit 1; }
command -v cosign >/dev/null || { echo '未找到 Cosign，无法验证发布签名' >&2; exit 1; }
[[ -n "${GUGU_DB_PASSWORD:-}" ]] || { echo '未设置 GUGU_DB_PASSWORD，停止更新' >&2; exit 1; }
[[ -n "${GUGU_ADMIN_PASSWORD:-}" ]] || { echo '未设置 GUGU_ADMIN_PASSWORD，停止更新' >&2; exit 1; }

VALIDATOR="$ROOT_DIR/scripts/release/validate-update-manifest.mjs"
mapfile -t IMAGE_LINES < <(node "$VALIDATOR" --print-images "$MANIFEST")
for line in "${IMAGE_LINES[@]}"; do
  case "$line" in
    GUGU_BACKEND_IMAGE=*) export "$line" ;;
    GUGU_FRONTEND_IMAGE=*) export "$line" ;;
    *) echo 'manifest 返回了未预期字段，停止更新' >&2; exit 1 ;;
  esac
done

[[ -n "${GUGU_BACKEND_IMAGE:-}" && -n "${GUGU_FRONTEND_IMAGE:-}" ]] || { echo 'manifest 缺少业务镜像' >&2; exit 1; }

echo '验证 manifest 和业务镜像签名...'
cosign verify-blob \
  --bundle "$MANIFEST_BUNDLE" \
  --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
  --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
  "$MANIFEST" >/dev/null
cosign verify \
  --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
  --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
  "$GUGU_BACKEND_IMAGE" >/dev/null
cosign verify \
  --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
  --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
  "$GUGU_FRONTEND_IMAGE" >/dev/null

DB_USER="${GUGU_DB_USER:-gugu}"
DB_NAME="${GUGU_DB_NAME:-gugu}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/update-$STAMP"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# 备份只写入带时间戳目录，不写回仓库配置，也不在终端输出敏感内容。
cp "$ROOT_DIR/backend/.env" "$BACKUP_DIR/backend.env"
chmod 600 "$BACKUP_DIR/backend.env"
docker compose -f "$COMPOSE_FILE" config --images > "$BACKUP_DIR/previous-images.txt"

if docker compose -f "$COMPOSE_FILE" ps --status running --services | grep -qx postgres; then
  docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dump -U "$DB_USER" "$DB_NAME" > "$BACKUP_DIR/postgres.sql"
  chmod 600 "$BACKUP_DIR/postgres.sql"
else
  echo 'postgres 未运行，停止更新；未创建数据库备份' >&2
  exit 1
fi

echo '开始拉取 manifest 指定的业务镜像...'
# 不带 --profile sandbox，不会因为普通更新拉取 egress-proxy 或其他沙盒镜像。
docker compose -f "$COMPOSE_FILE" pull backend worker gateway frontend migrate

SERVICES=(backend worker gateway frontend nginx)
if docker compose -f "$COMPOSE_FILE" ps --status running --services | grep -qx sandboxd; then
  SERVICES+=(sandboxd)
fi

echo '重新创建业务服务...'
docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate "${SERVICES[@]}"

echo '等待 backend 健康检查...'
for _ in $(seq 1 30); do
  if docker compose -f "$COMPOSE_FILE" exec -T backend curl -fsS http://127.0.0.1:8000/health >/dev/null; then
    echo "更新完成，备份目录：$BACKUP_DIR"
    exit 0
  fi
  sleep 2
done

echo '更新后 backend 健康检查失败；保留当前容器和备份，等待管理员按版本策略回滚' >&2
exit 1
