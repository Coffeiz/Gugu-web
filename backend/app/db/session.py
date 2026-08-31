import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from typing import AsyncGenerator
from app.core.config import get_settings

_engine = None
_SessionLocal = None
_engine_loop = None   # 引擎创建时绑定的事件循环，见 ensure_engine() 的跨循环检测
_MIGRATION_LOCK_KEY = 834271


def _current_loop():
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def _build_engine():
    global _engine, _SessionLocal, _engine_loop
    if _engine is not None and _SessionLocal is not None:
        return
    settings = get_settings()
    _engine = create_async_engine(
        settings.db.url,
        echo=settings.debug,
        pool_pre_ping=True,
        pool_size=15,       # 稳定保持连接数
        max_overflow=25,    # 峰值最多 40/进程；web+worker ≤ 80，留 20 给 pgAdmin
        pool_timeout=10,
        pool_recycle=1800,
    )
    _SessionLocal = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)
    _engine_loop = _current_loop()


def ensure_engine():
    """确保当前进程只初始化一次数据库引擎和连接池。

    附带一次跨事件循环检测：正常情况下（FastAPI/worker 常驻单一 loop）这里永远
    命中缓存、代价为零。但少数调用方会各自开一次性的新循环（比如脚本/测试反复
    `asyncio.run()`，或独立线程里 `asyncio.run()` 一次性任务）——如果当前运行的
    loop 跟引擎创建时绑定的 loop 不是同一个，池里缓存的 asyncpg 连接是绑在旧
    （可能已经关闭的）loop 上的，直接复用会报 "Event loop is closed"/"attached to
    a different loop"。这种情况下会先安排旧连接池 dispose，再重建一个绑定当前
    loop 的引擎，避免把仍持有连接的旧池直接交给垃圾回收。"""
    global _engine, _SessionLocal, _engine_loop
    current = _current_loop()
    if _engine is not None and current is not None and _engine_loop is not None and current is not _engine_loop:
        old_engine = _engine
        _engine = None
        _SessionLocal = None
        _engine_loop = None
        _schedule_dispose(old_engine)
    if _engine is None or _SessionLocal is None:
        _build_engine()
    return _engine


def reset_engine():
    """配置更新后调用，重建数据库连接池（无需重启服务）"""
    global _engine, _SessionLocal, _engine_loop
    old_engine = _engine
    _engine = None
    _SessionLocal = None
    _engine_loop = None
    if old_engine is not None:
        _schedule_dispose(old_engine)


async def dispose_engine() -> None:
    """在进程/事件循环关闭前显式释放共享连接池。"""
    global _engine, _SessionLocal, _engine_loop
    old_engine = _engine
    _engine = None
    _SessionLocal = None
    _engine_loop = None
    if old_engine is not None:
        await old_engine.dispose()


def _schedule_dispose(engine) -> None:
    """安排旧连接池关闭，避免把仍持有连接的 engine 直接交给 GC。"""
    async def _dispose() -> None:
        try:
            await engine.dispose()
        except Exception:
            # 重建连接池不能被旧池的清理异常阻断；SQLAlchemy 会继续负责
            # 当前池的正常生命周期，旧池只需尽力关闭即可。
            pass

    loop = _current_loop()
    if loop is not None and loop.is_running():
        loop.create_task(_dispose())
        return
    try:
        asyncio.run(_dispose())
    except RuntimeError:
        # 没有可用事件循环时无法异步关闭；常驻服务路径都会进入上面的
        # create_task 分支，进程退出时由连接池/数据库连接负责最终清理。
        pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    ensure_engine()
    async with _SessionLocal() as session:
        yield session


_MIGRATIONS = [
    "ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL",
    "ALTER TABLE files ADD COLUMN IF NOT EXISTS img_width INTEGER NULL",
    "ALTER TABLE files ADD COLUMN IF NOT EXISTS img_height INTEGER NULL",
    "ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS content_json JSONB NULL",
    "ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS references_json JSONB NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS search_limit_daily INTEGER NULL",
    "ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS workspace_id INTEGER NULL",
    "CREATE INDEX IF NOT EXISTS ix_conversation_sessions_workspace_id ON conversation_sessions (workspace_id)",
    "CREATE INDEX IF NOT EXISTS ix_knowledge_index_owner_source_time ON knowledge_index_entries (owner_user_id, source_type, indexed_at)",
    # 修复历史数据：_move_one 曾未同步 project_id，导致 file.project_id 与 folder.project_id 不一致
    """UPDATE files SET project_id = folders.project_id
       FROM folders
       WHERE files.folder_id = folders.id
         AND folders.project_id IS NOT NULL
         AND files.project_id IS DISTINCT FROM folders.project_id""",
]


async def create_all_tables():
    if _engine is None:
        _build_engine()
    from app.db.base import Base
    import app.models  # noqa: F401 — 导入模型让 Base 发现所有 table
    async with _engine.begin() as conn:
        # Web 多 worker、worker 进程和 Admin 初始化入口都可能同时触发这里。
        # DDL 会锁表，不能让并发初始化无限等待业务查询；只允许一个初始化者，
        # 其他调用直接跳过，下一次启动/重试再检查即可。
        await conn.execute(text("SET LOCAL lock_timeout = '3s'"))
        await conn.execute(text("SET LOCAL statement_timeout = '15s'"))
        locked = (await conn.execute(
            text("SELECT pg_try_advisory_xact_lock(:key)"),
            {"key": _MIGRATION_LOCK_KEY},
        )).scalar()
        if not locked:
            return
        await conn.run_sync(Base.metadata.create_all)
        for sql in _MIGRATIONS:
            await conn.execute(text(sql))
