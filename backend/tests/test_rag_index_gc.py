from datetime import timedelta

import pytest

from app.core import rag_index_gc
from app.core.tz import now_utc


@pytest.mark.asyncio
async def test_sweep_ts_index_cache_removes_only_stale_owner_indexes(tmp_path, monkeypatch):
    root = tmp_path / "rag-index"
    stale = root / ("a" * 32)
    fresh = root / ("b" * 32)
    ignored = root / "not-an-owner"
    for directory in (stale, fresh, ignored):
        directory.mkdir(parents=True)
    (stale / "index.json").write_text("{}")
    (fresh / "index.json").write_text("{}")
    (ignored / "index.json").write_text("{}")
    old = (now_utc() - timedelta(days=31)).timestamp()
    import os
    os.utime(stale / "index.json", (old, old))

    monkeypatch.setattr(rag_index_gc, "_index_roots", lambda: [root])
    monkeypatch.setattr(rag_index_gc, "_configured_ttl", lambda: 30 * 24 * 3600)
    monkeypatch.setattr("agent.rag.ts_sidecar.active_index_dirs", lambda: set())

    class Lock:
        async def acquire(self, blocking=False):
            return True
        async def release(self):
            return None

    class Redis:
        def lock(self, *args, **kwargs):
            return Lock()

    monkeypatch.setattr("app.core.redis.get_redis", lambda: Redis())
    assert await rag_index_gc.sweep_ts_index_cache() == 1
    assert not stale.exists()
    assert fresh.exists()
    assert ignored.exists()


@pytest.mark.asyncio
async def test_sweep_removes_old_version_index_even_when_fresh(tmp_path, monkeypatch):
    """旧制品写下的索引当前 worker 会判 version_mismatch 丢弃重建：属死数据，不必等 TTL。"""
    root = tmp_path / "rag-index"
    outdated = root / ("c" * 32)
    current = root / ("d" * 32)
    unstamped = root / ("e" * 32)
    active_old = root / ("f" * 32)
    for directory in (outdated, current, unstamped, active_old):
        directory.mkdir(parents=True)
    (outdated / "index.json").write_text('{"version": "0.2.0", "revision": "r"}')
    (current / "index.json").write_text('{"version": "0.3.3", "revision": "r"}')
    # 无版本戳（旧格式/手工造物）：比对不了就只按 TTL 处理，绝不能误删。
    (unstamped / "index.json").write_text('{"revision": "r"}')
    (active_old / "index.json").write_text('{"version": "0.2.0", "revision": "r"}')

    monkeypatch.setattr(rag_index_gc, "_index_roots", lambda: [root])
    monkeypatch.setattr(rag_index_gc, "_configured_ttl", lambda: 30 * 24 * 3600)
    monkeypatch.setattr("agent.rag.ts_sidecar.active_index_dirs", lambda: {active_old.resolve()})
    monkeypatch.setattr("agent.rag.ts_sidecar.worker_artifact_version", lambda: "0.3.3")

    class Lock:
        async def acquire(self, blocking=False):
            return True
        async def release(self):
            return None

    class Redis:
        def lock(self, *args, **kwargs):
            return Lock()

    monkeypatch.setattr("app.core.redis.get_redis", lambda: Redis())
    assert await rag_index_gc.sweep_ts_index_cache() == 1
    assert not outdated.exists()
    assert current.exists()
    assert unstamped.exists()
    assert active_old.exists()


@pytest.mark.asyncio
async def test_sweep_keeps_newer_version_index_after_downgrade(tmp_path, monkeypatch):
    """制品回滚后新版本写下的索引必须留着：清掉只会让升级回去时全部冷重建。"""
    root = tmp_path / "rag-index"
    newer = root / ("a" * 32)
    newer.mkdir(parents=True)
    (newer / "index.json").write_text('{"version": "0.4.0", "revision": "r"}')

    monkeypatch.setattr(rag_index_gc, "_index_roots", lambda: [root])
    monkeypatch.setattr(rag_index_gc, "_configured_ttl", lambda: 30 * 24 * 3600)
    monkeypatch.setattr("agent.rag.ts_sidecar.active_index_dirs", lambda: set())
    monkeypatch.setattr("agent.rag.ts_sidecar.worker_artifact_version", lambda: "0.3.3")

    class Lock:
        async def acquire(self, blocking=False):
            return True
        async def release(self):
            return None

    class Redis:
        def lock(self, *args, **kwargs):
            return Lock()

    monkeypatch.setattr("app.core.redis.get_redis", lambda: Redis())
    assert await rag_index_gc.sweep_ts_index_cache() == 0
    assert newer.exists()


def test_version_ordering_guard_falls_back_when_unparseable():
    """版本串解析不出数字段时不能猜大小，按「不比当前新」处理（宁可留给 TTL）。"""
    assert rag_index_gc._is_newer_version("0.4.0", "0.3.3") is True
    assert rag_index_gc._is_newer_version("0.3.10", "0.3.9") is True
    assert rag_index_gc._is_newer_version("0.2.0", "0.3.3") is False
    assert rag_index_gc._is_newer_version("nightly", "0.3.3") is False
    assert rag_index_gc._is_newer_version("0.3.3", "0.3.3") is False


@pytest.mark.asyncio
async def test_sweep_keeps_old_version_index_when_artifact_version_unknown(tmp_path, monkeypatch):
    """取不到制品版本时按未知处理：只按 TTL 清理，不因比对不了就删数据。"""
    root = tmp_path / "rag-index"
    outdated = root / ("a" * 32)
    outdated.mkdir(parents=True)
    (outdated / "index.json").write_text('{"version": "0.1.0", "revision": "r"}')

    monkeypatch.setattr(rag_index_gc, "_index_roots", lambda: [root])
    monkeypatch.setattr(rag_index_gc, "_configured_ttl", lambda: 30 * 24 * 3600)
    monkeypatch.setattr("agent.rag.ts_sidecar.active_index_dirs", lambda: set())
    monkeypatch.setattr("agent.rag.ts_sidecar.worker_artifact_version", lambda: None)

    class Lock:
        async def acquire(self, blocking=False):
            return True
        async def release(self):
            return None

    class Redis:
        def lock(self, *args, **kwargs):
            return Lock()

    monkeypatch.setattr("app.core.redis.get_redis", lambda: Redis())
    assert await rag_index_gc.sweep_ts_index_cache() == 0
    assert outdated.exists()
