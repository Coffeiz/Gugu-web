#!/bin/sh
# 编译并安装 Web Host 使用的 Linux PTY 启动器。
set -eu
if [ "$(id -u)" -ne 0 ]; then
    echo "请以管理员身份安装 PTY 启动器" >&2
    exit 2
fi
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_file="$here/../../../../packages/sandbox/native/linux/pty.c"
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
cc -O2 -Wall -Wextra -Werror "$source_file" -o "$scratch/gugu-bubblewrap-pty" -lutil
install -D -o root -g root -m 0755 "$scratch/gugu-bubblewrap-pty" /usr/libexec/gugu-bubblewrap-pty
