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
