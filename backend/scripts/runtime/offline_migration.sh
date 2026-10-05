#!/usr/bin/env bash
# 由一体化入口在仅数据库依赖就绪、旧容器已停止后调用；不启动应用或沙盒。
set -euo pipefail
umask 077

DATA_ROOT="${GUGU_DATA_DIR:-/data}"
PG_BIN="${GUGU_OFFLINE_PG_BIN:?必须由一体化入口提供 PostgreSQL 工具目录}"
python -c 'import os; from pathlib import Path; from app.core.config import get_settings
s=get_settings()
if s.storage.backend != "local" or Path(s.storage.local_path).resolve() != (Path(os.environ.get("GUGU_DATA_DIR", "/data")) / "users").resolve():
    raise SystemExit("离线迁移的实际用户存储根与备份根不一致，拒绝迁移")
if s.db.host not in ("127.0.0.1", "localhost"):
    raise SystemExit("一体化离线迁移禁止连接外部数据库")'
[[ -d "$DATA_ROOT/users" && ! -L "$DATA_ROOT/users" ]] || { echo 'users 目录缺失或为符号链接，拒绝迁移。' >&2; exit 1; }
MIGRATION_STATE="$(python -m scripts.migrations.migrate_workspace_layout --allow-real-data --status)"
case "$MIGRATION_STATE" in
    completed|empty)
        echo "[offline-migration] 工作区布局状态为 $MIGRATION_STATE，跳过备份与迁移。"
        exit 0
        ;;
    pending) ;;
    *) echo "[offline-migration] 无法识别的工作区迁移状态：$MIGRATION_STATE" >&2; exit 1 ;;
esac
BACKUP_ROOT="$DATA_ROOT/migration-backups"
[[ ! -L "$BACKUP_ROOT" ]] || { echo '迁移备份目录不能是符号链接。' >&2; exit 1; }
mkdir -p "$BACKUP_ROOT"
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/workspace-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
chmod 700 "$BACKUP_DIR"
export PGPASSWORD="${DB__PASSWORD:-}"
"$PG_BIN/pg_dump" --host=127.0.0.1 --username="${DB__USER:-gugu}" \
    --dbname="${DB__NAME:-gugu}" --format=custom --file="$BACKUP_DIR/postgres.dump"
[[ -s "$BACKUP_DIR/postgres.dump" ]] || { echo '数据库备份为空，拒绝迁移。' >&2; exit 1; }
"$PG_BIN/pg_restore" --list "$BACKUP_DIR/postgres.dump" > "$BACKUP_DIR/postgres.contents"
tar -C "$DATA_ROOT" -cpf "$BACKUP_DIR/users.tar" users
tar -tf "$BACKUP_DIR/users.tar" >/dev/null
printf 'manual-recovery\n' > "$BACKUP_DIR/recovery-required"
echo '[offline-migration] 完整数据库与 users 备份完成，开始迁移。'
alembic upgrade head
python -m scripts.migrations.migrate_workspace_layout --allow-real-data --apply --services-stopped
python -m scripts.migrations.migrate_workspace_layout --allow-real-data --check
python -m updater.database_check
rm -- "$BACKUP_DIR/recovery-required"
echo '[offline-migration] 校验完成；备份保留在数据卷 migration-backups，未启动业务服务。'
