"""测试基座：内存 SQLite + 双用户 fixture（多用户隔离测试的地基）。

- 每个测试一个全新的内存库（StaticPool 保证同一条连接），建全表、测完即弃——
  测试之间零污染，不碰任何真实数据/外部服务。
- `user_a` / `user_b` 是两个独立用户：越权测试的标准姿势是「B 拥有资源，A 拿着
  B 的资源 id 调工具，必须得到『不存在』而非数据」。
- 模型列类型全部方言无关（Uuid/JSON/Text…），SQLite 可直接建表；若未来引入
  JSONB/ARRAY 等 PG 专属类型，这里会在 create_all 时立刻报错——那时再迁真 PG。
- `db` fixture 顺带把 `app.db.session._engine/_SessionLocal` 接到同一个内存库：
  后台任务（fire-and-forget）自己开
  `_sess._SessionLocal()` 新 session，不这样接的话会摸到未初始化/真实配置的引擎。
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from types import SimpleNamespace
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.pool import StaticPool
from uuid6 import uuid7

import app.core.redis as _redis
import app.db.session as _sess
from app.db.base import Base
from app.models import User


@pytest_asyncio.fixture(autouse=True)
async def _reset_redis_client():
    """每个测试结束后重置全局 Redis 客户端单例。

    ``app.core.redis.get_redis()`` 懒加载缓存一个模块级客户端，一旦在某个
    测试里被真正用到（不是靠 monkeypatch 绕过的），底层连接就绑死在那个
    测试的事件循环上。pytest-asyncio 默认每个测试函数一个新事件循环，下一个
    测试如果也真的调用 get_redis()，复用到的是上一个已关闭循环上的连接，
    报 "Future attached to a different loop"。测试之间彼此不感知，只在特定
    组合顺序下才触发，表现为跟顺序有关的 flaky。这里在每个测试后主动清空，
    保证下个测试首次调用 get_redis() 时懒加载出一个绑在自己事件循环上的新连接。
    """
    yield
    await _redis.reset()


@pytest.fixture(autouse=True)
def _isolate_local_configuration(monkeypatch, tmp_path):
    """测试不得读取工作区里的部署 override；需要配置的用例自行替换路径。"""
    import app.core.config as _config
    monkeypatch.setattr(_config, "OVERRIDE_FILE", tmp_path / "no-config.override.json")
    _config.invalidate_settings_cache()
    yield
    _config.invalidate_settings_cache()


@pytest_asyncio.fixture
async def db(monkeypatch):
    # 测试库不应读取本地生产 override：UserBot 的加密字段只需要稳定的测试密钥，
    # 否则写入 UserBot 会在配置校验阶段依赖真实 db.password，导致内存库测试被部署配置阻断。
    import app.core.crypto as _crypto
    monkeypatch.setattr(
        _crypto,
        "get_settings",
        lambda: SimpleNamespace(secret_key="test-only-encryption-key"),
    )
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
    # ensure_engine() 有一个跨事件循环检测（见 app/db/session.py）：当前运行的
    # loop 跟"引擎创建时绑定的 loop"（_engine_loop）不一致就重建引擎——如果这里
    # 不同步更新 _engine_loop，pytest-asyncio 给每个测试函数分配不同事件循环时，
    # ensure_engine() 会误判成"引擎该重建了"，绕过我们刚 monkeypatch 上的测试库，
    # 悄悄连回真实生产数据库（这个坑真实踩过一次：某个不带 db fixture 的调用链路
    # 触发过一次真实 UndefinedTableError）。
    import asyncio as _asyncio
    monkeypatch.setattr(_sess, "_engine_loop", _asyncio.get_running_loop())
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
