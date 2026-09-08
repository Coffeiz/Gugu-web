#!/usr/bin/env bash
# 容器启动入口：等数据库就绪 → 跑迁移 → 交给传入的主命令（Nginx / uvicorn / worker）。
# 迁移放这里而不是要求使用者手动 `make migrate`——本地/开发场景下"docker compose up
# 就能用"比"再单独进容器跑一条命令"体验好得多，且 alembic upgrade head 本身幂等，
# 分离部署的 backend/worker 复用同一个入口脚本；默认 Compose 额外托管 worker、gateway、Uvicorn 和 Nginx。
set -euo pipefail

# 默认 Compose 单容器模式在等待数据库和 Alembic 之前给出可操作的中文配置提示；
# 常规 backend/frontend 分离部署不启用这段逻辑。
if [ "${GUGU_SINGLE_CONTAINER:-0}" = "1" ]; then
    # 镜像 ENV 里 ADMIN_PASSWORD="" 只是占位声明，但 Pydantic Settings 默认把空
    # 环境变量当真实值、且 process env 优先于 .env——不清掉它，首启生成的随机密码
    # 和用户在 .env 里配置的强密码都会被这个空串压掉（admin 登录 503）。
    # 用户显式 -e ADMIN_PASSWORD=xxx 时非空，保留生效。
    if [ -z "${ADMIN_PASSWORD:-}" ]; then
        unset ADMIN_PASSWORD
    fi
    python compose_bootstrap.py
fi

# 内置依赖模式（GUGU_EMBEDDED_DEPS=1，一体化镜像默认开）：单容器自带 PostgreSQL/Redis，
# 由 supervisord 托管、只监听 127.0.0.1，数据全部收口在数据卷（/data），容器外无暴露，
# 应用改连本机。Compose 分离部署显式设置 GUGU_EMBEDDED_DEPS=0 走各自容器，互不影响。
EMBEDDED_SUPERVISORD_PID=""
if [ "${GUGU_EMBEDDED_DEPS:-0}" = "1" ]; then
    EMBED_DATA="${GUGU_DATA_DIR:-/data}"
    EMBED_RUN=/run/gugu-embedded
    PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
    if [ -z "$PG_BIN" ] || ! command -v redis-server >/dev/null 2>&1 || ! command -v supervisord >/dev/null 2>&1; then
        echo "[entrypoint] GUGU_EMBEDDED_DEPS=1 但镜像未内置 postgresql/redis/supervisor，无法启动内置依赖。" >&2
        exit 1
    fi
    mkdir -p "$EMBED_DATA/postgres" "$EMBED_DATA/redis" /run/postgresql "$EMBED_RUN"
    chown postgres:postgres /run/postgresql "$EMBED_DATA/postgres"
    chown redis:redis "$EMBED_DATA/redis"
    # 库名/用户名跟随 DB__NAME / DB__USER（默认 gugu）：面板暴露了这两个变量，
    # 初始化若硬编码 gugu，用户改了变量反而会把自己配坏。
    EMBED_DB_USER="${DB__USER:-gugu}"
    EMBED_DB_NAME="${DB__NAME:-gugu}"
    if [ ! -s "$EMBED_DATA/postgres/PG_VERSION" ]; then
        echo "[entrypoint] 首次启动：初始化内置 PostgreSQL（数据目录 $EMBED_DATA/postgres）..."
        su -s /bin/bash postgres -c "\"$PG_BIN/initdb\" -D '$EMBED_DATA/postgres' --username='$EMBED_DB_USER' --encoding=UTF8"
        cat >> "$EMBED_DATA/postgres/pg_hba.conf" <<'HBA'
host all all 127.0.0.1/32 trust
host all all ::1/128 trust
HBA
        printf "\nlisten_addresses = '127.0.0.1'\n" >> "$EMBED_DATA/postgres/postgresql.conf"
        # 只服务本机回环 + trust 认证，无需 TLS；镜像里也删掉了 snakeoil 示例证书，
        # 不显式关掉 Debian 默认的 ssl=on 会让 postgres 因证书缺失起不来。
        printf "\nssl = off\n" >> "$EMBED_DATA/postgres/postgresql.conf"
    fi
    cat > "$EMBED_RUN/supervisord.conf" <<EOF
[supervisord]
nodaemon=false
logfile=$EMBED_RUN/supervisord.log
pidfile=$EMBED_RUN/supervisord.pid

[program:postgres]
command=$PG_BIN/postgres -D $EMBED_DATA/postgres
user=postgres
priority=10
autorestart=true

[program:redis]
command=redis-server --bind 127.0.0.1 --port 6379 --dir $EMBED_DATA/redis --appendonly yes
user=redis
priority=10
autorestart=true
EOF
    # 沙盒需要能创建隔离容器：仅当用户显式挂载了 docker socket 才把 sandboxd 纳入托管，
    # 否则不启动（Shell 能力保持不可用，不影响其余功能）。
    if [ -S /var/run/docker.sock ]; then
        echo "[entrypoint] 检测到 docker socket：本次启动加入 sandboxd 托管（Shell 沙盒可用）。"
        mkdir -p /run/gugu
        cat >> "$EMBED_RUN/supervisord.conf" <<EOF

[program:sandboxd]
directory=/app
command=python -m agent.sandbox.sandboxd --socket /run/gugu/sandboxd.sock --allowed-root $EMBED_DATA/users
priority=20
autorestart=true
EOF
    fi
    echo "[entrypoint] 启动内置 PostgreSQL / Redis（supervisord 托管）..."
    supervisord -c "$EMBED_RUN/supervisord.conf"
    EMBEDDED_SUPERVISORD_PID="$(cat "$EMBED_RUN/supervisord.pid" 2>/dev/null || true)"
    # 应用改连本机内置实例；用户显式指向外部数据库时不覆盖。内置 postgres/redis 固定监听
    # 5432/6379（supervisord 配置不读 DB__PORT/REDIS__PORT），因此一旦解析为内置实例就
    # 把端口一并钉死，避免面板里改了端口后应用去连一个并不存在的监听。
    case "${DB__HOST:-postgres}" in
        postgres|127.0.0.1|localhost)
            export DB__HOST=127.0.0.1 DB__PORT=5432
            export DB__NAME="$EMBED_DB_NAME" DB__USER="$EMBED_DB_USER"
            ;;
    esac
    case "${REDIS__HOST:-redis}" in
        redis|127.0.0.1|localhost) export REDIS__HOST=127.0.0.1 REDIS__PORT=6379 ;;
    esac
    for _ in $(seq 1 30); do
        if su -s /bin/bash postgres -c "$PG_BIN/pg_isready -h 127.0.0.1 -p 5432" >/dev/null 2>&1; then
            echo "[entrypoint] 内置 PostgreSQL 已就绪"
            break
        fi
        sleep 1
    done
    # 建应用库（幂等：已存在时忽略报错）。
    su -s /bin/bash postgres -c "\"$PG_BIN/createdb\" -h 127.0.0.1 -U '$EMBED_DB_USER' '$EMBED_DB_NAME'" >/dev/null 2>&1 || true
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
    # 之前这里超时后静默继续，环境变量没注入时会一路跑到建表检查才以一段
    # asyncpg pg_hba 裸栈收场，用户无从知道根因（fnOS 裸跑镜像实测）。
    echo "[entrypoint] 等待数据库 ${DB_HOST}:${DB_PORT} 超时，放弃启动。" >&2
    echo "  常见原因：" >&2
    echo "  ① 直接运行了镜像而没用仓库的 docker-compose.yml：postgres/redis 等服务没起，" >&2
    echo "     DB__HOST/DB__NAME 等环境变量也没注入，应用会回落 localhost 默认值。请用 compose 一键部署；" >&2
    echo "  ② 外接数据库时 DB__HOST/DB__PORT 未指向正确地址，或数据库未监听该地址；" >&2
    echo "  ③ postgres 容器还在初始化（首次建库），可稍后重试。" >&2
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

if [ "${GUGU_SINGLE_CONTAINER:-0}" = "1" ] \
    && { [ "${1:-}" = "uvicorn" ] || [ "${1:-}" = "nginx" ]; }; then
    # 默认 Compose 只有一个 app 容器：Nginx 对外服务，Uvicorn、消息 worker 与 IM gateway
    # 在容器内运行。任一启用的关键进程退出都让容器退出，避免健康检查看似正常但后台消息
    # 或 IM 长连接已经无人消费。
    monitored_pids=()
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
    # 内置 postgres/redis 的 supervisord 放在最后停：先停应用进程，再让它优雅关库。
    [ -n "$EMBEDDED_SUPERVISORD_PID" ] && monitored_pids+=("$EMBEDDED_SUPERVISORD_PID")

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
