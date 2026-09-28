#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "用法：start_embedded_sandbox_manager.sh <socket> <allowed-root> <supervisor-dir>" >&2
    exit 2
fi

EMBEDDED_SANDBOX_SOCKET="$1"
EMBEDDED_DATA_ROOT="$2"
SANDBOX_SUPERVISOR_DIR="$3"

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

[program:sandboxd]
directory=/app
command=python -m agent.sandbox.sandboxd --socket $EMBEDDED_SANDBOX_SOCKET --allowed-root $EMBEDDED_DATA_ROOT
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
