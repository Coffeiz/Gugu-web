#!/usr/bin/env bash
# 部署管理员提供固定生命周期控制器；不能把模型输入或任意 shell 字符串作为控制命令。
set -euo pipefail
CONTROL="${EXTERNAL_SANDBOX_CONTROL:?external sandbox 必须配置生命周期控制器}"
ROOTLESS_HOST="${EXTERNAL_SANDBOX_DOCKER_HOST:?必须指定实际 Rootless Docker Unix socket}"
DATA_SOURCE="${SANDBOX_DATA_SOURCE:?必须指定本部署数据挂载来源}"
STATE_FILE="${SANDBOX_STATE_FILE:?必须指定受保护的更新状态文件}"
[[ "$CONTROL" == /* && -f "$CONTROL" && -x "$CONTROL" && ! -L "$CONTROL" ]] \
  || { echo 'external sandbox 控制器必须是管理员提供的普通可执行文件。' >&2; exit 1; }
[[ "$ROOTLESS_HOST" == unix:///* && "$DATA_SOURCE" == /* && "$DATA_SOURCE" != / ]] \
  || { echo 'external sandbox 必须使用 Unix socket 和明确的数据根。' >&2; exit 1; }

case "${1:-}" in
  stop)
    previous="$("$CONTROL" status)"
    [[ "$previous" == running || "$previous" == stopped ]] || { echo 'external manager 状态无法验证。' >&2; exit 1; }
    "$CONTROL" stop
    [[ "$("$CONTROL" status)" == stopped ]] || { echo 'external manager 未停止，拒绝备份和迁移。' >&2; exit 1; }
    # 普通 Docker CLI 看不到 Rootless 执行容器；必须连接明确的 daemon，拒绝 rootful 冒充。
    security="$(docker --host "$ROOTLESS_HOST" info --format '{{json .SecurityOptions}}')"
    node -e 'if(!JSON.parse(process.argv[1]).some(x=>x.includes("rootless")))process.exit(1)' "$security"
    ids="$(docker --host "$ROOTLESS_HOST" ps -q --filter label=com.gugu.sandbox=true)"
    while read -r id; do
      [[ -n "$id" ]] || continue
      mounts="$(docker --host "$ROOTLESS_HOST" inspect --format '{{json .Mounts}}' "$id")"
      if node -e '
const root=process.argv[1].replace(/\/$/,"");
process.exit(JSON.parse(process.argv[2]).some(m=>m.Source===root||m.Source?.startsWith(root+"/"))?0:3)
' "$DATA_SOURCE" "$mounts"; then
        docker --host "$ROOTLESS_HOST" stop "$id" >/dev/null
        [[ "$(docker --host "$ROOTLESS_HOST" inspect --format '{{.State.Running}}' "$id")" == false ]] \
          || { echo 'Rootless 执行容器仍在运行，拒绝迁移。' >&2; exit 1; }
      else
        status=$?
        [[ "$status" == 3 ]] || exit "$status"
      fi
    done <<<"$ids"
    [[ "$("$CONTROL" status)" == stopped ]] || { echo 'external manager 已重新启动，拒绝迁移。' >&2; exit 1; }
    printf '%s\n' "$previous" > "$STATE_FILE"
    ;;
  start)
    [[ -f "$STATE_FILE" ]] || { echo 'external manager 停服状态缺失，拒绝恢复。' >&2; exit 1; }
    if [[ "$(<"$STATE_FILE")" == running ]]; then
      "$CONTROL" start
      [[ "$("$CONTROL" status)" == running ]] || { echo 'external manager 未恢复。' >&2; exit 1; }
    fi
    ;;
  *) echo '仅支持 stop/start。' >&2; exit 2 ;;
esac
