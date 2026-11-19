#!/bin/sh
# 在部署机安装前，由管理员在干净的 Linux 构建环境生成独立运行根。
set -eu
if [ "$(id -u)" -ne 0 ] || [ "$#" -ne 1 ]; then
    echo "以 root 运行，参数为尚不存在的绝对目标目录" >&2
    exit 2
fi
target=$1
case "$target" in
    /*) ;;
    *) echo "运行根必须使用绝对路径" >&2; exit 2 ;;
esac
if [ -e "$target" ] || [ -L "$target" ] || [ "$(realpath -m -- "$target")" != "$target" ]; then
    echo "运行根目标必须为尚不存在的规范路径" >&2
    exit 2
fi
umask 022
keyring=/usr/share/keyrings/debian-archive-keyring.gpg
if [ ! -r "$keyring" ]; then
    echo "缺少 Debian 软件包签名密钥，请安装 debian-archive-keyring" >&2
    exit 2
fi
debootstrap --force-check-gpg --keyring="$keyring" --variant=minbase \
    --include=bash,coreutils,findutils,grep,sed,tar,ca-certificates \
    bookworm "$target" https://deb.debian.org/debian
install -d -m 0755 "$target/workspace" "$target/project" "$target/personal"
# debootstrap 会复制构建机的解析器配置和主机名。运行根只保留固定值。
rm -f -- "$target/etc/resolv.conf" "$target/etc/hosts" "$target/etc/hostname" \
    "$target/etc/machine-id" "$target/var/lib/dbus/machine-id"
printf '%s\n' '# Gugu sandbox has no DNS' > "$target/etc/resolv.conf"
printf '%s\n' '127.0.0.1 localhost' '::1 localhost' > "$target/etc/hosts"
printf '%s\n' 'gugu-sandbox' > "$target/etc/hostname"
: > "$target/etc/machine-id"
printf '%s\n' 'gugu-bubblewrap-rootfs-v1' > "$target/etc/gugu-sandbox-release"
