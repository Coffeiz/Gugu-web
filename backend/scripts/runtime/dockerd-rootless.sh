#!/bin/sh
set -eu

ROOTLESS_SCRIPT=/usr/share/docker.io/contrib/dockerd-rootless.sh
if [ ! -x "$ROOTLESS_SCRIPT" ]; then
    echo "Debian Docker Rootless 启动脚本不可用" >&2
    exit 1
fi

exec "$ROOTLESS_SCRIPT" "$@"
