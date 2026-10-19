#!/bin/sh
set -eu

config_dir="${ADMIN_ENTRY_CONFIG_DIR:-/etc/nginx/conf.d}"
http_config="$config_dir/admin-entry-http.conf"
server_config="$config_dir/admin-entry-server.conf"
host_http_config="$config_dir/admin-host-http.conf"
entry_path="${GUGU_ADMIN_ENTRY_PATH:-}"
allowed_hosts="${GUGU_ADMIN_ALLOWED_HOSTS:-}"

mkdir -p "$config_dir"

if [ -n "$entry_path" ]; then
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
fi

host_http_tmp="$host_http_config.tmp"
http_tmp="$http_config.tmp"
server_tmp="$server_config.tmp"
trap 'rm -f "$host_http_tmp" "$http_tmp" "$server_tmp"' EXIT HUP INT TERM

{
    printf '%s\n' 'map $host $gugu_admin_host_ok {'
    if [ -z "$(printf '%s' "$allowed_hosts" | tr -d '[:space:]')" ]; then
        printf '%s\n' '    default 1;'
    else
        printf '%s\n' '    default 0;'
        remaining="$allowed_hosts"
        seen_hosts=,
        while :; do
            case "$remaining" in
                *,*) host="${remaining%%,*}"; remaining="${remaining#*,}"; has_more=1 ;;
                *) host="$remaining"; remaining=; has_more=0 ;;
            esac
            host="$(printf '%s' "$host" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
            if [ -z "$host" ] || [ "${#host}" -gt 253 ] \
                || ! printf '%s\n' "$host" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)(\.([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?))*$' \
                || ! printf '%s\n' "$host" | awk -F. '{ for (i = 1; i <= NF; i++) if (length($i) > 63) exit 1 }'; then
                printf '%s\n' 'GUGU_ADMIN_ALLOWED_HOSTS 包含无效域名。' >&2
                exit 1
            fi
            case "$seen_hosts" in
                *",$host,"*) ;;
                *) printf '    "%s" 1;\n' "$host"; seen_hosts="$seen_hosts$host," ;;
            esac
            [ "$has_more" -eq 1 ] || break
        done
    fi
    printf '%s\n' '}'
} > "$host_http_tmp"

{
    printf '%s\n' 'map $cookie_gugu_admin_entry $gugu_admin_entry_ok {'
    if [ -z "$entry_path" ]; then
        printf '%s\n' '    default 1;'
    else
        printf '%s\n' '    default 0;'
        printf '    "%s" 1;\n' "$entry_path"
    fi
    printf '%s\n' '}'
} > "$http_tmp"

if [ -z "$entry_path" ]; then
    : > "$server_tmp"
else
    {
        printf 'location = /%s {\n' "$entry_path"
        printf '%s\n' '    if ($gugu_admin_host_ok = 0) { return 404; }' '    access_log off;'
        printf '    add_header Set-Cookie "gugu_admin_entry=%s; Path=/; HttpOnly; Secure; SameSite=Strict" always;\n' "$entry_path"
        printf '%s\n' '    return 302 /admin/;' '}'
    } > "$server_tmp"
fi

mv "$host_http_tmp" "$host_http_config"
mv "$http_tmp" "$http_config"
mv "$server_tmp" "$server_config"
trap - EXIT HUP INT TERM
