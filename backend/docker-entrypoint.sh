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

echo "[entrypoint] alembic upgrade head ..."
alembic upgrade head

echo "[entrypoint] 启动: $*"
exec "$@"
