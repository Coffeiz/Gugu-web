#!/usr/bin/env bash
# 容器启动入口：等数据库就绪 → 跑迁移 → 交给传入的主命令（Nginx / uvicorn / worker）。
# 迁移放这里而不是要求使用者手动 `make migrate`——本地/开发场景下"docker compose up
# 就能用"比"再单独进容器跑一条命令"体验好得多，且 alembic upgrade head 本身幂等，
# prod/dev 分体部署复用同一个入口脚本；默认 Compose 额外托管 worker、gateway、Uvicorn 和 Nginx。
set -euo pipefail

# 升级命令仍走入口启动内置数据库，但不激活持久化旧代码或启动任何业务/沙盒进程。
OFFLINE_MIGRATION=0
if [ "${1:-}" = "gugu-offline-migrate" ]; then
    if [ "$#" != 2 ] || [ "${2:-}" != "--services-stopped" ] \
        || [ "${GUGU_UNIFIED_APP:-0}" != 1 ] || [ "${GUGU_EMBEDDED_DEPS:-0}" != 1 ]; then
        echo '[entrypoint] 离线迁移仅支持一体化内置数据库；必须先停旧容器并传 --services-stopped。' >&2
        exit 2
    fi
    OFFLINE_MIGRATION=1
    DATA_ROOT="${GUGU_DATA_DIR:-/data}"
    if [ ! -s "$DATA_ROOT/postgres/PG_VERSION" ] || [ -L "$DATA_ROOT/.offline-migration.lock" ]; then
        echo '[entrypoint] 找不到旧内置数据库或迁移锁异常，拒绝离线迁移。' >&2
        exit 1
    fi
    exec 9>"$DATA_ROOT/.offline-migration.lock"
    flock -n 9 || { echo '[entrypoint] 已有离线迁移占用数据目录。' >&2; exit 1; }
fi

# 无 Compose 的一体化容器可把应用代码版本化保存到 /data，以便 Admin 更新应用包；
# Compose 仍由镜像更新链路负责，避免覆盖 /app/logs 等 Compose 挂载点。
if [ "${GUGU_UNIFIED_APP:-0}" = "1" ] \
    && [ -z "${GUGU_UPDATE_DEPLOYMENT_MODE:-}" ]; then
    if [ -S "${GUGU_DOCKER_SOCKET:-/var/run/docker.sock}" ]; then
        export GUGU_UPDATE_DEPLOYMENT_MODE=standalone_docker
    else
        export GUGU_UPDATE_DEPLOYMENT_MODE=standalone_app_bundle
    fi
fi
if [ "${GUGU_UNIFIED_APP:-0}" = "1" ] \
    && [ "${GUGU_EMBEDDED_DEPS:-0}" = "1" ] \
    && [ "$OFFLINE_MIGRATION" = 0 ] \
    && [ "${GUGU_APP_BUNDLE_UPDATE:-on}" != "off" ] \
    && [ "${GUGU_UPDATE_DEPLOYMENT_MODE:-}" != "integrated_compose" ] \
    && [ "${GUGU_UPDATE_DEPLOYMENT_MODE:-}" != "split_compose" ]; then
    python /opt/gugu/app_bundle_runtime.py --activate
    cd /app
fi

# 默认一体化应用模式在等待数据库和 Alembic 之前给出可操作的中文配置提示；
# 常规 backend/frontend 分离部署不启用这段逻辑。
if [ "${GUGU_UNIFIED_APP:-0}" = "1" ]; then
    if [ -z "${ADMIN_USERNAME:-}" ]; then
        unset ADMIN_USERNAME
    fi
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
    # 一体化单容器允许内置 PostgreSQL 密码留空；bootstrap 会首次生成并写入
    # 持久化 dotenv。清除镜像/面板注入的空值，避免它覆盖 dotenv 中的生成值。
    if [ -z "${DB__PASSWORD:-}" ]; then
        if [ -n "${GUGU_DB_PASSWORD:-}" ]; then
            export DB__PASSWORD="$GUGU_DB_PASSWORD"
        else
            unset DB__PASSWORD
        fi
    fi
    if [ -z "${GUGU_DB_PASSWORD:-}" ]; then
        unset GUGU_DB_PASSWORD
    fi
    python compose_bootstrap.py
fi

# 内置依赖模式（GUGU_EMBEDDED_DEPS=1，一体化镜像默认开）：单容器自带 PostgreSQL/Redis，
# 由 supervisord 托管、只监听 127.0.0.1，数据全部收口在数据卷（/data），容器外无暴露，
# 应用改连本机。Compose 部署显式设置 GUGU_EMBEDDED_DEPS=0 走各自容器，互不影响。
EMBEDDED_SUPERVISORD_PID=""
if [ "${GUGU_EMBEDDED_DEPS:-0}" = "1" ]; then
    EMBED_DATA="${GUGU_DATA_DIR:-/data}"
    # 持久化分级守卫（fnOS 面板事故教训）。内置数据库必须落在宿主机 bind mount 上：
    # ① bind mount → 完全持久，静默通过；
    # ② Docker 匿名卷（镜像 VOLUME 声明的零配置兜底）→ 重启不丢，但面板"更新镜像"
    #    重建容器会拿到全新空卷，旧数据滞留孤儿卷无法接上（fnOS v1.2.2 实测丢数据根因）
    #    → 默认拒绝启动；确实只想临时试用的用户可显式 GUGU_ALLOW_ANONYMOUS_DATA=1
    #    放行（日志仍会警告）；
    # ③ overlay 可写层 = 连卷都没挂 → 一律拒绝。
    EMBED_DATA_FS="$(findmnt -n -o FSTYPE --target "$EMBED_DATA" 2>/dev/null || stat -f -c %T "$EMBED_DATA" 2>/dev/null || echo '')"
    if [ "$EMBED_DATA_FS" = "overlay" ] || [ "$EMBED_DATA_FS" = "overlayfs" ]; then
        echo "[entrypoint] 拒绝启动：${EMBED_DATA} 未挂载持久卷（当前在 overlay 可写层上）。" >&2
        echo "  内置 PostgreSQL/Redis 的数据会写进容器层，删除容器即全部丢失。" >&2
        echo "  请在启动时绑定宿主机目录：-v /你的数据目录:/data -v /你的配置目录:/config" >&2
        exit 1
    fi
    EMBED_DATA_SRC="$(findmnt -n -o SOURCE --target "$EMBED_DATA" 2>/dev/null || echo '')"
    case "$EMBED_DATA_SRC" in
        /var/lib/docker/volumes/*)
            if [ "${GUGU_ALLOW_ANONYMOUS_DATA:-0}" = "1" ]; then
                echo "[entrypoint] 警告：${EMBED_DATA} 使用 Docker 匿名卷（GUGU_ALLOW_ANONYMOUS_DATA=1）。" >&2
                echo "  通过 NAS 面板更新镜像重建容器时会拿到全新空卷，旧数据滞留旧卷无法自动接上。" >&2
            else
                echo "[entrypoint] 拒绝启动：${EMBED_DATA} 当前使用 Docker 匿名卷，而非宿主机目录。" >&2
                echo "  匿名卷在重启/崩溃时不丢数据，但 NAS 面板「更新镜像」重建容器时会拿到全新的空卷，" >&2
                echo "  数据库将回到出厂状态（fnOS 单容器部署实测踩过）。长期使用请绑定宿主机目录：" >&2
                echo "    -v /你的数据目录:/data -v /你的配置目录:/config" >&2
                echo "  只想先临时试用、接受上述风险：加环境变量 GUGU_ALLOW_ANONYMOUS_DATA=1" >&2
                exit 1
            fi
            ;;
    esac
    EMBED_RUN=/run/gugu-embedded
    PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
    if [ -z "$PG_BIN" ] || ! command -v redis-server >/dev/null 2>&1 || ! command -v supervisord >/dev/null 2>&1; then
        echo "[entrypoint] GUGU_EMBEDDED_DEPS=1 但镜像未内置 postgresql/redis/supervisor，无法启动内置依赖。" >&2
        exit 1
    fi
    mkdir -p "$EMBED_DATA/postgres" "$EMBED_DATA/redis" /run/postgresql "$EMBED_RUN"
    chown postgres:postgres /run/postgresql "$EMBED_DATA/postgres"
    chown redis:redis "$EMBED_DATA/redis"
    # fnOS 等面板绑定的宿主机目录常见 700/000 且属主是面板用户（或 root），postgres/redis
    # 系统用户连「穿越」$EMBED_DATA 都做不到，initdb 会报 Permission denied（入口自身是
    # root，mkdir/chown 全成功，炸点在 su 之后）。这里只给父目录补执行位（不开放读列表），
    # 并把两个数据目录收成守护用户私有（initdb 自己会再收紧到 700）。
    chmod a+x "$EMBED_DATA" 2>/dev/null || true
    chown -R postgres:postgres "$EMBED_DATA/postgres"
    chown -R redis:redis "$EMBED_DATA/redis"
    chmod 700 "$EMBED_DATA/postgres" "$EMBED_DATA/redis"
    # 库名/用户名跟随 DB__NAME / DB__USER（默认 gugu）：面板暴露了这两个变量，
    # 初始化若硬编码 gugu，用户改了变量反而会把自己配坏。
    EMBED_DB_USER="${DB__USER:-gugu}"
    EMBED_DB_NAME="${DB__NAME:-gugu}"
    LEGACY_PGDATA_ROOT="${GUGU_LEGACY_PGDATA_ROOT:-/legacy-pgdata}"
    LEGACY_PGDATA_FOUND=0
    if [ -d "$LEGACY_PGDATA_ROOT" ] && find "$LEGACY_PGDATA_ROOT" -maxdepth 5 -type f -name PG_VERSION -print -quit 2>/dev/null | grep -q .; then
        LEGACY_PGDATA_FOUND=1
    fi
    LEGACY_PG_DUMP="$EMBED_DATA/updater/legacy-postgres.dump"
    LEGACY_PG_IMPORTED="$EMBED_DATA/updater/legacy-postgres.imported"
    LEGACY_PG_IMPORTING="$EMBED_DATA/updater/legacy-postgres.importing"
    if [ -s "$LEGACY_PG_IMPORTED" ] && [ -e "$LEGACY_PG_IMPORTING" ]; then
        rm -f -- "$LEGACY_PG_IMPORTING"
    fi
    LEGACY_REDIS_ROOT="${GUGU_LEGACY_REDISDATA_ROOT:-/legacy-redisdata}"
    LEGACY_REDIS_FOUND=0
    if [ -d "$LEGACY_REDIS_ROOT" ] && find "$LEGACY_REDIS_ROOT" -maxdepth 3 -type f -print -quit 2>/dev/null | grep -q .; then
        LEGACY_REDIS_FOUND=1
    fi
    LEGACY_REDIS_DUMP="$EMBED_DATA/updater/legacy-redis.rdb"
    LEGACY_REDIS_IMPORTED="$EMBED_DATA/updater/legacy-redis.imported"
    PG_INITIALIZED_NOW=0
    if [ ! -s "$EMBED_DATA/postgres/PG_VERSION" ]; then
        if [ -s "$LEGACY_PG_IMPORTED" ]; then
            echo "[entrypoint] 拒绝初始化空数据库：存在旧库迁移完成标记，但内置 PostgreSQL 数据目录缺失。" >&2
            exit 1
        fi
        if [ "$LEGACY_PGDATA_FOUND" = 1 ] && [ ! -s "$LEGACY_PG_DUMP" ]; then
            echo "[entrypoint] 拒绝初始化空数据库：检测到旧 Compose PostgreSQL 数据卷，但没有迁移备份。" >&2
            echo "  请先按 docs/quick-deploy.md 的旧 Compose 数据迁移步骤导出数据库，再启动新版 Compose。" >&2
            exit 1
        fi
        if [ -s "$LEGACY_PG_DUMP" ] && [ ! -s "$LEGACY_PG_IMPORTED" ]; then
            mkdir -p "$(dirname "$LEGACY_PG_IMPORTING")"
            date -u +%FT%TZ > "$LEGACY_PG_IMPORTING.tmp"
            chmod 600 "$LEGACY_PG_IMPORTING.tmp"
            mv "$LEGACY_PG_IMPORTING.tmp" "$LEGACY_PG_IMPORTING"
        fi
        echo "[entrypoint] 首次启动：初始化内置 PostgreSQL（数据目录 $EMBED_DATA/postgres）..."
        if ! su -s /bin/bash postgres -c "\"$PG_BIN/initdb\" -D '$EMBED_DATA/postgres' --username='$EMBED_DB_USER' --encoding=UTF8"; then
            echo "[entrypoint] 内置 PostgreSQL 初始化失败。" >&2
            echo "  最常见原因：宿主机绑定目录权限过严（NAS 面板映射目录常见），守护用户无法写入。" >&2
            echo "  请在宿主机执行：chmod 755 /你的数据目录 && chown -R 999:999 /你的数据目录" >&2
            echo "  （999 是镜像内 postgres 用户的 uid；容器重启即可继续初始化）" >&2
            exit 1
        fi
        printf "\nlisten_addresses = '127.0.0.1'\n" >> "$EMBED_DATA/postgres/postgresql.conf"
        # 只服务本机回环 + trust 认证，无需 TLS；镜像里删掉了 snakeoil 示例证书，
        # 不显式关掉 Debian 默认的 ssl=on 会让 postgres 因证书缺失起不来。
        printf "\nssl = off\n" >> "$EMBED_DATA/postgres/postgresql.conf"
        PG_INITIALIZED_NOW=1
    elif [ -s "$LEGACY_PG_DUMP" ] && [ ! -s "$LEGACY_PG_IMPORTED" ] \
        && [ -s "$LEGACY_PG_IMPORTING" ]; then
        # 导入开始标记仅由首次初始化旧库迁移目标时写入；失败导入为单事务，
        # 因此可在重启后安全重试，不会覆盖已有业务数据。
        PG_INITIALIZED_NOW=1
    elif [ "$LEGACY_PGDATA_FOUND" = 1 ] && [ ! -s "$LEGACY_PG_IMPORTED" ]; then
        echo "[entrypoint] 拒绝启动：/data 已有数据库，但旧 Compose PostgreSQL 数据尚未标记迁移完成。" >&2
        echo "  为避免覆盖任一数据库，请先完成旧数据迁移并检查 Gugu-data/updater/。" >&2
        exit 1
    fi
    if [ "$LEGACY_REDIS_FOUND" = 1 ] && [ ! -s "$LEGACY_REDIS_DUMP" ] && [ ! -s "$LEGACY_REDIS_IMPORTED" ]; then
        echo "[entrypoint] 拒绝启动：检测到旧 Compose Redis 持久数据，但没有迁移快照。" >&2
        echo "  请停止旧 app（暂停 worker/gateway），按 docs/quick-deploy.md 导出 PostgreSQL 和 Redis，再启动新版 Compose。" >&2
        exit 1
    fi
    if [ -s "$LEGACY_REDIS_DUMP" ] && [ ! -s "$LEGACY_REDIS_IMPORTED" ]; then
        if [ -s "$EMBED_DATA/redis/dump.rdb" ] && cmp -s "$LEGACY_REDIS_DUMP" "$EMBED_DATA/redis/dump.rdb"; then
            : # 上次启动已复制快照但 Redis 尚未就绪；安全重试加载。
        elif find "$EMBED_DATA/redis" -maxdepth 2 -type f -print -quit 2>/dev/null | grep -q .; then
            echo "[entrypoint] 拒绝导入旧 Redis 快照：目标 Redis 已有数据，不能覆盖。" >&2
            exit 1
        else
            cp "$LEGACY_REDIS_DUMP" "$EMBED_DATA/redis/dump.rdb"
            chown redis:redis "$EMBED_DATA/redis/dump.rdb"
            chmod 600 "$EMBED_DATA/redis/dump.rdb"
            echo "[entrypoint] 已准备旧 Compose Redis 快照；将由内置 Redis 在启动时加载。"
        fi
    elif [ "$LEGACY_REDIS_FOUND" = 1 ] && [ ! -s "$LEGACY_REDIS_IMPORTED" ]; then
        echo "[entrypoint] 拒绝启动：旧 Redis 数据尚未标记迁移完成；请检查迁移快照与内置 Redis 状态。" >&2
        exit 1
    fi
    # 数据目录可能来自旧版本；每次启动都幂等补齐内置实例的本机认证规则，避免只修新库。
    python /usr/local/bin/ensure_embedded_pg_hba.py "$EMBED_DATA/postgres/pg_hba.conf"
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
    # RAG worker 宿主：统一应用模式下由后面的 monitored_pids 块托管；
    # 仅非统一模式才交给 supervisord，两处都起会互相顶掉同一路径的 socket。
    mkdir -p /run/gugu
    export SEARCH__TS_SIDECAR_SOCKET=/run/gugu/rag-sidecar.sock
    if [ "${GUGU_UNIFIED_APP:-0}" != "1" ]; then
        cat >> "$EMBED_RUN/supervisord.conf" <<SUPERVISEOF

[program:rag-sidecar]
directory=/app
command=python -m agent.rag.sidecar_host --socket /run/gugu/rag-sidecar.sock
priority=15
autorestart=true
SUPERVISEOF
    fi
    echo "[entrypoint] 启动内置 PostgreSQL / Redis（supervisord 托管）..."
    supervisord -c "$EMBED_RUN/supervisord.conf"
    EMBEDDED_SUPERVISORD_PID="$(cat "$EMBED_RUN/supervisord.pid" 2>/dev/null || true)"
    if [ "$OFFLINE_MIGRATION" = 1 ]; then
        # 正常和异常退出均优雅关闭内置数据库，避免迁移容器退出留下未刷盘的依赖进程。
        stop_migration_dependencies() {
            local status=$?
            trap - EXIT
            if [ -n "$EMBEDDED_SUPERVISORD_PID" ]; then
                kill -TERM "$EMBEDDED_SUPERVISORD_PID" || status=1
                for _ in $(seq 1 30); do
                    kill -0 "$EMBEDDED_SUPERVISORD_PID" 2>/dev/null || break
                    # PID 1 的 shell 可能尚未回收 daemon 的僵尸状态；此时依赖已结束。
                    [[ "$(ps -o stat= -p "$EMBEDDED_SUPERVISORD_PID")" == Z* ]] && break
                    sleep 1
                done
                if kill -0 "$EMBEDDED_SUPERVISORD_PID" 2>/dev/null \
                    && [[ "$(ps -o stat= -p "$EMBEDDED_SUPERVISORD_PID")" != Z* ]]; then
                    echo '[entrypoint] 内置依赖未及时退出，禁止将本次迁移视为成功。' >&2
                    status=1
                fi
            fi
            exit "$status"
        }
        trap stop_migration_dependencies EXIT
        trap 'exit 143' TERM
        trap 'exit 130' INT
        [[ "$EMBEDDED_SUPERVISORD_PID" =~ ^[1-9][0-9]*$ ]] \
            || { echo '[entrypoint] 内置依赖进程无法确认，拒绝继续迁移。' >&2; exit 1; }
    fi
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
    # TCP 监听可能早于 crash recovery 完成；等待器超时会非零退出，不能退回 TCP 探测。
    /usr/local/bin/gugu-wait-embedded-postgres.sh "$PG_BIN/pg_isready"
    # Redis 的 TCP 端口可能早于 AOF/RDB 恢复完成而开放；在它返回 PONG 前不启动
    # Alembic、worker 或 gateway，避免 BusyLoadingError 让关键进程提前退出。
    /usr/local/bin/gugu-wait-embedded-redis.sh
    if [ -s "$LEGACY_REDIS_DUMP" ] && [ ! -s "$LEGACY_REDIS_IMPORTED" ]; then
        mkdir -p "$(dirname "$LEGACY_REDIS_IMPORTED")"
        date -u +%FT%TZ > "$LEGACY_REDIS_IMPORTED.tmp"
        chmod 600 "$LEGACY_REDIS_IMPORTED.tmp"
        mv "$LEGACY_REDIS_IMPORTED.tmp" "$LEGACY_REDIS_IMPORTED"
        echo "[entrypoint] 旧 Compose Redis 快照已加载；旧数据卷与快照均未删除。"
    fi
    # 建应用库（幂等：已存在时忽略报错）。
    su -s /bin/bash postgres -c "\"$PG_BIN/createdb\" -h 127.0.0.1 -U '$EMBED_DB_USER' '$EMBED_DB_NAME'" >/dev/null 2>&1 || true
    if [ -s "$LEGACY_PG_DUMP" ] && [ ! -s "$LEGACY_PG_IMPORTED" ]; then
        if [ "$PG_INITIALIZED_NOW" != 1 ]; then
            echo "[entrypoint] 拒绝导入旧数据库备份：目标 PostgreSQL 并非本次新建，不能覆盖现有数据。" >&2
            exit 1
        fi
        echo "[entrypoint] 正在将旧 Compose PostgreSQL 备份导入内置数据库..."
        if ! "$PG_BIN/psql" --host=127.0.0.1 --username="$EMBED_DB_USER" \
            --dbname="$EMBED_DB_NAME" --set=ON_ERROR_STOP=1 --single-transaction \
            --file="$LEGACY_PG_DUMP"; then
            echo "[entrypoint] 旧 PostgreSQL 备份导入失败；保留备份并拒绝启动应用。" >&2
            exit 1
        fi
        mkdir -p "$(dirname "$LEGACY_PG_IMPORTED")"
        date -u +%FT%TZ > "$LEGACY_PG_IMPORTED.tmp"
        chmod 600 "$LEGACY_PG_IMPORTED.tmp"
        mv "$LEGACY_PG_IMPORTED.tmp" "$LEGACY_PG_IMPORTED"
        rm -f -- "$LEGACY_PG_IMPORTING"
        echo "[entrypoint] 旧 PostgreSQL 数据导入完成；原数据卷和备份均未删除。"
    fi
fi

DB_HOST="${DB__HOST:-postgres}"
DB_PORT="${DB__PORT:-5432}"

echo "[entrypoint] 等待数据库 ${DB_HOST}:${DB_PORT} 就绪..."
DB_READY=0
for _ in $(seq 1 30); do
    if python -c "import socket; socket.create_connection(('${DB_HOST}', ${DB_PORT}), timeout=1)" 2>/dev/null; then
        echo "[entrypoint] 数据库 TCP 端口已开放"
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

if [ "$OFFLINE_MIGRATION" = 1 ]; then
    case "$DB_HOST" in
        127.0.0.1|localhost) ;;
        *) echo '[entrypoint] 离线模式禁止迁移外部数据库。' >&2; exit 1 ;;
    esac
    GUGU_OFFLINE_PG_BIN="$PG_BIN" bash /usr/local/bin/gugu-offline-migration.sh
    exit 0
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

if [ "${GUGU_UNIFIED_APP:-0}" = "1" ] && [ "${GUGU_EMBEDDED_DEPS:-0}" = "1" ]; then
    # 一体化容器启动时，PostgreSQL/Redis 已就绪，但 Web/Worker/Gateway/Sandbox 尚未启动；
    # 可在这个停服窗口自动执行带完整备份的工作区迁移。迁移脚本先检查状态，已完成或空库不重复备份。
    WORKSPACE_LAYOUT_STATUS="$(python -m scripts.migrations.migrate_workspace_layout --allow-real-data --status)"
    case "$WORKSPACE_LAYOUT_STATUS" in
        pending)
            echo "[entrypoint] 检测到旧工作区布局，在启动应用前自动备份并迁移..."
            GUGU_OFFLINE_PG_BIN="$PG_BIN" bash /usr/local/bin/gugu-offline-migration.sh
            ;;
        completed|empty)
            echo "[entrypoint] 工作区布局状态为 $WORKSPACE_LAYOUT_STATUS，无需离线迁移。"
            ;;
        external)
            echo "[entrypoint] 使用非本地存储，跳过工作区磁盘迁移。"
            ;;
        *) echo "[entrypoint] 无法识别的工作区迁移状态：$WORKSPACE_LAYOUT_STATUS" >&2; exit 1 ;;
    esac
else
    # 分体部署没有统一的停服窗口，仍拒绝在线移动用户文件。
    python -m scripts.migrations.migrate_workspace_layout --allow-real-data --check
fi
echo "[entrypoint] alembic upgrade head ..."
alembic upgrade head
python -m scripts.migrations.migrate_workspace_layout --allow-real-data --check

# Knowledge 主存储把创建/更新时间统一为 ISO 8601 UTC。应用入口在服务接流量前
# 执行可重跑迁移；其他 worker/gateway 由 KnowledgeStore 的用户级迁移门禁保护。
if [ "${1:-}" = "uvicorn" ] || [ "${1:-}" = "nginx" ]; then
    echo "[entrypoint] 迁移 Knowledge 时间戳为 ISO 8601 UTC ..."
    python -m scripts.migrations.migrate_knowledge_timestamps
fi

echo "[entrypoint] 启动: $*"

if [ "${GUGU_UNIFIED_APP:-0}" = "1" ] \
    && { [ "${1:-}" = "uvicorn" ] || [ "${1:-}" = "nginx" ]; }; then
    # 默认 Compose 的 app 服务：Nginx 对外服务，Uvicorn、消息 worker 与 IM gateway
    # 在同一服务中运行。任一启用的关键进程退出都让服务退出，避免健康检查看似正常但后台消息
    # 或 IM 长连接已经无人消费。
    monitored_pids=()
    app_restart_requested=0
    EMBEDDED_SANDBOX_SUPERVISORD_PID=""
    if [ -n "${GUGU_LOG_FILE:-}" ]; then
        # 一体化镜像默认写入 /data 持久卷，Admin Debug 可跨容器重建读取。
        mkdir -p "$(dirname "$GUGU_LOG_FILE")"
    fi
    if [ "${GUGU_SANDBOX_MANAGER_MODE:-disabled}" = "embedded" ]; then
        # 内置 Rootless daemon 与 sandboxd 由独立 supervisor 托管；只在 manager
        # 子进程环境中设置内部 socket，不向 Web/Worker/Gateway 暴露 Docker API。
        if [ "${SANDBOX__EGRESS_PROXY_URL+x}" != "x" ]; then
            export SANDBOX__EGRESS_PROXY_URL="http://egress-proxy:3128"
        fi
        if [ "${SANDBOX__EGRESS_NETWORK_NAME+x}" != "x" ]; then
            export SANDBOX__EGRESS_NETWORK_NAME="gugu-sandbox-egress"
        fi
        if [ "${SANDBOX__EGRESS_ISOLATION_ENABLED+x}" != "x" ]; then
            export SANDBOX__EGRESS_ISOLATION_ENABLED="true"
        fi
        export SQUID_CONF_PATH="${SQUID_CONF_PATH:-/opt/gugu/egress.conf}"
        EMBEDDED_DATA_DIR="${GUGU_DATA_DIR:-/data}"
        EMBEDDED_SANDBOX_SOCKET="${GUGU_SANDBOXD_SOCKET:-/run/gugu/sandboxd.sock}"
        if EMBEDDED_SANDBOX_SUPERVISORD_PID="$(/usr/local/bin/gugu-start-embedded-sandbox-manager.sh \
            "$EMBEDDED_SANDBOX_SOCKET" "$EMBEDDED_DATA_DIR/users" /run/gugu/sandbox-supervisor)"; then
            echo "[entrypoint] 已启动内置 Rootless Docker 与 sandbox manager；其未就绪不会重启 Web/数据库。"
        else
            EMBEDDED_SANDBOX_SUPERVISORD_PID=""
            echo "[entrypoint] 内置 Rootless Docker/sandbox manager 启动失败；Web 继续启动，Shell 将显示未就绪。" >&2
        fi
    elif [ "${GUGU_SANDBOX_MANAGER_MODE:-disabled}" != "external" ] \
        && [ "${GUGU_SANDBOX_MANAGER_MODE:-disabled}" != "disabled" ]; then
        echo "[entrypoint] 沙盒管理模式无效；Web 继续启动，Shell 保持关闭。" >&2
    fi
    if [ "${GUGU_ENABLE_RAG_SIDECAR:-1}" = "1" ]; then
        mkdir -p /run/gugu
        export SEARCH__TS_SIDECAR_SOCKET=/run/gugu/rag-sidecar.sock
        python -m agent.rag.sidecar_host --socket /run/gugu/rag-sidecar.sock &
        monitored_pids+=("$!")
    fi
    if [ "${GUGU_ENABLE_WORKER:-1}" = "1" ]; then
        worker_log=""
        if [ -n "${GUGU_LOG_FILE:-}" ]; then
            worker_log="$(dirname "$GUGU_LOG_FILE")/gugu-worker.log"
        fi
        GUGU_LOG_FILE="$worker_log" python -m worker &
        monitored_pids+=("$!")
    fi
    if [ "${GUGU_ENABLE_GATEWAY:-1}" = "1" ]; then
        gateway_log=""
        if [ -n "${GUGU_LOG_FILE:-}" ]; then
            gateway_log="$(dirname "$GUGU_LOG_FILE")/gugu-gateway.log"
        fi
        GUGU_LOG_FILE="$gateway_log" python -m agent.gateway.gateway &
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
    # 内置 postgres/redis 由 supervisord 托管：它退出（数据库两进程全挂）同样视为关键故障。
    [ -n "$EMBEDDED_SUPERVISORD_PID" ] && monitored_pids+=("$EMBEDDED_SUPERVISORD_PID")
    stop_children() {
        for pid in "${monitored_pids[@]}"; do
            kill "$pid" 2>/dev/null || true
        done
        if [ -n "$EMBEDDED_SANDBOX_SUPERVISORD_PID" ]; then
            # 独立 manager 接收 TERM 后由 supervisord 回收其 sandboxd 子进程。
            kill -TERM "$EMBEDDED_SANDBOX_SUPERVISORD_PID" 2>/dev/null || true
        fi
    }
    restart_for_app_update() {
        app_restart_requested=1
        stop_children
    }
    trap stop_children TERM INT
    if [ "${GUGU_UPDATE_DEPLOYMENT_MODE:-}" = "standalone_app_bundle" ]; then
        trap restart_for_app_update HUP
    fi

    # app-bundle 切换后需确认新代码确实能提供健康服务；若启动失败，恢复上一代码版本，
    # 再由同一容器入口重新启动。这里不接触数据库回滚或任何用户数据。
    if [ "${GUGU_UPDATE_DEPLOYMENT_MODE:-}" = "standalone_app_bundle" ]; then
        app_ready=0
        for _ in $(seq 1 90); do
            if curl -sf "http://127.0.0.1:${GUGU_HTTP_PORT:-9595}/health" >/dev/null; then
                app_ready=1
                break
            fi
            sleep 1
        done
        if [ "$app_ready" = 1 ]; then
            python /opt/gugu/app_bundle_runtime.py --mark-ready || true
        else
            if python /opt/gugu/app_bundle_runtime.py --rollback-pending; then
                stop_children
                for pid in "${monitored_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
                if [ -n "$EMBEDDED_SANDBOX_SUPERVISORD_PID" ]; then
                    wait "$EMBEDDED_SANDBOX_SUPERVISORD_PID" 2>/dev/null || true
                fi
                cd /
                exec /app/docker-entrypoint.sh "$@"
            fi
            echo "[entrypoint] 应用未通过健康检查；为避免数据库迁移后恢复旧代码造成 schema 不兼容，未自动回滚。请查看 updater 状态并使用完整镜像更新或人工恢复。" >&2
        fi
    fi

    while true; do
        if [ "$app_restart_requested" = 1 ]; then
            for pid in "${monitored_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
            if [ -n "$EMBEDDED_SANDBOX_SUPERVISORD_PID" ]; then
                wait "$EMBEDDED_SANDBOX_SUPERVISORD_PID" 2>/dev/null || true
            fi
            cd /
            exec /app/docker-entrypoint.sh "$@"
        fi
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
