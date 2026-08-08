"""暂存附件按物理年龄定时清理（PRD-STORAGE-1 Phase A）。

覆盖 `.chat_staging/`/`.voice/` 混合过期场景、TTL_VOICE 分支选择、非暂存路径
免疫、边界值（mtime=None、空存储）、并发锁保护。用 `LocalStorageBackend` +
`tmp_path`，跟 `tests/test_storage_cleanup.py` 同一套 fixture 风格。
"""
import os
import time

import pytest

from app.core import staging_gc
from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path):
    return LocalStorageBackend(tmp_path)


def _age_key(storage: LocalStorageBackend, key: str, days_old: float) -> None:
    """把某个已写入的 key 的 mtime 改到 N 天前，模拟"暂存了很久"。"""
    path = storage.root / key
    old = time.time() - days_old * 86400
    os.utime(path, (old, old))


@pytest.mark.asyncio
async def test_sweep_deletes_only_expired_chat_staging(monkeypatch, storage):
    """混合放 3 个 .chat_staging/ 对象，只有 1 个超过 TTL，只删那一个。"""
    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)

    await storage.put("u1/.chat_staging/a.png", b"a")
    await storage.put("u1/.chat_staging/b.png", b"b")
    await storage.put("u1/.chat_staging/c.png", b"c")
    _age_key(storage, "u1/.chat_staging/a.png", days_old=8)   # 超过 7 天 TTL
    _age_key(storage, "u1/.chat_staging/b.png", days_old=3)   # 未超

    deleted = await staging_gc._sweep_locked()

    assert deleted == 1
    assert not await storage.exists("u1/.chat_staging/a.png")
    assert await storage.exists("u1/.chat_staging/b.png")
    assert await storage.exists("u1/.chat_staging/c.png")


@pytest.mark.asyncio
async def test_sweep_voice_uses_ttl_voice_not_generic_ttl(monkeypatch, storage):
    """.voice/ 走的是 TTL_VOICE 这个变量，不是巧合碰到跟 TTL 相同的数值——
    把 TTL_VOICE 单独 monkeypatch 成一个更短的值，验证分支选择是真的按路径区分，
    不是两个常量当前恰好相等导致的假阳性。"""
    from app.core import chat_attach

    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)
    monkeypatch.setattr(chat_attach, "TTL_VOICE", 2 * 86400)   # 语音改成 2 天就过期
    # chat_attach.TTL 保持默认 7 天不变

    await storage.put("u1/.voice/v.mp3", b"v")
    await storage.put("u1/.chat_staging/p.png", b"p")
    _age_key(storage, "u1/.voice/v.mp3", days_old=3)          # 超过 2 天（TTL_VOICE），未超 7 天（TTL）
    _age_key(storage, "u1/.chat_staging/p.png", days_old=3)   # 同样 3 天，但走 TTL=7 天，不该被删

    deleted = await staging_gc._sweep_locked()

    assert deleted == 1
    assert not await storage.exists("u1/.voice/v.mp3")
    assert await storage.exists("u1/.chat_staging/p.png")


@pytest.mark.asyncio
async def test_sweep_ignores_non_staging_paths(monkeypatch, storage):
    """用户文件库正常上传的文件，即使 mtime 很老也不受清理任务影响。"""
    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)

    await storage.put("u1/项目文件/2026/doc.md", b"d")
    _age_key(storage, "u1/项目文件/2026/doc.md", days_old=365)

    deleted = await staging_gc._sweep_locked()

    assert deleted == 0
    assert await storage.exists("u1/项目文件/2026/doc.md")


@pytest.mark.asyncio
async def test_sweep_empty_storage_returns_zero(monkeypatch, storage):
    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)
    assert await staging_gc._sweep_locked() == 0


@pytest.mark.asyncio
async def test_sweep_skips_objects_with_missing_mtime(monkeypatch, storage):
    """stat() 拿不到 mtime（比如对象在扫描和 stat 之间被删掉）时跳过、不当成"该删"处理。"""
    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)

    await storage.put("u1/.chat_staging/a.png", b"a")
    _age_key(storage, "u1/.chat_staging/a.png", days_old=30)

    class _NoMtimeInfo:
        mtime = None

    async def fake_stat(key):
        return _NoMtimeInfo()

    monkeypatch.setattr(storage, "stat", fake_stat)

    deleted = await staging_gc._sweep_locked()

    assert deleted == 0
    assert await storage.exists("u1/.chat_staging/a.png")


class _FakeLock:
    def __init__(self, acquirable: bool):
        self._acquirable = acquirable
        self.released = False

    async def acquire(self, blocking=False):
        return self._acquirable

    async def release(self):
        self.released = True


class _FakeRedis:
    def __init__(self, acquirable: bool):
        self._acquirable = acquirable
        self.lock_calls = []
        self.last_lock: _FakeLock | None = None

    def lock(self, key, timeout=None, blocking=None):
        self.lock_calls.append(key)
        self.last_lock = _FakeLock(self._acquirable)
        return self.last_lock


@pytest.mark.asyncio
async def test_sweep_expired_staging_noop_when_lock_held(monkeypatch, storage):
    """锁已被占用（比如另一个进程正在跑）时直接返回 0，不做任何存储扫描/删除。"""
    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)
    fake_redis = _FakeRedis(acquirable=False)
    monkeypatch.setattr(staging_gc.R, "get_redis", lambda: fake_redis)

    await storage.put("u1/.chat_staging/a.png", b"a")
    _age_key(storage, "u1/.chat_staging/a.png", days_old=30)

    result = await staging_gc.sweep_expired_staging()

    assert result == 0
    assert await storage.exists("u1/.chat_staging/a.png")   # 完全没碰存储
    assert fake_redis.lock_calls == [staging_gc._LOCK_KEY]


@pytest.mark.asyncio
async def test_sweep_expired_staging_runs_and_releases_lock_when_acquired(monkeypatch, storage):
    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)
    fake_redis = _FakeRedis(acquirable=True)
    monkeypatch.setattr(staging_gc.R, "get_redis", lambda: fake_redis)

    await storage.put("u1/.chat_staging/a.png", b"a")
    _age_key(storage, "u1/.chat_staging/a.png", days_old=30)

    result = await staging_gc.sweep_expired_staging()

    assert result == 1
    assert not await storage.exists("u1/.chat_staging/a.png")
    assert fake_redis.last_lock is not None
    assert fake_redis.last_lock.released is True
