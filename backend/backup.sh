#!/usr/bin/env bash
# ============================================================
#  Gugu 数据备份脚本
#  用法: ./backup.sh [目标目录]
#
#  备份内容:
#    - config.override.json   （含 DB / Redis / OSS / AI 配置）
#    - uploads/ / Gugu-data/users （用户上传的所有文件）
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

# 备份 override 配置（脱敏可选，这里原样打包）
if [ -f "${APP_DIR}/config.override.json" ]; then
    mkdir -p "${TMP_DIR}/config"
    cp "${APP_DIR}/config.override.json" "${TMP_DIR}/config/"
fi

# 备份 uploads
if [ -d "${APP_DIR}/uploads" ]; then
    mkdir -p "${TMP_DIR}/data"
    cp -a "${APP_DIR}/uploads" "${TMP_DIR}/data/"
fi

# 新存储根目录位于仓库同级；迁移后优先备份它，旧 uploads 仍兼容保留。
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
  data/uploads                 - $([ -d "${APP_DIR}/uploads" ] && echo "✓" || echo "✗")
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
echo "    cp -a /tmp/restore/data/uploads ${APP_DIR}/  # 旧目录备份（如存在）"
echo "    cp -a /tmp/restore/data/users ../Gugu-data/  # 迁移后的存储（如存在）"
echo ""
echo "当前 ${TARGET_DIR} 共 $(ls "$TARGET_DIR"/gugu-backup-*.tar.gz 2>/dev/null | wc -l) 个备份"
