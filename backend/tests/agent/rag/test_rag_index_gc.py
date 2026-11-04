from datetime import timedelta
import os

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
    for directory in (stale, fresh, malformed, incomplete):
        directory.mkdir(parents=True)
    (stale / "index.json").write_text("{}")
    (fresh / "index.json").write_text("{}")
    (malformed / "index.json").write_text("{}")
    (incomplete / "index.json.tmp").write_text("{}")
    old = (now_utc() - timedelta(days=31)).timestamp()
    os.utime(stale / "index.json", (old, old))
    os.utime(incomplete / "index.json.tmp", (old, old))

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
