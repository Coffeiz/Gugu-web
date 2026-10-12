#!/usr/bin/env bash
# 首次部署统一走 Alembic 的空库 bootstrap，让 ORM metadata 之外的 bootstrap revision
# （例如文件分页表达式索引）也能先于 alembic_version 标记 head 执行。
set -euo pipefail

set +e
python - <<'PY'
from sqlalchemy import inspect

import asyncio
import sys

import app.db.session as session_mod

session_mod._build_engine()


def inspect_schema(sync_conn):
    inspector = inspect(sync_conn)
    return inspector.has_table("alembic_version"), set(inspector.get_table_names())

async def inspect_database():
    async with session_mod._engine.connect() as conn:
        return await conn.run_sync(inspect_schema)

has_version, tables = asyncio.run(inspect_database())
if has_version:
    print("[entrypoint] 已有 alembic_version，跳过首次 schema bootstrap")
    sys.exit(0)
if tables - {"alembic_version"}:
    print("[entrypoint] 检测到无版本表的既有 schema，使用兼容基线")
    sys.exit(20)
print("[entrypoint] 检测到真正空库，使用 Alembic 空库 bootstrap")
sys.exit(10)
PY
BOOTSTRAP_STATUS=$?
set -e

case "$BOOTSTRAP_STATUS" in
    0)
        exit 0
        ;;
    10)
        # env.py 会创建 ORM schema、运行标记为 bootstrap_on_empty_database 的 revision，
        # 最后才标记 head。不能提前 stamp，否则这些自定义索引和数据库对象会被跳过。
        alembic upgrade head
        ;;
    20)
        # 兼容曾由 create_all_tables 初始化、但没有 Alembic 版本表的既有数据库。
        python - <<'PY'
import asyncio
from app.db.session import create_all_tables

asyncio.run(create_all_tables())
PY
        alembic stamp head
        exit 0
        ;;
    *)
        echo "[entrypoint] 数据库 schema 检查失败（退出码 $BOOTSTRAP_STATUS），拒绝初始化。" >&2
        exit "$BOOTSTRAP_STATUS"
        ;;
esac

# 保留生产启动路径的幂等兼容 DDL（仅新库 bootstrap 完成后补齐；stamp 的旧库也已走上方兼容分支）。
python - <<'PY'
import asyncio
from app.db.session import create_all_tables

asyncio.run(create_all_tables())
PY
