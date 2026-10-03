#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "用法：start_embedded_sandbox_manager.sh <socket> <allowed-root> <supervisor-dir>" >&2
    exit 2
fi

EMBEDDED_SANDBOX_SOCKET="$1"
EMBEDDED_DATA_ROOT="$2"
SANDBOX_SUPERVISOR_DIR="$3"
ROOTLESS_UID=1000
ROOTLESS_GID=1000
ROOTLESS_HOME="${GUGU_ROOTLESS_HOME:-/var/lib/gugu-rootless}"
ROOTLESS_DATA_ROOT="${GUGU_ROOTLESS_DATA_ROOT:-/data/sandbox-rootless}"
ROOTLESS_RUNTIME_DIR="${GUGU_ROOTLESS_RUNTIME_DIR:-/run/user/$ROOTLESS_UID}"
ROOTLESS_DOCKER_SOCKET="$ROOTLESS_RUNTIME_DIR/docker.sock"
ROOTLESS_SCRIPT="${GUGU_DOCKERD_ROOTLESS_SCRIPT:-/usr/local/bin/dockerd-rootless.sh}"
SUBUID_FILE="${GUGU_ROOTLESS_SUBUID_FILE:-/etc/subuid}"
SUBGID_FILE="${GUGU_ROOTLESS_SUBGID_FILE:-/etc/subgid}"
IDENTITY_FILE="${GUGU_SANDBOX_STORAGE_IDENTITY_FILE:-/run/gugu/sandbox-storage-identity.json}"

case "$ROOTLESS_UID:$ROOTLESS_GID" in
    *[!0-9:]*|0:*|*:0)
        echo "Rootless daemon UID/GID 配置无效" >&2
        exit 2
        ;;
esac

if [ ! -x "$ROOTLESS_SCRIPT" ] || ! command -v dockerd >/dev/null 2>&1 \
    || ! command -v rootlesskit >/dev/null 2>&1 || ! command -v newuidmap >/dev/null 2>&1 \
    || ! command -v newgidmap >/dev/null 2>&1 || ! command -v slirp4netns >/dev/null 2>&1 \
    || ! command -v fuse-overlayfs >/dev/null 2>&1; then
    echo "内置 Rootless Docker 运行依赖不完整" >&2
    exit 1
fi

if ! grep -q "^gugu-rootless:100000:65536$" "$SUBUID_FILE" \
    || ! grep -q "^gugu-rootless:100000:65536$" "$SUBGID_FILE"; then
    echo "内置 Rootless Docker subordinate UID/GID 映射缺失" >&2
    exit 1
fi

install -d -o "$ROOTLESS_UID" -g "$ROOTLESS_GID" -m 0700 "$ROOTLESS_HOME" "$ROOTLESS_RUNTIME_DIR" "$ROOTLESS_DATA_ROOT"
if [ "$(stat -c %u "$ROOTLESS_DATA_ROOT")" != "$ROOTLESS_UID" ]; then
    chown "$ROOTLESS_UID:$ROOTLESS_GID" "$ROOTLESS_DATA_ROOT"
fi

install -d -m 0755 "$(dirname "$IDENTITY_FILE")"
IDENTITY_TMP="$IDENTITY_FILE.tmp.$$"
printf '{"schema":1,"daemon_mode":"rootless","container_uid":65532,"container_gid":65532,"mapped_uid":165531,"mapped_gid":165531}\n' > "$IDENTITY_TMP"
chmod 0644 "$IDENTITY_TMP"
mv -f "$IDENTITY_TMP" "$IDENTITY_FILE"

mkdir -p "$(dirname "$EMBEDDED_SANDBOX_SOCKET")" "$EMBEDDED_DATA_ROOT" "$SANDBOX_SUPERVISOR_DIR"
cat > "$SANDBOX_SUPERVISOR_DIR/supervisord.conf" <<SUPERVISOR_EOF
[unix_http_server]
file=$SANDBOX_SUPERVISOR_DIR/supervisor.sock
chmod=0700

[supervisord]
nodaemon=false
logfile=$SANDBOX_SUPERVISOR_DIR/supervisord.log
pidfile=$SANDBOX_SUPERVISOR_DIR/supervisord.pid
childlogdir=$SANDBOX_SUPERVISOR_DIR

[supervisorctl]
serverurl=unix://$SANDBOX_SUPERVISOR_DIR/supervisor.sock

[program:rootless-dockerd]
directory=$ROOTLESS_HOME
command=$ROOTLESS_SCRIPT --host=unix://$ROOTLESS_DOCKER_SOCKET --data-root=$ROOTLESS_DATA_ROOT --storage-driver=fuse-overlayfs
user=gugu-rootless
environment=HOME="$ROOTLESS_HOME",XDG_RUNTIME_DIR="$ROOTLESS_RUNTIME_DIR",DOCKER_HOST="unix://$ROOTLESS_DOCKER_SOCKET",DOCKERD_ROOTLESS_ROOTLESSKIT_NET="slirp4netns",DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR="$ROOTLESS_RUNTIME_DIR/dockerd-rootless"
autostart=true
autorestart=true
priority=10
startsecs=0
startretries=0
stopsignal=TERM
stopasgroup=true
killasgroup=true
stopwaitsecs=30
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:sandboxd]
directory=/app
command=python -m agent.sandbox.sandboxd --socket $EMBEDDED_SANDBOX_SOCKET --allowed-root $EMBEDDED_DATA_ROOT
environment=HOME="$ROOTLESS_HOME",XDG_RUNTIME_DIR="$ROOTLESS_RUNTIME_DIR",DOCKER_HOST="unix://$ROOTLESS_DOCKER_SOCKET"
priority=20
autostart=true
autorestart=true
startsecs=0
startretries=0
stopsignal=TERM
stopasgroup=true
killasgroup=true
stopwaitsecs=30
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
SUPERVISOR_EOF

if ! supervisord -c "$SANDBOX_SUPERVISOR_DIR/supervisord.conf"; then
    echo "sandbox manager supervisor 启动失败" >&2
    exit 1
fi

SUPERVISOR_PID="$(cat "$SANDBOX_SUPERVISOR_DIR/supervisord.pid" 2>/dev/null || true)"
case "$SUPERVISOR_PID" in
    ''|*[!0-9]*|0)
        echo "sandbox manager supervisor 未返回有效 PID" >&2
        exit 1
        ;;
esac

printf '%s\n' "$SUPERVISOR_PID"
