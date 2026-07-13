import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from jose import jwt, JWTError
from fastapi import HTTPException
from pathlib import Path

from app.core.config import get_settings
from app.core.logging import setup_logging, flush_log_queue
from app.api.v1 import config as config_router
from app.api.v1 import admin_auth
from app.api.v1 import auth as user_auth
from app.api.v1 import projects as projects_router
from app.api.v1 import files as files_router
from app.api.v1 import folders as folders_router
from app.api.v1 import events as events_router
from app.api.v1 import live as live_router
from app.api.v1 import clients as clients_router
from app.api.v1 import trash as trash_router
from app.api.v1 import agent as agent_router
from app.api.v1 import search as search_router
from app.api.v1 import mind as mind_router
from app.api.v1 import user_bots as user_bots_router
from app.api.v1 import services_admin as services_admin_router
from app.api.v1 import qq_connect as qq_connect_router
from app.api.v1 import feishu_connect as feishu_connect_router
from app.api.v1 import wechat_connect as wechat_connect_router
from app.api.v1 import preferences as preferences_router
from app.api.v1 import scheduled_tasks as scheduled_tasks_router
from app.api.v1 import agent_admin as agent_admin_router
from app.api.v1 import agent_perception as agent_perception_router
from app.api.v1 import invite_codes as invite_codes_router
from app.api.v1 import audit_log as audit_log_router
from app.api.v1 import system_logs as system_logs_router
from app.api.v1 import users_admin as users_admin_router
from app.api.v1 import admin_debug as admin_debug_router
from app.api.v1 import admin_analytics as admin_analytics_router
from app.api.v1 import ops_admin as ops_admin_router
from app.api.v1 import notifications_admin as notifications_admin_router
from app.api.v1 import notifications as notifications_router
from app.api.v1 import track as track_router
from app.api.v1 import feedback as feedback_router
from onboarding.routes import router as onboarding_router   # 独立子系统（backend/onboarding/）
from app.db.session import create_all_tables

import logging
logger = logging.getLogger(__name__)

setup_logging()

settings = get_settings()
bearer = HTTPBearer()


_THUMB_TTL_DAYS = 30
_last_thumb_cleanup: float = 0.0


def _evict_old_thumbs() -> int:
    """删除超过 TTL 天未被访问的缩略图（同步，在线程中调用）。"""
    import time
    from app.api.v1.files import _thumb_dir
    td = _thumb_dir()
    if not td.exists():
        return 0
    cutoff = time.time() - _THUMB_TTL_DAYS * 86400
    count = 0
    for p in td.iterdir():
        if p.suffix in (".webp", ".jpg"):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink(missing_ok=True)
                    count += 1
            except Exception:
                pass
    return count


async def _auto_cleanup_loop():
    """每小时检查并永久删除超过 30 天的回收站文件；每 24 小时驱逐冷缩略图。"""
    import time
    global _last_thumb_cleanup
    while True:
        await asyncio.sleep(3600)
        # 回收站清理
        try:
            from app.db.session import _SessionLocal
            from app.api.v1.trash import cleanup_expired
            if _SessionLocal is None:
                continue
            async with _SessionLocal() as db:
                n = await cleanup_expired(db)
                if n:
                    logger.info("回收站自动清理 %d 个过期文件", n)
        except Exception as e:
            logger.error("回收站自动清理出错: %s", e, exc_info=True)
        # 缩略图 TTL 驱逐（每 24 小时一次）
        if time.time() - _last_thumb_cleanup > 86400:
            try:
                n = await asyncio.to_thread(_evict_old_thumbs)
                if n:
                    logger.info("缩略图 TTL 驱逐 %d 个冷缓存", n)
                _last_thumb_cleanup = time.time()
            except Exception as e:
                logger.error("缩略图 TTL 驱逐出错: %s", e, exc_info=True)


async def _db_retry_loop():
    """后台重试连 DB，连上后建表（一次性）。

    启动时若数据库不可达，lifespan 会跳过建表。
    此循环每 30 秒重试一次，连上就建表后退出。
    这样 Admin 后台改完 DB 配置保存后，无需重启即可生效。
    """
    while True:
        await asyncio.sleep(30)
        try:
            await create_all_tables()
            logger.info("数据库后台重连成功，表已建")
            return
        except Exception as e:
            logger.debug("DB重试尚未连通：%s: %s", type(e).__name__, e)


# 数据库启动超时（秒）：超时后跳过建表，后台继续重试
# 通过环境变量 DB_STARTUP_TIMEOUT 可覆盖，例如：DB_STARTUP_TIMEOUT=10 ./start.sh start
DB_STARTUP_TIMEOUT = int(os.getenv("DB_STARTUP_TIMEOUT", "5"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await asyncio.wait_for(create_all_tables(), timeout=DB_STARTUP_TIMEOUT)
        logger.info("数据库表已就绪")
    except asyncio.TimeoutError:
        logger.warning("数据库 %ds 内未连通，已跳过建表（Admin 仍可用）", DB_STARTUP_TIMEOUT)
    except Exception as e:
        logger.warning("数据库连接失败，跳过建表：%s", e)
    Path(settings.storage.local_path).mkdir(parents=True, exist_ok=True)
    try:
        from app.api.v1.files import _thumb_dir
        td = _thumb_dir()
        if td.exists():
            old = list(td.glob("*.jpg"))
            for p in old:
                p.unlink(missing_ok=True)
            if old:
                logger.info("已清理 %d 个旧 JPEG 缩略图缓存", len(old))
    except Exception:
        pass
    task       = asyncio.create_task(_auto_cleanup_loop())
    retry_task = asyncio.create_task(_db_retry_loop())
    log_task   = asyncio.create_task(flush_log_queue())
    yield
    task.cancel()
    retry_task.cancel()
    log_task.cancel()


app = FastAPI(title=settings.app_name, debug=settings.debug, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://test.gugugu.site",   # ← 加这一行
    "http://test.gugugu.site",
    "https://www.gugugu.site",    # ← 如果还没上 HTTPS 也加上
],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    """基础安全响应头。CSP 未加（Vue 内联样式/脚本易误伤，需单独调），先补低风险的几项。"""
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    # HSTS：仅 HTTPS 下浏览器生效，纯 HTTP 部署忽略之，带着无副作用
    resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return resp


def require_admin(request: Request, credentials: HTTPAuthorizationCredentials = Depends(bearer)):
    try:
        payload = jwt.decode(credentials.credentials, settings.secret_key, algorithms=["HS256"])
        if payload.get("role") not in ("superadmin", "admin"):
            raise HTTPException(status_code=403, detail="权限不足")
        # 审计归因：把真实管理员用户名落到 request.state，供 write_log 读取（否则多管理员时恒记字面量 "admin"）
        request.state.admin_username = payload.get("sub") or "admin"
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Token 无效或已过期")


# ── 公开路由（无需 token）──
app.include_router(admin_auth.router,   prefix="/api/v1")
app.include_router(user_auth.router,    prefix="/api/v1")

# ── 用户数据路由（需要用户 token，路由内部 Depends(get_current_user)）──
app.include_router(projects_router.router, prefix="/api/v1")
app.include_router(files_router.router,    prefix="/api/v1")
app.include_router(folders_router.router,  prefix="/api/v1")
app.include_router(events_router.router,   prefix="/api/v1")
app.include_router(live_router.router,      prefix="/api/v1")
app.include_router(clients_router.router,  prefix="/api/v1")
app.include_router(trash_router.router,       prefix="/api/v1")
app.include_router(agent_router.router,       prefix="/api/v1")
app.include_router(search_router.router,      prefix="/api/v1")
app.include_router(mind_router.router,        prefix="/api/v1")
app.include_router(track_router.router,       prefix="/api/v1")
app.include_router(preferences_router.router, prefix="/api/v1")
app.include_router(scheduled_tasks_router.router, prefix="/api/v1")
app.include_router(feedback_router.router,    prefix="/api/v1")
# 飞书 OAuth 扫码绑定：bind/url + status + unbind 需用户登录；callback 是飞书重定向（靠 state 校验）
app.include_router(user_bots_router.router,      prefix="/api/v1")
app.include_router(qq_connect_router.router,     prefix="/api/v1")
app.include_router(feishu_connect_router.router, prefix="/api/v1")
app.include_router(wechat_connect_router.router, prefix="/api/v1")
app.include_router(onboarding_router,            prefix="/api/v1")   # 新手引导（用户鉴权，作用于自己）

# ── Admin 路由（需要 Admin token）──
app.include_router(
    config_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    agent_admin_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    agent_perception_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    invite_codes_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    audit_log_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    system_logs_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    users_admin_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    services_admin_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    admin_debug_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    admin_analytics_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    ops_admin_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    feedback_router.admin_router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(
    notifications_admin_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
app.include_router(notifications_router.router, prefix="/api/v1")


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    errors = exc.errors()
    msg = "；".join(
        e.get("msg", "参数错误").replace("Value error, ", "")
        for e in errors
    )
    return JSONResponse(status_code=422, content={"detail": msg})


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    logger.exception("%s %s → %s", request.method, request.url.path, exc)
    return JSONResponse(status_code=500, content={"detail": "服务器内部错误，请稍后重试"})


@app.get("/health")
async def health():
    return {"status": "ok", "app": settings.app_name}
