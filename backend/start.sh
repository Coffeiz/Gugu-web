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
SYSTEMD_SERVICES="gugu-backend gugu-worker gugu-supervisor"

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

# ── 子命令 ──────────────────────────────────────────────
cmd_start() {
    if use_systemd; then
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
        return 0
    fi
    if ! is_running; then
        log "INFO: 未运行"
        rm -f "$PID_FILE"
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
            return 0
        fi
    done
    warn "进程未响应，强杀"
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
}

cmd_restart() {
    if use_systemd; then
        log "使用 systemd 重启：${SYSTEMD_SERVICES}"
        systemctl restart $SYSTEMD_SERVICES
        check_systemd_services
        return 0
    fi
    cmd_stop; sleep 1; cmd_start
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
    # 三个常驻服务：web(uvicorn)、IM worker、IM supervisor(网关管家)
    local services="gugu-backend gugu-worker gugu-supervisor"
    # 运行该服务的用户，可用 RUN_USER 覆盖（默认 www-data，勿用 root）
    local run_user="${RUN_USER:-www-data}"

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

    # ReadWritePaths 要求路径真实存在，否则 systemd 报 226/NAMESPACE
    log "准备可写目录并授权给 $run_user"
    mkdir -p "${APP_DIR}/uploads" "${APP_DIR}/../Gugu-data/users" "${APP_DIR}/logs" "${APP_DIR}/var/rag-index"
    if [ ! -f "${APP_DIR}/config.override.json" ]; then
        umask 077
        printf '{}\n' > "${APP_DIR}/config.override.json"
    fi
    chmod 600 "${APP_DIR}/config.override.json"
    chown -R "$run_user":"$run_user" "${APP_DIR}/uploads" "${APP_DIR}/../Gugu-data/users" "${APP_DIR}/logs" "${APP_DIR}/var/rag-index" "${APP_DIR}/config.override.json"

    # 按实际安装目录 / 用户填占位符，生成三个单元
    for s in $services; do
        log "生成 systemd 单元 → /etc/systemd/system/${s}.service"
        sed -e "s#__APP_DIR__#${APP_DIR}#g" \
            -e "s#__RUN_USER__#${run_user}#g" \
            "${APP_DIR}/${s}.service" > "/etc/systemd/system/${s}.service"
    done

    systemctl daemon-reload
    for s in $services; do systemctl enable "$s"; done
    log "启动服务 ..."
    for s in $services; do systemctl restart "$s"; done
    check_systemd_services
    log ""
    log "常用命令（web / IM 大脑 / IM 网关）："
    log "  systemctl status gugu-backend gugu-worker gugu-supervisor"
    log "  journalctl -u gugu-worker -f        # IM 大脑日志"
    log "  journalctl -u gugu-supervisor -f    # IM 网关日志"
    log "  systemctl restart gugu-worker       # 改了 agent 代码后重启大脑"
    log "  systemctl restart gugu-supervisor   # 改了网关/凭据后重启网关"
}

# ── 入口 ───────────────────────────────────────────────
case "${1:-start}" in
    start)         cmd_start ;;
    stop)          cmd_stop ;;
    restart)       cmd_restart ;;
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
  status       查看状态 + 健康检查
  logs         实时跟踪日志（Ctrl+C 退出）
  foreground   前台启动（带 --reload，用于调试）
  install      安装为 systemd 服务（gugu-backend.service）

环境变量:
  HOST=0.0.0.0           监听地址
  PORT=8000              监听端口
  WORKERS=1              uvicorn worker 数
  DB_STARTUP_TIMEOUT=5   DB 启动超时秒数（传给后端）

示例:
  ./start.sh start
  DB_STARTUP_TIMEOUT=10 ./start.sh restart
  ./start.sh status
EOF
        exit 1
        ;;
esac
