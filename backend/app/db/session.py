from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from typing import AsyncGenerator
from app.core.config import get_settings

_engine = None
_SessionLocal = None


def _build_engine():
    global _engine, _SessionLocal
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


def ensure_engine():
    """确保当前进程只初始化一次数据库引擎和连接池。"""
    if _engine is None or _SessionLocal is None:
        _build_engine()
    return _engine


def reset_engine():
    """配置更新后调用，重建数据库连接池（无需重启服务）"""
    global _engine, _SessionLocal
    _engine = None
    _SessionLocal = None


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    if _engine is None:
        _build_engine()
    async with _SessionLocal() as session:
        yield session


_MIGRATIONS = [
    "ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL",
    "ALTER TABLE files ADD COLUMN IF NOT EXISTS img_width INTEGER NULL",
    "ALTER TABLE files ADD COLUMN IF NOT EXISTS img_height INTEGER NULL",
    "ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS content_json JSONB NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS search_limit_daily INTEGER NULL",
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
        await conn.run_sync(Base.metadata.create_all)
        for sql in _MIGRATIONS:
            await conn.execute(text(sql))
