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

import os

import pytest
import pytest_asyncio
from types import SimpleNamespace
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.pool import StaticPool
from uuid6 import uuid7
from pathlib import Path
import re

import app.core.redis as _redis
import app.db.session as _sess
from app.db.base import Base
from app.models import User


def pytest_collection_modifyitems(items):
    """根据测试源码的运行时边界补 marker，保持快速门禁可重复。"""
    process_pattern = re.compile(r"docker|systemd|pty|process|terminal_stream|subprocess|shell_sandbox", re.I)
    external_pattern = re.compile(r"redis|postgres|websocket|real[_ -]?llm|third[- ]?party|httpx|oss|searxng", re.I)
    for item in items:
        source = Path(str(item.fspath)).read_text(encoding="utf-8")
        if process_pattern.search(source):
            item.add_marker("process")
        if external_pattern.search(source):
            item.add_marker("external_service")
        if item.get_closest_marker("process") or item.get_closest_marker("external_service"):
            item.add_marker("slow")


@pytest.fixture(autouse=True)
def _hermetic_redis(monkeypatch):
    """测试默认使用进程内假 Redis；除非显式要求，绝不连真实 Redis。

    只替换 ``_client`` / ``_sync_client`` 这两个模块级单例（而不是各处的
    ``get_redis`` 名字）：懒加载函数读的就是这两个全局，所以不论调用方是
    ``from app.core.redis import get_redis`` 还是 ``R.get_redis()``，拿到的都是
    这个假客户端。async 与 sync 共用一份 FakeServer，语义等同「同一个 Redis」。

    不隔离会出两类问题（都真实发生过）：
    1. 配置来自开发者本机 ``.env`` / ``config.override.json``，本机跑测试会连上
       共享开发机的 Redis——两个 pytest 进程（或测试与本地服务）抢同一把
       ``scheduled:lock:<task_id>``，后到的直接返回「任务正在执行」，
       表现为与顺序/时序相关的假失败；测试库里 task id 是小整数，撞上共享环境
       里的真实任务时还会替真实任务抢锁。
    2. 授权、``im:seen``、租约等键写进共享 Redis 后跨测试残留：同 user + 同摘要的
       「缺 confirm 必拒」用例会因授权命中被放行。

    需要真连 Redis 做集成验证时，设 ``GUGU_TEST_REAL_REDIS=1`` 显式退出该替身。
    """
    if os.environ.get("GUGU_TEST_REAL_REDIS") == "1":
        yield None
        return

    try:
        import fakeredis
        import fakeredis.aioredis as _fakeredis_async
    except ImportError as e:  # 老 venv 没装测试依赖时给出可执行的提示
        raise RuntimeError(
            "测试依赖 fakeredis 缺失，先执行 pip install -r requirements-dev.txt；"
            "只想临时跳过可设 GUGU_TEST_REAL_REDIS=1（会真连 .env 里的 Redis）。"
        ) from e

    server = fakeredis.FakeServer()
    async_client = _fakeredis_async.FakeRedis(server=server, decode_responses=True)
    sync_client = fakeredis.FakeRedis(server=server, decode_responses=True)
    monkeypatch.setattr(_redis, "_client", async_client)
    monkeypatch.setattr(_redis, "_sync_client", sync_client)
    yield async_client


@pytest.fixture
def enable_filesystem_authorization(monkeypatch):
    """显式打开 Phase 4 授权场景；生产默认值仍保持关闭。"""
    import app.services.filesystem_authorization as _filesystem_authorization

    monkeypatch.setattr(_filesystem_authorization, "filesystem_authorization_enabled", lambda: True)


@pytest_asyncio.fixture(autouse=True)
async def _reset_redis_client():
    """每个测试结束后重置全局 Redis 客户端单例。

    默认路径下 Redis 已被 ``_hermetic_redis`` 换成每个测试一份的进程内假客户端，
    这里主要是兜底：``GUGU_TEST_REAL_REDIS=1`` 真连 Redis 时，懒加载缓存的模块级
    客户端会把连接绑死在当前测试的事件循环上。pytest-asyncio 默认每个测试函数一个
    新事件循环，下一个测试如果复用这个连接，就会报 "Future attached to a different
    loop"；测试之间彼此不感知，只在特定组合顺序下触发，表现为跟顺序有关的 flaky。
    这里在每个测试后主动清空，保证下个测试首次调用 get_redis() 时重新懒加载。
    """
    yield
    await _redis.reset()


@pytest_asyncio.fixture(autouse=True)
async def _close_rag_sidecars():
    """每个测试结束前关闭 RAG worker，避免跨事件循环残留子进程。"""
    yield
    from agent.rag import ts_sidecar

    await ts_sidecar.close_rank_clients()
    await ts_sidecar.close_lexical_clients()


@pytest.fixture(autouse=True)
def _isolate_local_configuration(monkeypatch, tmp_path):
    """测试不得读取工作区里的部署 override；需要配置的用例自行替换路径。"""
    import app.core.config as _config
    monkeypatch.setattr(_config, "OVERRIDE_FILE", tmp_path / "no-config.override.json")
    # 存储根默认指向仓库外的 Gugu-data/users；涉及沙盒或文件的测试若沿用默认值，
    # 会在真实数据目录中不断创建测试用户目录。所有测试统一隔离到临时目录。
    monkeypatch.setenv("STORAGE__LOCAL_PATH", str(tmp_path / "storage"))
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
