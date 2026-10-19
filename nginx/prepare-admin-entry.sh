#!/bin/sh
set -eu

config_dir="${ADMIN_ENTRY_CONFIG_DIR:-/etc/nginx/conf.d}"
http_config="$config_dir/admin-entry-http.conf"
server_config="$config_dir/admin-entry-server.conf"
entry_path="${GUGU_ADMIN_ENTRY_PATH:-}"

mkdir -p "$config_dir"

if [ -z "$entry_path" ]; then
    printf '%s\n' 'map $cookie_gugu_admin_entry $gugu_admin_entry_ok {' '    default 1;' '}' > "$http_config"
    : > "$server_config"
    exit 0
fi

case "$entry_path" in
    *[!A-Za-z0-9_-]*)
        printf '%s\n' 'GUGU_ADMIN_ENTRY_PATH 只能包含字母、数字、下划线和连字符。' >&2
        exit 1
        ;;
esac

if [ "${#entry_path}" -gt 128 ]; then
    printf '%s\n' 'GUGU_ADMIN_ENTRY_PATH 长度不能超过 128 个字符。' >&2
    exit 1
fi

http_tmp="$http_config.tmp"
server_tmp="$server_config.tmp"
trap 'rm -f "$http_tmp" "$server_tmp"' EXIT HUP INT TERM

{
    printf '%s\n' 'map $cookie_gugu_admin_entry $gugu_admin_entry_ok {' '    default 0;'
    printf '    "%s" 1;\n' "$entry_path"
    printf '%s\n' '}'
} > "$http_tmp"

{
    printf 'location = /%s {\n' "$entry_path"
    printf '%s\n' '    access_log off;'
    printf '    add_header Set-Cookie "gugu_admin_entry=%s; Path=/; HttpOnly; Secure; SameSite=Strict" always;\n' "$entry_path"
    printf '%s\n' '    return 302 /admin/;' '}'
} > "$server_tmp"

mv "$http_tmp" "$http_config"
mv "$server_tmp" "$server_config"
trap - EXIT HUP INT TERM
