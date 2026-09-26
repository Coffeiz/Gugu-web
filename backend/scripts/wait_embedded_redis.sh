#!/bin/sh
# Redis TCP 端口开放不代表持久化数据加载完成；LOADING 期间命令会返回 BusyLoadingError。
set -eu

wait_seconds="${GUGU_EMBEDDED_REDIS_WAIT_SECONDS:-120}"
case "$wait_seconds" in
    ''|*[!0-9]*|0)
        echo "[entrypoint] GUGU_EMBEDDED_REDIS_WAIT_SECONDS 必须是正整数。" >&2
        exit 2
        ;;
esac

if ! command -v redis-cli >/dev/null 2>&1; then
    echo "[entrypoint] 找不到 redis-cli，无法确认内置 Redis 已就绪。" >&2
    exit 1
fi

for _ in $(seq 1 "$wait_seconds"); do
    if [ "$(redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null || true)" = "PONG" ]; then
        echo "[entrypoint] 内置 Redis 已就绪"
        exit 0
    fi
    sleep 1
done

echo "[entrypoint] 等待内置 Redis 完成数据加载超时（${wait_seconds}s），放弃启动。" >&2
exit 1
