"""测试基座：内存 SQLite + 双用户 fixture（多用户隔离测试的地基）。

- 每个测试一个全新的内存库（StaticPool 保证同一条连接），建全表、测完即弃——
  测试之间零污染，不碰任何真实数据/外部服务。
- `user_a` / `user_b` 是两个独立用户：越权测试的标准姿势是「B 拥有资源，A 拿着
  B 的资源 id 调工具，必须得到『不存在』而非数据」。
- 模型列类型全部方言无关（Uuid/JSON/Text…），SQLite 可直接建表；若未来引入
  JSONB/ARRAY 等 PG 专属类型，这里会在 create_all 时立刻报错——那时再迁真 PG。
- `db` fixture 顺带把 `app.db.session._engine/_SessionLocal` 接到同一个内存库：
  后台任务（fire-and-forget，比如 _apply_context_config_bg 那类）自己开
  `_sess._SessionLocal()` 新 session，不这样接的话会摸到未初始化/真实配置的引擎。
"""
from __future__ import annotations

import pytest_asyncio
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.pool import StaticPool
from uuid6 import uuid7

import app.db.session as _sess
from app.db.base import Base
from app.models import User


@pytest_asyncio.fixture
async def db(monkeypatch):
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,                    # 内存库靠同一条连接共享
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(_sess, "_engine", engine)
    monkeypatch.setattr(_sess, "_SessionLocal", Session)
    async with Session() as session:
        yield session
    await engine.dispose()


async def _mk_user(db, name: str) -> User:
    u = User(id=uuid7(), username=name, email=f"{name}@test.local", hashed_password="x")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


@pytest_asyncio.fixture
async def user_a(db) -> User:
    return await _mk_user(db, "alice")


@pytest_asyncio.fixture
async def user_b(db) -> User:
    return await _mk_user(db, "bob")
