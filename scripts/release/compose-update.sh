#!/usr/bin/env bash
set -euo pipefail

# 生产 Compose 安全更新入口。Phase 2 的 Admin 更新器通过同一边界调用。
# 明确禁止 down -v、无范围 prune 和覆盖用户配置。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${COMPOSE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
MANIFEST=""
MANIFEST_BUNDLE=""
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT_DIR/backup}"
VALIDATOR="${UPDATE_VALIDATOR:-$SCRIPT_DIR/validate-update-manifest.mjs}"
CONFIRMED=false
BOOTSTRAP_UPDATER=true
COSIGN_IDENTITY_REGEXP="${COSIGN_IDENTITY_REGEXP:-https://github\\.com/Coffeiz/Gugu-web/.github/workflows/docker-release\\.yml@refs/tags/v.*}"
COSIGN_OIDC_ISSUER="${COSIGN_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"

usage() {
  cat <<'EOF'
用法：scripts/release/compose-update.sh --manifest <update-manifest.json> --bundle <manifest.bundle> --confirm

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
    --bundle)
      [[ $# -ge 2 ]] || { echo '缺少 --bundle 参数' >&2; exit 2; }
      MANIFEST_BUNDLE="$2"
      shift 2
      ;;
    --confirm)
      CONFIRMED=true
      shift
      ;;
    --skip-updater-bootstrap)
      BOOTSTRAP_UPDATER=false
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
grep -Eq '^[[:space:]]*ADMIN_PASSWORD[[:space:]]*=[^[:space:]]' "$ROOT_DIR/backend/.env" \
  || { echo 'backend/.env 未设置 ADMIN_PASSWORD，停止更新' >&2; exit 1; }

COMPOSE=(docker compose -f "$COMPOSE_FILE" --profile sandbox)
COMPOSE_SERVICES=$("${COMPOSE[@]}" config --services)
for required_service in app postgres data-migrate; do
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

echo '验证 manifest 和业务镜像签名...'
cosign verify-blob \
  --bundle "$MANIFEST_BUNDLE" \
  --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
  --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
  "$MANIFEST" >/dev/null
cosign verify \
  --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
  --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
  "$GUGU_WEB_IMAGE" >/dev/null

# 旧部署第一次通过手动更新接入 Admin 更新器时，先启动 sidecar。只有在目标
# manifest 与业务镜像都已验证后才引导；sidecar 自身执行更新时显式跳过，避免
# Compose 重建正在运行的更新器。
if [[ "$BOOTSTRAP_UPDATER" == true ]] && grep -qx updater <<<"$COMPOSE_SERVICES"; then
  UPDATER_IMAGE=$("${COMPOSE[@]}" config --format json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(JSON.parse(input).services.updater?.image ?? ""));
  ')
  [[ "$UPDATER_IMAGE" =~ ^docker\.io/coffeiz/gugu-web-updater:(latest|v?[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?)$ ]] \
    || { echo 'updater 镜像不在官方发布白名单内' >&2; exit 1; }
  echo '验证受限 Docker 更新器签名并启动 sidecar...'
  "${COMPOSE[@]}" pull updater
  UPDATER_DIGEST=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$UPDATER_IMAGE" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const digest = input.split(/\r?\n/).map((value) => value.trim().replace(/^index\.docker\.io\//, "docker.io/"))
        .find((value) => /^(?:docker\.io\/)?coffeiz\/gugu-web-updater@sha256:[0-9a-f]{64}$/.test(value));
      process.stdout.write(digest ? `docker.io/${digest.replace(/^docker\.io\//, "")}` : "");
    });
  ')
  [[ -n "$UPDATER_DIGEST" ]] || { echo '无法解析已拉取的 updater 镜像 digest' >&2; exit 1; }
  cosign verify \
    --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
    --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
    "$UPDATER_DIGEST" >/dev/null
  GUGU_UPDATER_IMAGE="$UPDATER_DIGEST" "${COMPOSE[@]}" up -d --no-deps updater
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
PULL_SERVICES=(app data-migrate)
STOP_SERVICES=(app)
RECREATE_SERVICES=(app)
if [[ "$UPDATE_SANDBOXD" == true ]]; then
  PULL_SERVICES+=(sandboxd)
  STOP_SERVICES+=(sandboxd)
  RECREATE_SERVICES+=(sandboxd)
fi
"${COMPOSE[@]}" pull "${PULL_SERVICES[@]}"

# 文件迁移必须在旧应用容器停止后执行，避免旧进程在复制期间继续写入 named volume。
# stop 不删除卷；仅在 sandboxd 使用同一一体化镜像且当前运行时才同步重建它。
"${COMPOSE[@]}" stop "${STOP_SERVICES[@]}"
echo '迁移旧版用户数据到 GUGU_DATA_HOST_DIR...'
"${COMPOSE[@]}" up --no-deps --force-recreate data-migrate

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
