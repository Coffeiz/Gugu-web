#!/usr/bin/env bash
# ============================================================
#  Gugu 一键部署脚本（不用 git，适合 scp/rsync 直接传文件）
#  用法: ./deploy.sh [--no-build]
#
#  流程:
#    1. 校验环境（venv、磁盘空间）
#    2. 备份关键数据（config.override.json、Gugu-data/users/）
#    3. 同步 Python 依赖（pip install -r requirements.txt）
#    4. 跑数据库迁移（alembic upgrade head，DB 不通则跳过）
#    5. 可选：构建前端（--no-build 跳过）
#    6. 重启后端服务（./start.sh restart）
#    7. 健康检查
#
#  上传新代码后在服务器上跑：
#    scp -r ./backend root@server:/opt/.../sites/...
#    ssh root@server 'cd /opt/.../backend && ./deploy.sh'
# ============================================================
set -euo pipefail

# ── 配置 ─────────────────────────────────────────────────
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$APP_DIR/.." && pwd)"
FRONTEND_DIR="${PROJECT_ROOT}/frontend"
BACKUP_DIR="${APP_DIR}/.deploy-backups"
TS="$(date +%Y%m%d-%H%M%S)"

DO_BUILD=true
HEALTH_TIMEOUT=30

# ── 工具 ─────────────────────────────────────────────────
log()  { printf '\033[36m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*"; }
ok()   { printf '\033[32m[OK] %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[WARN] %s\033[0m\n' "$*"; }
err()  { printf '\033[31m[ERROR] %s\033[0m\n' "$*" >&2; }
hr()   { printf '\n\033[90m%s\033[0m\n' "────────────────────────────────────────────"; }

usage() {
    cat <<EOF
用法: $0 [选项]

选项:
  --no-build       跳过前端 build
  --help           显示帮助

示例:
  ./deploy.sh              # 全量部署（备份 + 依赖 + 迁移 + 前端 build + 重启）
  ./deploy.sh --no-build   # 不重建前端（只更后端）
EOF
}

# ── 参数解析 ─────────────────────────────────────────────
while [ $# -gt 0 ]; do
    case "$1" in
        --no-build) DO_BUILD=false; shift ;;
        --help|-h)  usage; exit 0 ;;
        *) err "未知参数: $1"; usage; exit 1 ;;
    esac
done

# ── 1. 环境校验 ──────────────────────────────────────────
hr; log "步骤 1/6 — 环境校验"

cd "$APP_DIR"
if [ ! -d ".venv" ] && [ ! -d "venv" ]; then
    err "未找到 venv，请先创建：python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
    exit 1
fi
VENV_BIN=".venv/bin"
[ -d "venv" ] && VENV_BIN="venv/bin"

# 磁盘空间（至少 500MB）
FREE_MB=$(df -m "$APP_DIR" | awk 'NR==2 {print $4}')
if [ "${FREE_MB:-0}" -lt 500 ]; then
    warn "磁盘剩余空间仅 ${FREE_MB}MB，可能不足"
else
    ok "磁盘剩余 ${FREE_MB}MB"
fi

# ── 2. 备份 ──────────────────────────────────────────────
hr; log "步骤 2/6 — 备份关键数据"
mkdir -p "$BACKUP_DIR"

backup_if_exists() {
    local src="$1" name="$2"
    if [ -e "$src" ]; then
        tar -czf "${BACKUP_DIR}/${name}-${TS}.tar.gz" -C "$(dirname "$src")" "$(basename "$src")" 2>/dev/null \
            && ok "备份 $name → ${BACKUP_DIR}/${name}-${TS}.tar.gz" \
            || warn "备份 $name 失败"
    fi
}

backup_if_exists "config.override.json" "config-override"
backup_if_exists "../Gugu-data/users"  "users"

# 只保留最近 10 个备份
ls -t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
ok "历史备份目录：$BACKUP_DIR（共 $(ls "$BACKUP_DIR" 2>/dev/null | wc -l) 个文件）"

# ── 3. 安装依赖 ──────────────────────────────────────────
hr; log "步骤 3/6 — 同步 Python 依赖"
cd "$APP_DIR"
"$VENV_BIN/pip" install --upgrade pip -q
"$VENV_BIN/pip" install -r requirements.txt -q
ok "依赖已同步"

# ── 4. 数据库迁移 ────────────────────────────────────────
hr; log "步骤 4/6 — 跑数据库迁移"

# DB 还没连上时跳过迁移（5 秒快速尝试）
if DB_STARTUP_TIMEOUT=3 "$VENV_BIN/python" -c "
import asyncio
from app.db.session import _build_engine
from sqlalchemy import text
async def t():
    _build_engine()
    from app.db.session import _engine
    async with _engine.begin() as c:
        await c.execute(text('SELECT 1'))
asyncio.run(asyncio.wait_for(t(), timeout=3))
" 2>/dev/null; then
    "$VENV_BIN/alembic" upgrade head
    ok "迁移完成"
else
    warn "数据库暂不可达（3s 超时），跳过迁移。服务起来后用 admin 后台配 DB，重启再跑迁移。"
fi

# ── 5. 构建前端（可选） ──────────────────────────────────
hr; log "步骤 5/6 — 前端构建"
if $DO_BUILD; then
    if [ -d "$FRONTEND_DIR" ]; then
        cd "$FRONTEND_DIR"
        if command -v npm >/dev/null 2>&1; then
            log "npm ci ..."
            npm ci --no-audit --no-fund
            log "npm run build ..."
            npm run build
            ok "前端已构建 → $FRONTEND_DIR/dist/"
        else
            warn "未找到 npm，跳过前端构建（手动构建后部署）"
        fi
    else
        warn "前端目录不存在：$FRONTEND_DIR，跳过"
    fi
else
    log "已跳过前端构建"
fi

# ── 6. 重启服务 + 健康检查 ───────────────────────────────
hr; log "步骤 6/6 — 重启后端"

cd "$APP_DIR"
if [ ! -x "./start.sh" ]; then
    chmod +x ./start.sh
fi

# 用 start.sh 自带的 restart
./start.sh restart

# 健康检查
log "等待健康检查（最多 ${HEALTH_TIMEOUT}s）..."
for _ in $(seq 1 $HEALTH_TIMEOUT); do
    if curl -sf "http://127.0.0.1:8000/health" >/dev/null 2>&1; then
        ok "健康检查通过：$(curl -s http://127.0.0.1:8000/health)"
        break
    fi
    sleep 1
done

if ! curl -sf "http://127.0.0.1:8000/health" >/dev/null 2>&1; then
    err "健康检查失败，查看日志："
    err "  ./start.sh logs"
    exit 1
fi

hr
ok "部署完成 ✨"
echo ""
echo "后续："
echo "  ./start.sh status        # 状态"
echo "  ./start.sh logs          # 实时日志"
echo "  ls $BACKUP_DIR           # 查看历史备份"
