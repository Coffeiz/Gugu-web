from datetime import timedelta
import asyncio
import os
import threading
import time

import pytest

from app.core import rag_index_gc
from app.core.tz import now_utc


@pytest.mark.asyncio
async def test_sweep_removes_only_stale_cython_snapshots(tmp_path, monkeypatch):
    root = tmp_path / "cython"
    stale = root / ("a" * 20)
    fresh = root / ("b" * 20)
    malformed = root / "not-a-cache-tag"
    incomplete = root / ("c" * 20)
    active = root / ("d" * 20)
    writing = root / ("e" * 20)
    for directory in (stale, fresh, malformed, incomplete, active, writing):
        directory.mkdir(parents=True)
    (stale / "index.json").write_text("{}")
    (fresh / "index.json").write_text("{}")
    (malformed / "index.json").write_text("{}")
    (incomplete / "index.json.tmp").write_text("{}")
    (active / "index.json").write_text("{}")
    (writing / "index.json").write_text("{}")
    (writing / ".index-123.tmp").write_text("partial")
    old = (now_utc() - timedelta(days=31)).timestamp()
    os.utime(stale / "index.json", (old, old))
    os.utime(incomplete / "index.json.tmp", (old, old))
    os.utime(active / "index.json", (old, old))
    os.utime(writing / "index.json", (old, old))
    access = root / ".locks" / f"{active.name}.access"
    access.parent.mkdir()
    access.write_text("")
    os.utime(access, None)

    monkeypatch.setattr(rag_index_gc, "_index_roots", lambda: [root])
    monkeypatch.setattr(rag_index_gc, "_configured_ttl", lambda: 30 * 24 * 3600)

    class Lock:
        async def acquire(self, blocking=False):
            return True

        async def release(self):
            return None

    class Redis:
        def lock(self, *args, **kwargs):
            return Lock()

    monkeypatch.setattr("app.core.redis.get_redis", lambda: Redis())
    assert await rag_index_gc.sweep_cython_index_cache() == 1
    assert not stale.exists()
    assert fresh.exists()
    assert malformed.exists()
    assert incomplete.exists()
    assert active.exists()
    assert writing.exists()


@pytest.mark.asyncio
async def test_gc_waits_for_snapshot_writer_and_rechecks_freshness(tmp_path, monkeypatch):
    """GC 与原子快照写入共用目录锁，写入完成后按新时间戳重新判定。"""
    from agent.rag.snapshot_storage import snapshot_lock

    root = tmp_path / "cython"
    snapshot = root / ("f" * 20)
    snapshot.mkdir(parents=True)
    index_file = snapshot / "index.json"
    index_file.write_text("old")
    old = (now_utc() - timedelta(days=31)).timestamp()
    os.utime(index_file, (old, old))
    monkeypatch.setattr(rag_index_gc, "_index_roots", lambda: [root])
    monkeypatch.setattr(rag_index_gc, "_configured_ttl", lambda: 30 * 24 * 3600)

    class Lock:
        async def acquire(self, blocking=False):
            return True

        async def release(self):
            return None

    class Redis:
        def lock(self, *args, **kwargs):
            return Lock()

    monkeypatch.setattr("app.core.redis.get_redis", lambda: Redis())
    writer_locked = threading.Event()

    def write_snapshot():
        with snapshot_lock(snapshot, exclusive=True):
            writer_locked.set()
            time.sleep(0.1)
            index_file.write_text("fresh")

    writer = threading.Thread(target=write_snapshot)
    writer.start()
    assert await asyncio.to_thread(writer_locked.wait, 2)
    sweep = asyncio.create_task(rag_index_gc.sweep_cython_index_cache())
    await asyncio.sleep(0.02)
    assert not sweep.done()
    await asyncio.to_thread(writer.join, 2)

    assert await sweep == 0
    assert index_file.read_text() == "fresh"
