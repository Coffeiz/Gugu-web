#!/usr/bin/env bash
# ============================================================
#  Gugu 数据备份脚本
#  用法: ./backup.sh [目标目录]
#
#  备份内容:
#    - config.override.json   （含 DB / Redis / OSS / AI 配置）
#    - Gugu-data/users （用户文件、Shell 沙盒和 Agent 数据）
#    - PostgreSQL 数据库 dump（可恢复的 custom format）
#    - alembic 版本信息        （便于恢复时核对迁移）
#  默认存到 .deploy-backups/，也可指定其他目录。
# ============================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="${1:-${APP_DIR}/.deploy-backups}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_NAME="gugu-backup-${TS}"
BACKUP_PATH="${TARGET_DIR}/${BACKUP_NAME}.tar.gz"

mkdir -p "$TARGET_DIR"

echo "[$(date '+%H:%M:%S')] 开始备份到：$BACKUP_PATH"

# 构造临时目录，按结构打包
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# 数据库备份必须成功，否则不能把备份误报成完整备份。
# 密码只通过临时 PGPASSFILE 传给 pg_dump，不进入命令参数、日志或备份清单。
if ! command -v pg_dump >/dev/null 2>&1; then
    echo "[ERROR] 未找到 pg_dump，无法生成数据库备份。" >&2
    exit 1
fi
VENV_BIN="${APP_DIR}/.venv/bin"
[ -x "${APP_DIR}/venv/bin/python" ] && VENV_BIN="${APP_DIR}/venv/bin"
if [ ! -x "${VENV_BIN}/python" ]; then
    echo "[ERROR] 未找到后端 Python 环境，无法读取数据库配置。" >&2
    exit 1
fi
mapfile -t DB_FIELDS < <("${VENV_BIN}/python" - <<'PY'
from app.core.config import get_settings

db = get_settings().db
for value in (db.host, db.port, db.name, db.user, db.password):
    print(value)
PY
)
if [ "${#DB_FIELDS[@]}" -ne 5 ] || [ -z "${DB_FIELDS[4]}" ]; then
    echo "[ERROR] 数据库配置不完整，拒绝生成不完整备份。" >&2
    exit 1
fi
PGPASSFILE="${TMP_DIR}/.pgpass"
chmod 600 "$PGPASSFILE"
printf '%s:%s:%s:%s:%s\n' "${DB_FIELDS[0]}" "${DB_FIELDS[1]}" "${DB_FIELDS[2]}" "${DB_FIELDS[3]}" "${DB_FIELDS[4]}" > "$PGPASSFILE"
DB_DUMP="${TMP_DIR}/database.dump"
if ! PGPASSFILE="$PGPASSFILE" pg_dump \
    --format=custom --no-owner --no-acl \
    --host="${DB_FIELDS[0]}" --port="${DB_FIELDS[1]}" \
    --username="${DB_FIELDS[3]}" --dbname="${DB_FIELDS[2]}" \
    --file="$DB_DUMP"; then
    echo "[ERROR] PostgreSQL 备份失败，已停止。" >&2
    exit 1
fi
if ! pg_restore --list "$DB_DUMP" >/dev/null 2>&1; then
    echo "[ERROR] PostgreSQL 备份校验失败，已停止。" >&2
    exit 1
fi
echo "[OK] PostgreSQL dump 已生成并通过结构校验"

# 备份 override 配置（脱敏可选，这里原样打包）
if [ -f "${APP_DIR}/config.override.json" ]; then
    mkdir -p "${TMP_DIR}/config"
    cp "${APP_DIR}/config.override.json" "${TMP_DIR}/config/"
fi

# 用户数据根目录位于仓库同级。
DATA_STORAGE="${APP_DIR}/../Gugu-data/users"
if [ -d "$DATA_STORAGE" ]; then
    mkdir -p "${TMP_DIR}/data"
    cp -a "$DATA_STORAGE" "${TMP_DIR}/data/users"
fi

# 备份 alembic 版本
if [ -f "${APP_DIR}/alembic/versions" ] || [ -d "${APP_DIR}/alembic/versions" ]; then
    mkdir -p "${TMP_DIR}/alembic"
    cp -a "${APP_DIR}/alembic/versions" "${TMP_DIR}/alembic/" 2>/dev/null || true
fi

# 元信息
cat > "${TMP_DIR}/MANIFEST.txt" <<EOF
备份时间: $(date '+%Y-%m-%d %H:%M:%S')
主机名:   $(hostname)
Git commit: $(git -C "${APP_DIR}/.." log -1 --oneline 2>/dev/null || echo 'unknown')
包含内容:
  config/config.override.json  - $([ -f "${APP_DIR}/config.override.json" ] && echo "✓" || echo "✗")
  data/users                   - $([ -d "$DATA_STORAGE" ] && echo "✓" || echo "✗")
  database.dump                - $(du -h "${DB_DUMP}" | cut -f1)
  alembic/versions             - $(ls "${APP_DIR}/alembic/versions" 2>/dev/null | wc -l) 个迁移文件
EOF

# 打包
tar -czf "$BACKUP_PATH" -C "$TMP_DIR" .

SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
echo "[OK] 备份完成：$BACKUP_PATH ($SIZE)"

# 只保留最近 10 个
ls -t "$TARGET_DIR"/gugu-backup-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f

echo ""
echo "恢复方法："
echo "  tar -xzf $BACKUP_PATH -C /tmp/restore && \\"
echo "    cp /tmp/restore/config/config.override.json ${APP_DIR}/ && \\"
echo "    cp -a /tmp/restore/data/users ${APP_DIR}/../Gugu-data/"
echo ""
echo "当前 ${TARGET_DIR} 共 $(ls "$TARGET_DIR"/gugu-backup-*.tar.gz 2>/dev/null | wc -l) 个备份"
