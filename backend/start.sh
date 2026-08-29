#!/usr/bin/env bash
# ============================================================
#  Gugu 后端启动脚本（Linux）
#  用法: ./start.sh {start|stop|restart|status|logs|foreground|install}
#
#  - 自动识别 .venv / venv
#  - 写 PID 文件，避免重复启动
#  - 日志落到 ./logs/gugu.log
#  - 启动失败自动给出排查命令
#  - 不再被 DB 卡住（lifespan 5s 超时 + 后台重试）
# ============================================================
set -euo pipefail

# ── 配置（可通过环境变量覆盖） ─────────────────────────
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${APP_DIR}/.venv"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
WORKERS="${WORKERS:-1}"
LOG_DIR="${APP_DIR}/logs"
LOG_FILE="${LOG_DIR}/gugu.log"
PID_FILE="${APP_DIR}/.gugu.pid"
# 生产核心 owner：FastAPI、Python IM worker/gateway 与 sandboxd；实时事件入口也由 FastAPI 提供。
SYSTEMD_SERVICES="gugu-sandboxd gugu-backend gugu-worker gugu-gateway"

# ── 工具函数 ────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { log "WARN: $*"; }
err()  { log "ERROR: $*"; }

detect_venv() {
    if [ -d "$VENV_DIR" ]; then return 0; fi
    if [ -d "${APP_DIR}/venv" ]; then VENV_DIR="${APP_DIR}/venv"; return 0; fi
    err "未找到 venv，请先创建："
    err "  cd $APP_DIR && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
    exit 1
}

is_running() {
    [ -f "$PID_FILE" ] || return 1
    local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

use_systemd() {
    [ "${GUGU_SERVICE_MODE:-auto}" != "local" ] || return 1
    command -v systemctl >/dev/null 2>&1 || return 1
    [ "${GUGU_SERVICE_MODE:-auto}" = "systemd" ] && return 0
    [ -f "/etc/systemd/system/gugu-backend.service" ] && return 0
    systemctl list-unit-files 2>/dev/null | grep -q '^gugu-backend.service[[:space:]]'
}

# systemd 的批量操作只认证一次。普通用户先建立 sudo 凭据缓存，
# 再以 root 重新执行同一个子命令，避免每个服务单独触发认证。
elevate_systemd_once() {
    # cleanup-port 由 systemd 的 ExecStartPre 调用，不能尝试交互式 sudo。
    if [ "${1:-}" = "cleanup-port" ] || ! use_systemd || [ "$(id -u)" -eq 0 ] || [ "${GUGU_SYSTEMD_PRIV_ESCALATED:-0}" = "1" ]; then
        return 0
    fi
    command -v sudo >/dev/null 2>&1 || {
        err "systemd 操作需要 root 权限，但未找到 sudo"
        return 1
    }
    sudo -v || {
        err "sudo 认证失败，未执行 systemd 操作"
        return 1
    }
    export GUGU_SYSTEMD_PRIV_ESCALATED=1
    exec sudo -n -E "$0" "$@"
}

check_systemd_services() {
    local attempts="${GUGU_SYSTEMD_CHECK_ATTEMPTS:-10}"
    local delay="${GUGU_SYSTEMD_CHECK_DELAY:-1}"
    local stable_checks="${GUGU_SYSTEMD_STABLE_CHECKS:-3}"
    local attempt service all_active consecutive=0

    for ((attempt = 1; attempt <= attempts; attempt++)); do
        all_active=1
        for service in $SYSTEMD_SERVICES; do
            if ! systemctl is-active --quiet "$service"; then
                all_active=0
            fi
        done
        if [ "$all_active" -eq 1 ]; then
            consecutive=$((consecutive + 1))
            if [ "$consecutive" -ge "$stable_checks" ]; then
                return 0
            fi
        else
            consecutive=0
        fi
        if [ "$attempt" -lt "$attempts" ]; then
            sleep "$delay"
        fi
    done

    err "systemd 服务未全部处于 active 状态："
    for service in $SYSTEMD_SERVICES; do
        systemctl --no-pager --lines=12 status "$service" || true
    done
    return 1
}

# 在 systemd 重启前只加载配置，不连接数据库、不修改运行数据。
# 配置不完整时直接终止，避免先停止现有服务再暴露启动错误。
validate_runtime_config() {
    detect_venv
    if ! (cd "$APP_DIR" && "$VENV_DIR/bin/python" -c 'from app.core.config import get_settings; get_settings()'); then
        err "运行配置预检失败，未执行 systemd 操作；请修复配置后重试。"
        return 1
    fi
    log "配置预检通过"
}

wait_for_port() {
    for _ in $(seq 1 15); do
        if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# 防御性清理：如果端口被占且不是本脚本启动的进程，提示用户
check_port_free() {
    if command -v ss >/dev/null 2>&1; then
        local occupied; occupied="$(ss -tlnp 2>/dev/null | grep ":${PORT} " || true)"
        if [ -n "$occupied" ] && ! is_running; then
            err "端口 ${PORT} 已被其他进程占用："
            err "  $occupied"
            err "请先释放：fuser -k ${PORT}/tcp 或 ./start.sh stop"
            exit 1
        fi
    fi
}

# 找出占用目标端口的 Gugu Uvicorn 实例。
# 不能直接使用 `fuser -k`：同一台机器上可能还有其他项目监听相邻端口，
# 而且手动启动的旧实例通常没有 .gugu.pid，必须先根据完整命令行确认归属。
gugu_port_pids() {
    local pid args
    local pids=""

    if command -v lsof >/dev/null 2>&1; then
        pids="$(lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    elif command -v fuser >/dev/null 2>&1; then
        pids="$(fuser -n tcp "${PORT}" 2>/dev/null | tr ' ' '\n' | sed '/^$/d')"
    fi

    for pid in $pids; do
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
        if [[ "$args" == *"$APP_DIR"* ]] &&
           [[ "$args" == *"uvicorn"* ]] &&
           [[ "$args" == *"app.main:app"* ]]; then
            printf '%s\n' "$pid"
        fi
    done
}

cleanup_gugu_port() {
    local pids pid remaining
    pids="$(gugu_port_pids)"
    if [ -z "$pids" ]; then
        return 0
    fi

    log "清理 ${PORT} 端口上的 Gugu Uvicorn 实例：$(printf '%s ' $pids)"
    for pid in $pids; do
        kill "$pid" 2>/dev/null || true
    done

    for _ in $(seq 1 10); do
        remaining="$(gugu_port_pids)"
        [ -z "$remaining" ] && return 0
        sleep 1
    done

    remaining="$(gugu_port_pids)"
    if [ -n "$remaining" ]; then
        warn "Gugu Uvicorn 未在宽限期内退出，强制结束：$(printf '%s ' $remaining)"
        for pid in $remaining; do
            kill -9 "$pid" 2>/dev/null || true
        done
    fi
}

# ── 子命令 ──────────────────────────────────────────────
cmd_start() {
    if use_systemd; then
        validate_runtime_config
        log "使用 systemd 启动：${SYSTEMD_SERVICES}"
        systemctl start $SYSTEMD_SERVICES
        check_systemd_services
        return 0
    fi
    detect_venv
    mkdir -p "$LOG_DIR"
    if is_running; then
        log "INFO: 已在运行 (PID $(cat "$PID_FILE"))"
        return 0
    fi
    check_port_free

    log "启动 uvicorn → $LOG_FILE"
    cd "$APP_DIR"
    nohup "$VENV_DIR/bin/uvicorn" app.main:app \
        --host "$HOST" --port "$PORT" --workers "$WORKERS" \
        >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    disown 2>/dev/null || true

    sleep 2
    if ! is_running; then
        err "启动后立即退出，请查看日志："
        err "  tail -n 30 $LOG_FILE"
        rm -f "$PID_FILE"
        exit 1
    fi
    log "OK: 已启动 (PID $(cat "$PID_FILE"))"
    log "健康检查："
    if wait_for_port; then
        log "  curl http://127.0.0.1:${PORT}/health → $(curl -s http://127.0.0.1:${PORT}/health)"
    else
        warn "端口未在 15s 内响应，看日志：tail -f $LOG_FILE"
    fi
    log "实时日志：tail -f $LOG_FILE   |   停止：./start.sh stop"
}

cmd_stop() {
    if use_systemd; then
        log "使用 systemd 停止：${SYSTEMD_SERVICES}"
        systemctl stop $SYSTEMD_SERVICES
        cleanup_gugu_port
        return 0
    fi
    if ! is_running; then
        log "INFO: 未运行"
        rm -f "$PID_FILE"
        cleanup_gugu_port
        return 0
    fi
    local pid; pid="$(cat "$PID_FILE")"
    log "停止 PID $pid ..."
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
        sleep 1
        if ! kill -0 "$pid" 2>/dev/null; then
            rm -f "$PID_FILE"
            log "OK: 已停止"
            cleanup_gugu_port
            return 0
        fi
    done
    warn "进程未响应，强杀"
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    cleanup_gugu_port
}

cmd_restart() {
    if use_systemd; then
        validate_runtime_config
        log "使用 systemd 重启：${SYSTEMD_SERVICES}"
        systemctl stop $SYSTEMD_SERVICES
        cleanup_gugu_port
        systemctl start $SYSTEMD_SERVICES
        check_systemd_services
        return 0
    fi
    cmd_stop; sleep 1; cmd_start
}

cmd_cleanup_port() {
    # 供 gugu-backend.service 的 ExecStartPre 使用。此命令只做端口清理，
    # 不触发 systemd 提权，避免服务启动阶段尝试读取交互式 sudo 密码。
    cleanup_gugu_port
}

cmd_status() {
    if use_systemd; then
        systemctl --no-pager --lines=5 status $SYSTEMD_SERVICES
        return $?
    fi
    if is_running; then
        local pid; pid="$(cat "$PID_FILE")"
        log "运行中 (PID $pid)"
        log "端口 ${PORT} 监听情况："
        ss -tlnp 2>/dev/null | grep ":${PORT} " || warn "端口未监听"
        log "健康检查："
        if curl -sS "http://127.0.0.1:${PORT}/health"; then
            echo
        else
            warn "健康检查失败"
        fi
    else
        log "未运行"
        return 1
    fi
}

cmd_logs() { tail -f "$LOG_FILE"; }

cmd_foreground() {
    detect_venv
    cd "$APP_DIR"
    exec "$VENV_DIR/bin/uvicorn" app.main:app \
        --host "$HOST" --port "$PORT" --reload \
        --reload-dir "$APP_DIR/app" \
        --reload-dir "$APP_DIR/agent" \
        --reload-dir "$APP_DIR/onboarding" \
        --timeout-graceful-shutdown 1
}

cmd_install() {
    # 四个核心常驻服务：sandboxd、web(uvicorn)、IM worker、IM gateway(网关管家)。
    # TS RAG 不是独立服务，由 Python adapter 按需复用固定 worker 制品。
    local services="$SYSTEMD_SERVICES"
    # 必须显式指定服务运行用户，避免安装脚本擅自改变项目归属。
    local run_user="${RUN_USER:-}"
    if [ -z "$run_user" ]; then
        local suggested_user="${SUDO_USER:-$(id -un)}"
        if [ "$suggested_user" = "root" ] && [ -z "${SUDO_USER:-}" ]; then
            err "请显式指定非 root 服务运行用户，例如：RUN_USER=coffeiz ./start.sh install"
        else
            err "请显式指定服务运行用户，例如：RUN_USER=${suggested_user} ./start.sh install"
        fi
        exit 1
    fi

    for s in $services; do
        if [ ! -f "${APP_DIR}/${s}.service" ]; then
            err "未找到 ${APP_DIR}/${s}.service，请先把 systemd 单元放到 backend 目录"
            exit 1
        fi
    done
    if ! id "$run_user" >/dev/null 2>&1; then
        err "运行用户 '$run_user' 不存在；用 RUN_USER=xxx make install 指定一个已存在的用户"
        exit 1
    fi
    local run_uid
    run_uid="$(id -u "$run_user")"
    local data_dir
    data_dir="$(realpath -m "${APP_DIR}/../Gugu-data/users")"

    # ReadWritePaths 要求路径真实存在，否则 systemd 报 226/NAMESPACE
    log "准备可写目录并授权给 $run_user"
    mkdir -p "${APP_DIR}/../Gugu-data/users" "${APP_DIR}/logs" "${APP_DIR}/var/rag-index"
    # Admin 配置是运行数据，缺失通常意味着部署同步/清理误删。
    # 禁止安装流程静默创建空对象，否则会把“配置丢失”伪装成“Admin 设置被清空”。
    # 全新部署如确实需要空配置，必须显式传入 INIT_EMPTY_CONFIG=1。
    if [ ! -f "${APP_DIR}/config.override.json" ]; then
        if [ "${INIT_EMPTY_CONFIG:-0}" = "1" ]; then
            umask 077
            printf '{}\n' > "${APP_DIR}/config.override.json"
            log "已按 INIT_EMPTY_CONFIG=1 显式创建空 config.override.json"
        else
            err "缺少 ${APP_DIR}/config.override.json；为避免清空 Admin 设置，安装已停止。"
            err "请先从备份恢复，或确认全新部署后显式执行：INIT_EMPTY_CONFIG=1 RUN_USER=${run_user} make install"
            exit 1
        fi
    fi
    chmod 600 "${APP_DIR}/config.override.json"
    chown -R "$run_user":"$run_user" "${APP_DIR}/../Gugu-data/users" "${APP_DIR}/logs" "${APP_DIR}/var/rag-index" "${APP_DIR}/config.override.json"

    # 按实际安装目录 / 用户填占位符，生成四个核心单元
    for s in $services; do
        log "生成 systemd 单元 → /etc/systemd/system/${s}.service"
        sed -e "s#__APP_DIR__#${APP_DIR}#g" \
            -e "s#__RUN_USER__#${run_user}#g" \
            -e "s#__RUN_UID__#${run_uid}#g" \
            -e "s#__DATA_DIR__#${data_dir}#g" \
            "${APP_DIR}/${s}.service" > "/etc/systemd/system/${s}.service"
    done

    systemctl daemon-reload
    for s in $services; do systemctl enable "$s"; done
    log "启动服务 ..."
    for s in $services; do systemctl restart "$s"; done
    check_systemd_services
    log ""
    log "常用命令（sandboxd / web / IM 大脑 / IM 网关）："
    log "  systemctl status gugu-sandboxd gugu-backend gugu-worker gugu-gateway"
    log "  journalctl -u gugu-worker -f        # IM 大脑日志"
    log "  journalctl -u gugu-gateway -f    # IM 网关日志"
    log "  systemctl restart gugu-worker       # 改了 agent 代码后重启大脑"
    log "  systemctl restart gugu-gateway   # 改了网关/凭据后重启网关"
}

# ── 入口 ───────────────────────────────────────────────
if ! elevate_systemd_once "$@"; then
    exit 1
fi

case "${1:-start}" in
    start)         cmd_start ;;
    stop)          cmd_stop ;;
    restart)       cmd_restart ;;
    cleanup-port)  cmd_cleanup_port ;;
    status)        cmd_status ;;
    logs)          cmd_logs ;;
    foreground|fg) cmd_foreground ;;
    install)       cmd_install ;;
    *)
        cat <<EOF
用法: $0 <命令>

命令:
  start        后台启动（默认）
  stop         停止
  restart      重启
  cleanup-port 清理当前端口上属于本项目的旧 Uvicorn（供 systemd 启动前调用）
  status       查看状态 + 健康检查
  logs         实时跟踪日志（Ctrl+C 退出）
  foreground   前台启动（带 --reload，用于调试）
  install      安装为 systemd 服务（sandboxd + gugu-backend + worker + gateway）

环境变量:
  HOST=0.0.0.0           监听地址
  PORT=8000              监听端口
  WORKERS=1              uvicorn worker 数
  DB_STARTUP_TIMEOUT=5   DB 启动超时秒数（传给后端）
  INIT_EMPTY_CONFIG=1    仅全新部署时显式创建空 config.override.json

示例:
  ./start.sh start
  DB_STARTUP_TIMEOUT=10 ./start.sh restart
  ./start.sh status
EOF
        exit 1
        ;;
esac
