#!/bin/sh
# PostgreSQL 在 recovery 期间可能已监听 TCP，但还不能接受连接；必须等 pg_isready 成功。
set -eu

wait_seconds="${GUGU_EMBEDDED_PG_WAIT_SECONDS:-300}"
case "$wait_seconds" in
    ''|*[!0-9]*|0)
        echo "[entrypoint] GUGU_EMBEDDED_PG_WAIT_SECONDS 必须是正整数。" >&2
        exit 2
        ;;
esac

pg_isready_bin="${1:-pg_isready}"
if [ ! -x "$pg_isready_bin" ]; then
    echo "[entrypoint] 找不到可执行的 pg_isready（${pg_isready_bin}），无法确认内置 PostgreSQL 已就绪。" >&2
    exit 1
fi

for _ in $(seq 1 "$wait_seconds"); do
    if "$pg_isready_bin" -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
        echo "[entrypoint] 内置 PostgreSQL 已就绪"
        exit 0
    fi
    sleep 1
done

echo "[entrypoint] 等待内置 PostgreSQL 就绪超时（${wait_seconds}s），放弃启动。" >&2
exit 1
