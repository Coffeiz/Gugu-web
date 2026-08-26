#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# dev 机后端重启（「手动当唯一主人」方案 B：免 sudo、不走 systemd）。
#
# 干净重启 web / worker / supervisor：先停旧 + **抢占式腾端口 8000**，再起新，
# 不用每次手动 pkill、也不会和别的实例抢端口报「address already in use」。
#
#   ⚠️ 前提：systemd 的 gugu-backend 必须 disabled/stopped（dev 机只一个主人）。
#       若它在跑，先 `sudo systemctl disable --now gugu-backend`，否则又会抢 8000。
#
# 用法（在 dev 机上跑）：
#   bash scripts/dev-restart.sh            # 重启全部（web + worker + supervisor）
#   bash scripts/dev-restart.sh web        # 只重启 web
#   bash scripts/dev-restart.sh worker
#   bash scripts/dev-restart.sh supervisor
#
#   TypeScript Live 由 gugu-live.service 管理，不由这个 Python 开发脚本启动。
# ─────────────────────────────────────────────────────────────────────────────
set -u
WHAT="${1:-all}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BK="$HERE/backend"
PY="$BK/.venv/bin/python3"
UV="$BK/.venv/bin/uvicorn"
PORT=8000
cd "$BK" || { echo "找不到 backend 目录: $BK"; exit 1; }
mkdir -p logs

start_web() {
  echo "[web] 停旧 + 腾端口 $PORT …"
  pkill -9 -f "uvicorn app.main" 2>/dev/null
  /usr/bin/fuser -k "$PORT/tcp" 2>/dev/null
  sleep 2
  echo "[web] 启动 …"
  nohup setsid LOOPSCOPE_ENABLED=1 "$PY" "$UV" app.main:app --host 0.0.0.0 --port "$PORT" --workers 1 \
        >> logs/gugu-web-dev.log 2>&1 < /dev/null &
  disown 2>/dev/null || true
  sleep 6
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://127.0.0.1:$PORT/health" 2>/dev/null)
  echo "[web] HTTP ${code:-000}（200 = 起来了）"
}

start_worker() {
  echo "[worker] 停旧 + 启动 …"
  pkill -9 -f "python -m worker" 2>/dev/null
  sleep 1
  nohup setsid LOOPSCOPE_ENABLED=1 "$PY" -m worker >> logs/gugu-worker-dev.log 2>&1 < /dev/null &
  disown 2>/dev/null || true
  sleep 4
  grep -q "\[worker\] started" <(tail -5 logs/gugu-worker-dev.log 2>/dev/null) && echo "[worker] up" \
    || { pgrep -f "python -m worker" >/dev/null && echo "[worker] up（起来了）" || echo "[worker] 没起来，看 logs/gugu-worker-dev.log"; }
}

start_supervisor() {
  echo "[supervisor] 停旧（含 qq/feishu/wechat 网关）+ 启动 …"
  pkill -9 -f "agent.adapters.supervisor|agent.adapters.feishu|agent.adapters.qq|agent.adapters.wechat" 2>/dev/null
  sleep 1
  nohup setsid LOOPSCOPE_ENABLED=1 "$PY" -m agent.adapters.supervisor >> logs/gugu-supervisor-dev.log 2>&1 < /dev/null &
  disown 2>/dev/null || true
  sleep 3
  grep -qE "网关就绪|网关启动" logs/gugu-supervisor-dev.log 2>/dev/null && echo "[supervisor] 网关已起" || echo "[supervisor] 启动中（看 logs/gugu-supervisor-dev.log）"
}

case "$WHAT" in
  web)        start_web ;;
  worker)     start_worker ;;
  supervisor) start_supervisor ;;
  all)        start_web; start_worker; start_supervisor ;;
  *) echo "用法: bash scripts/dev-restart.sh [web|worker|supervisor|all]"; exit 1 ;;
esac
echo "✅ 完成（$WHAT）"
