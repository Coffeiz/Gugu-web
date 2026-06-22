from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from typing import AsyncGenerator
from app.core.config import get_settings

_engine = None
_SessionLocal = None


def _build_engine():
    global _engine, _SessionLocal
    settings = get_settings()
    _engine = create_async_engine(settings.db.url, echo=settings.debug, pool_pre_ping=True)
    _SessionLocal = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)


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
