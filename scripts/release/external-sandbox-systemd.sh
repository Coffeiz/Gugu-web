#!/usr/bin/env bash
# 在 external manager 所在主机执行；调用用户必须有该固定单元的管理权限。
set -euo pipefail
UNIT="${EXTERNAL_SANDBOX_SYSTEMD_UNIT:-gugu-sandboxd.service}"
[[ "$UNIT" =~ ^gugu-sandboxd(-[a-z0-9-]+)?\.service$ ]] || { echo 'sandbox 单元名超出允许范围。' >&2; exit 2; }
SYSTEMCTL=(systemctl)
if [[ "${EXTERNAL_SANDBOX_SYSTEMD_USER:-0}" == 1 ]]; then SYSTEMCTL+=(--user); fi
case "${1:-}" in
  status)
    [[ "$("${SYSTEMCTL[@]}" show "$UNIT" --property=LoadState --value)" == loaded ]] || exit 1
    state="$("${SYSTEMCTL[@]}" show "$UNIT" --property=ActiveState --value)"
    case "$state" in
      active) echo running ;;
      inactive|failed)
        [[ "$("${SYSTEMCTL[@]}" show "$UNIT" --property=MainPID --value)" == 0 ]] || exit 1
        echo stopped ;;
      *) exit 1 ;;
    esac
    ;;
  stop|start) "${SYSTEMCTL[@]}" "$1" "$UNIT" ;;
  *) exit 2 ;;
esac
