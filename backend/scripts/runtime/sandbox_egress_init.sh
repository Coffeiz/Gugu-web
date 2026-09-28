#!/bin/sh
# 非 Compose / 一体化 Rootful 部署共用的受控 Docker egress 引导。
#
# systemd 直接运行 uvicorn/sandboxd 时，没有 Compose 的 egress-proxy 和
# sandboxd 启动前初始化流程。本脚本幂等准备同等资源：
#   1. 仅供沙盒使用的 internal Docker 网络；
#   2. 连接 internal 网络和默认 bridge 的 Squid 代理；
#   3. 使用固定容器名，避免把 Docker 动态 IP 写进运行配置。
set -eu

DOCKER_BIN="${DOCKER_BIN:-docker}"
EGRESS_NETWORK="${SANDBOX__EGRESS_NETWORK_NAME:-gugu-sandbox-egress}"
EGRESS_PROXY_URL="${GUGU_EGRESS_PROXY_URL:-http://egress-proxy:3128}"
EGRESS_CONFIG_FILE="${GUGU_EGRESS_CONFIG_FILE:-$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)/config.override.json}"
PROXY_CONTAINER_NAME="${GUGU_EGRESS_PROXY_CONTAINER_NAME:-egress-proxy}"
PROXY_UPLINK_NETWORK="${GUGU_EGRESS_PROXY_UPLINK_NETWORK:-bridge}"
PROXY_IMAGE="${GUGU_EGRESS_PROXY_IMAGE:-ubuntu/squid:latest}"
SQUID_CONF="${SQUID_CONF_PATH:-$(CDPATH= cd -- "$(dirname "$0")/../../squid" && pwd)/egress.conf}"
USE_CONFIG_FILE="${GUGU_EGRESS_USE_CONFIG_FILE:-1}"
REQUIRE_LABELS="${GUGU_EGRESS_REQUIRE_LABELS:-0}"
REQUIRE_LOCAL_IMAGE="${GUGU_EGRESS_REQUIRE_LOCAL_IMAGE:-0}"

log() { printf '[sandbox-egress] %s\n' "$*"; }
error() { printf '[sandbox-egress] ERROR: %s\n' "$*" >&2; }
docker_cli() { "$DOCKER_BIN" "$@"; }

# Admin 配置优先于 systemd 默认值，但只读取 egress 两个非敏感字段；不改写配置，
# 也不把代理地址输出到日志。这样可以兼容已有的非 Compose IP 配置，并让新部署使用 DNS。
if [ "$USE_CONFIG_FILE" = "1" ] && [ -r "$EGRESS_CONFIG_FILE" ]; then
    EGRESS_VALUES="$(${GUGU_EGRESS_PYTHON:-python3} - "$EGRESS_CONFIG_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    sandbox = json.load(handle).get("sandbox") or {}
print(str(sandbox.get("egress_proxy_url") or ""))
print(str(sandbox.get("egress_network_name") or ""))
print(str(sandbox.get("network_profile") or ""))
PY
    )" || {
        error "无法读取 egress 配置：$EGRESS_CONFIG_FILE"
        exit 1
    }
    configured_proxy_url="$(printf '%s\n' "$EGRESS_VALUES" | sed -n '1p')"
    configured_network="$(printf '%s\n' "$EGRESS_VALUES" | sed -n '2p')"
    configured_profile="$(printf '%s\n' "$EGRESS_VALUES" | sed -n '3p')"
    [ -z "$configured_profile" ] && configured_profile="${SANDBOX__NETWORK_PROFILE:-none}"
    if [ "$configured_profile" != "egress" ]; then
        log "network_profile 不是 egress，跳过代理引导"
        exit 0
    fi
    [ -n "$configured_proxy_url" ] && EGRESS_PROXY_URL="$configured_proxy_url"
    [ -n "$configured_network" ] && EGRESS_NETWORK="$configured_network"
elif [ "${SANDBOX__NETWORK_PROFILE:-none}" != "egress" ]; then
    log "未启用 egress，跳过代理引导"
    exit 0
fi

proxy_host="${EGRESS_PROXY_URL#*://}"
proxy_host="${proxy_host%%/*}"
proxy_host="${proxy_host%%:*}"

if [ ! -r "$SQUID_CONF" ]; then
    error "找不到 Squid 配置：$SQUID_CONF"
    exit 1
fi

# Rootless Docker 的用户 socket 可能比 systemd unit 晚几秒出现；等待而不是
# 让 sandboxd 先启动后永久记住“网络不存在”。
docker_ready=0
for _ in $(seq 1 "${GUGU_EGRESS_DOCKER_WAIT_SECONDS:-30}"); do
    if docker_cli info >/dev/null 2>&1; then
        docker_ready=1
        break
    fi
    sleep 1
done
if [ "$docker_ready" -ne 1 ]; then
    error "Docker daemon 不可达，请检查 DOCKER_HOST 和 daemon 状态"
    exit 1
fi

network_exists() {
    docker_cli network inspect "$EGRESS_NETWORK" >/dev/null 2>&1
}

network_is_managed() {
    managed_label="$(docker_cli network inspect --format '{{ index .Labels "gugu.managed" }}' "$EGRESS_NETWORK" 2>/dev/null || true)"
    network_label="$(docker_cli network inspect --format '{{ index .Labels "gugu.egress.network" }}' "$EGRESS_NETWORK" 2>/dev/null || true)"
    network_driver="$(docker_cli network inspect --format '{{ .Driver }}' "$EGRESS_NETWORK" 2>/dev/null || true)"
    network_internal="$(docker_cli network inspect --format '{{ .Internal }}' "$EGRESS_NETWORK" 2>/dev/null || true)"
    [ "$managed_label" = "egress-network" ] \
        && [ "$network_label" = "$EGRESS_NETWORK" ] \
        && [ "$network_driver" = "bridge" ] \
        && [ "$network_internal" = "true" ]
}

if network_exists; then
    if [ "$REQUIRE_LABELS" = "1" ] && ! network_is_managed; then
        error "同名 Docker 网络不属于 Gugu egress 管理器，拒绝接管"
        exit 1
    fi
else
    log "创建 internal 网络：$EGRESS_NETWORK"
    docker_cli network create --internal \
        --label gugu.managed=egress-network \
        --label "gugu.egress.network=$EGRESS_NETWORK" \
        "$EGRESS_NETWORK" >/dev/null
fi

if ! docker_cli image inspect "$PROXY_IMAGE" >/dev/null 2>&1; then
    if [ "$REQUIRE_LOCAL_IMAGE" = "1" ]; then
        error "内置 egress 代理镜像未加载，拒绝在线拉取"
        exit 1
    fi
    log "拉取 egress 代理镜像：$PROXY_IMAGE"
    docker_cli pull "$PROXY_IMAGE" >/dev/null
fi

container_exists() {
    docker_cli container inspect "$PROXY_CONTAINER_NAME" >/dev/null 2>&1
}

container_is_managed() {
    managed_label="$(docker_cli container inspect --format '{{ index .Config.Labels "gugu.managed" }}' "$PROXY_CONTAINER_NAME" 2>/dev/null || true)"
    network_label="$(docker_cli container inspect --format '{{ index .Config.Labels "gugu.egress.network" }}' "$PROXY_CONTAINER_NAME" 2>/dev/null || true)"
    configured_image="$(docker_cli container inspect --format '{{ .Config.Image }}' "$PROXY_CONTAINER_NAME" 2>/dev/null || true)"
    privileged="$(docker_cli container inspect --format '{{ .HostConfig.Privileged }}' "$PROXY_CONTAINER_NAME" 2>/dev/null || true)"
    mounts="$(docker_cli container inspect --format '{{range .Mounts}}{{.Source}}={{.Destination}} {{end}}' "$PROXY_CONTAINER_NAME" 2>/dev/null || true)"
    [ "$managed_label" = "egress-proxy" ] \
        && [ "$network_label" = "$EGRESS_NETWORK" ] \
        && [ "$configured_image" = "$PROXY_IMAGE" ] \
        && [ "$privileged" = "false" ] || return 1
    case "$mounts" in *docker.sock*) return 1 ;; esac
    return 0
}

network_has_container() {
    network="$1"
    docker_cli network inspect --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' "$network" 2>/dev/null \
        | grep -Fxq "$PROXY_CONTAINER_NAME"
}

connect_network() {
    network="$1"
    if ! docker_cli network inspect "$network" >/dev/null 2>&1; then
        error "代理上联网络不存在：$network"
        exit 1
    fi
    if ! network_has_container "$network"; then
        log "连接代理网络：$network"
        docker_cli network connect "$network" "$PROXY_CONTAINER_NAME"
    fi
}

if ! container_exists; then
    log "创建代理容器：$PROXY_CONTAINER_NAME"
    set -- create \
        --name "$PROXY_CONTAINER_NAME" \
        --label gugu.managed=egress-proxy \
        --label gugu.egress.network="$EGRESS_NETWORK" \
        --network "$EGRESS_NETWORK" \
        --restart unless-stopped \
        --volume "$SQUID_CONF:/etc/squid/squid.conf:ro"

    # 兼容旧的非 Compose 配置：如果 Admin 里暂时保存的是独立网络 IP，
    # 首次创建时固定该 IP；新部署默认走 egress-proxy DNS，不再依赖动态 IP。
    case "$proxy_host" in
        *.*.*.*)
            set -- "$@" --ip "$proxy_host"
            ;;
        egress-proxy|"")
            ;;
        *)
            set -- "$@" --network-alias "$proxy_host"
            ;;
    esac
    set -- "$@" "$PROXY_IMAGE"

    if ! docker_cli "$@" >/dev/null; then
        error "代理容器创建失败"
        exit 1
    fi
elif [ "$REQUIRE_LABELS" = "1" ] && ! container_is_managed; then
    error "同名容器不属于 Gugu egress 管理器，拒绝接管"
    exit 1
fi

# 代理必须能出网；沙盒只能看到 internal 网络，不能连接 bridge。
connect_network "$EGRESS_NETWORK"
connect_network "$PROXY_UPLINK_NETWORK"

if ! docker_cli container inspect -f '{{.State.Running}}' "$PROXY_CONTAINER_NAME" 2>/dev/null | grep -q true; then
    log "启动代理容器：$PROXY_CONTAINER_NAME"
    docker_cli start "$PROXY_CONTAINER_NAME" >/dev/null
fi

if ! docker_cli container inspect -f '{{.State.Running}}' "$PROXY_CONTAINER_NAME" 2>/dev/null | grep -q true; then
    error "代理容器启动后仍未处于运行状态"
    exit 1
fi

log "就绪：$PROXY_CONTAINER_NAME（$EGRESS_NETWORK → $PROXY_UPLINK_NETWORK）"
