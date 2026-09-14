#!/usr/bin/env bash
# 容器启动入口：等数据库就绪 → 跑迁移 → 交给传入的主命令（Nginx / uvicorn / worker）。
# 迁移放这里而不是要求使用者手动 `make migrate`——本地/开发场景下"docker compose up
# 就能用"比"再单独进容器跑一条命令"体验好得多，且 alembic upgrade head 本身幂等，
# prod/dev 分体部署复用同一个入口脚本；默认 Compose 额外托管 worker、gateway、Uvicorn 和 Nginx。
set -euo pipefail

# 默认一体化应用模式在等待数据库和 Alembic 之前给出可操作的中文配置提示；
# 常规 backend/frontend 分离部署不启用这段逻辑。
if [ "${GUGU_UNIFIED_APP:-0}" = "1" ]; then
    # 镜像 ENV 里 ADMIN_PASSWORD="" 只是占位声明，但 Pydantic Settings 默认把空
    # 环境变量当真实值、且 process env 优先于 .env——不清掉它，首启生成的随机密码
    # 和用户在 .env 里配置的强密码都会被这个空串压掉（admin 登录 503）。
    # 用户显式 -e ADMIN_PASSWORD=xxx 时非空，保留生效。
    if [ -z "${ADMIN_PASSWORD:-}" ]; then
        unset ADMIN_PASSWORD
    fi
    # 镜像/Compose 会声明 SECRET_KEY="" 供面板识别变量；空环境变量会覆盖
    # compose_bootstrap 写入的持久化值，因此交给 /app/.env 或 /data/.env 生效。
    if [ -z "${SECRET_KEY:-}" ]; then
        unset SECRET_KEY
    fi
    python compose_bootstrap.py
fi

DB_HOST="${DB__HOST:-postgres}"
DB_PORT="${DB__PORT:-5432}"

echo "[entrypoint] 等待数据库 ${DB_HOST}:${DB_PORT} 就绪..."
DB_READY=0
for _ in $(seq 1 30); do
    if python -c "import socket; socket.create_connection(('${DB_HOST}', ${DB_PORT}), timeout=1)" 2>/dev/null; then
        echo "[entrypoint] 数据库已就绪"
        DB_READY=1
        break
    fi
    sleep 1
done
if [ "$DB_READY" != 1 ]; then
    echo "[entrypoint] 等待数据库 ${DB_HOST}:${DB_PORT} 超时，放弃启动。" >&2
    echo "  常见原因：" >&2
    echo "  ① 检查默认 docker-compose.yml 中的 PostgreSQL 服务及健康状态；" >&2
    echo "  ② 检查 DB__HOST/DB__PORT 是否指向可访问的 PostgreSQL 服务；" >&2
    echo "  ③ PostgreSQL 首次初始化尚未完成，可稍后重试。" >&2
    exit 1
fi

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

if [ "${GUGU_UNIFIED_APP:-0}" = "1" ] \
    && { [ "${1:-}" = "uvicorn" ] || [ "${1:-}" = "nginx" ]; }; then
    # 默认 Compose 的 app 服务：Nginx 对外服务，Uvicorn、消息 worker 与 IM gateway
    # 在同一服务中运行。任一启用的关键进程退出都让服务退出，避免健康检查看似正常但后台消息
    # 或 IM 长连接已经无人消费。
    monitored_pids=()
    if [ "${GUGU_ENABLE_RAG_SIDECAR:-1}" = "1" ]; then
        mkdir -p /run/gugu
        export SEARCH__TS_SIDECAR_SOCKET=/run/gugu/rag-sidecar.sock
        python -m agent.rag.sidecar_host --socket /run/gugu/rag-sidecar.sock &
        monitored_pids+=("$!")
    fi
    if [ "${GUGU_ENABLE_WORKER:-1}" = "1" ]; then
        python -m worker &
        monitored_pids+=("$!")
    fi
    if [ "${GUGU_ENABLE_GATEWAY:-1}" = "1" ]; then
        python -m agent.gateway.gateway &
        monitored_pids+=("$!")
    fi
    app_pid=""
    if [ "${1:-}" = "nginx" ]; then
        uvicorn app.main:app --host 127.0.0.1 --port "${GUGU_APP_PORT:-8001}" &
        app_pid=$!
    fi
    "$@" &
    proxy_pid=$!
    monitored_pids+=("$proxy_pid")
    [ -n "$app_pid" ] && monitored_pids+=("$app_pid")
    stop_children() {
        for pid in "${monitored_pids[@]}"; do
            kill "$pid" 2>/dev/null || true
        done
    }
    trap stop_children TERM INT

    while true; do
        for pid in "${monitored_pids[@]}"; do
            if ! kill -0 "$pid" 2>/dev/null; then
                set +e
                wait "$pid"
                child_status=$?
                set -e
                stop_children
                for other_pid in "${monitored_pids[@]}"; do
                    [ "$other_pid" = "$pid" ] || wait "$other_pid" 2>/dev/null || true
                done
                exit "$child_status"
            fi
        done
        sleep 1
    done
fi

exec "$@"
