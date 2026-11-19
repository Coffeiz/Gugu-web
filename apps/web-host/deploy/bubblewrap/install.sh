#!/bin/sh
# 为原生 Linux Web Host 安装标准路径下的 Bubblewrap 运行环境。
set -eu
if [ "$(id -u)" -ne 0 ]; then
    echo '请以管理员身份安装 Bubblewrap 运行环境' >&2
    exit 2
fi
help=$(/usr/bin/bwrap --help 2>&1 || :)
for option in --bind-fd --ro-bind-fd --disable-userns; do
    if ! printf '%s\n' "$help" | grep -Fq -- "$option"; then
        printf '请先安装支持 %s 的 /usr/bin/bwrap\n' "$option" >&2
        exit 2
    fi
done
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
base=/var/lib/gugu-sandbox
rootfs=$base/rootfs
if [ -L "$base" ] || { [ -e "$base" ] && [ "$(stat -c '%u:%a' -- "$base")" != '0:755' ]; }; then
    echo '标准运行目录必须由 root 所有，权限为 0755' >&2
    exit 2
fi
install -d -o root -g root -m 0755 "$base"
exec 9>"$base/.install.lock"
flock -x 9

if [ -e "$rootfs" ] || [ -L "$rootfs" ]; then
    if [ -L "$rootfs" ] || [ ! -d "$rootfs" ] ||
       [ "$(stat -c '%u:%a' -- "$rootfs")" != '0:755' ] ||
       ! grep -qx 'gugu-bubblewrap-rootfs-v1' "$rootfs/etc/gugu-sandbox-release"; then
        echo '已有运行根无法识别，请先核对该目录' >&2
        exit 2
    fi
else
    scratch=$(mktemp -d "$base/.build.XXXXXX")
    trap 'rm -rf -- "$scratch"' EXIT
    trap 'exit 1' HUP INT TERM
    sh "$here/build-rootfs.sh" "$scratch/rootfs"
    mv -T -- "$scratch/rootfs" "$rootfs"
fi
sh "$here/install-pty.sh"
printf '%s\n' 'Bubblewrap 运行文件已安装。Web Host 将自动探测标准运行根。'
