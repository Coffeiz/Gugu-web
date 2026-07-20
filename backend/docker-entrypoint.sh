#!/usr/bin/env bash
# 容器启动入口：等数据库就绪 → 跑迁移 → 交给传入的主命令（uvicorn / worker）。
# 迁移放这里而不是要求使用者手动 `make migrate`——本地/开发场景下"docker compose up
# 就能用"比"再单独进容器跑一条命令"体验好得多，且 alembic upgrade head 本身幂等，
# 两个服务（backend/worker）用同一个入口脚本、谁先启动都会跑，不会漏迁移也不会重复出错。
set -euo pipefail

DB_HOST="${DB__HOST:-postgres}"
DB_PORT="${DB__PORT:-5432}"

echo "[entrypoint] 等待数据库 ${DB_HOST}:${DB_PORT} 就绪..."
for _ in $(seq 1 30); do
    if python -c "import socket; socket.create_connection(('${DB_HOST}', ${DB_PORT}), timeout=1)" 2>/dev/null; then
        echo "[entrypoint] 数据库已就绪"
        break
    fi
    sleep 1
done

echo "[entrypoint] 检查是否为全新数据库..."
# alembic 迁移历史最早一条（20260616135619）假设 calendar_events 已存在——本仓库的表结构
# 基线一直是生产 systemd 路径依赖的 app.main lifespan -> create_all_tables()（SQLAlchemy
# metadata + 幂等 ALTER 补丁，见 app/db/session.py），alembic 只覆盖这条基线之后的增量变更，
# 从未收录过"建表"这一步。全新库直接 `alembic upgrade head` 会在这条最早迁移上报
# UndefinedTableError（2026-07-16 devserver 隔离验收环境实测）。这里补上跟生产路径一致的
# 首次建表 + 基线标记，之后同一个 `alembic upgrade head` 才能在新旧库上都正确工作。
# 建表和 alembic stamp 分两步跑，不能揉进同一个 python 进程：alembic/env.py 是异步的，
# `alembic.command.stamp()` 内部自己 asyncio.run() 一次事件循环，跟这里包 create_all_tables()
# 的 asyncio.run() 嵌到一起会报 `asyncio.run() cannot be called from a running event loop`
# （2026-07-16 隔离验收环境实测）。用退出码 10 传递"需要 stamp"信号，stamp 单独用
# `alembic stamp head`（跟下面手动跑一样，走它自己独立的事件循环）。
set +e
python -c "
import asyncio, sys
from sqlalchemy import inspect
import app.db.session as session_mod

async def main():
    session_mod._build_engine()
    async with session_mod._engine.connect() as conn:
        has_version = await conn.run_sync(lambda c: inspect(c).has_table('alembic_version'))
    if has_version:
        print('[entrypoint] 已有 alembic_version，跳过首次建表')
        return False
    print('[entrypoint] 全新数据库，建表...')
    await session_mod.create_all_tables()
    return True

sys.exit(10 if asyncio.run(main()) else 0)
"
NEED_STAMP=$?
set -e
if [ "$NEED_STAMP" -eq 10 ]; then
    echo "[entrypoint] 标记 alembic 基线 (stamp head) ..."
    alembic stamp head
elif [ "$NEED_STAMP" -ne 0 ]; then
    exit "$NEED_STAMP"
fi

echo "[entrypoint] alembic upgrade head ..."
alembic upgrade head

echo "[entrypoint] 启动: $*"
exec "$@"
