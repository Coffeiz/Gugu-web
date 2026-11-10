"""管理员完整 RAG 索引重建的后台流程测试。"""
import json

import pytest

import app.api.v1.config as config_api
import agent.rag.index_cache as index_cache
import agent.rag.pipeline as pipeline
import app.db.session as db_session


class _FakeRedis:
    def __init__(self):
        self.values = {}

    async def set(self, key, value, ex=None):
        self.values[key] = value


class _FakeDbContext:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeCache:
    def __init__(self):
        self.loads = []
        self.invalidations = []

    async def get(self, db, user_id, source_type, *, baseline_revision, force):
        self.loads.append((str(user_id), source_type, baseline_revision, force))
        return object()

    def invalidate(self, user_id, *, include_snapshot=False):
        self.invalidations.append((str(user_id), include_snapshot))
        return 1


@pytest.mark.asyncio
async def test_index_rebuild_reprojects_all_sources_and_preloads_cython_index(monkeypatch):
    fake_redis = _FakeRedis()
    fake_cache = _FakeCache()
    calls = []

    async def _rebuild_memory(user_id, *, operation):
        calls.append((str(user_id), "memory", operation))
        return 2

    async def _rebuild_source(user_id, source_type, *, operation):
        calls.append((str(user_id), source_type, operation))
        return 1

    async def _revision(db, user_id):
        return "rag:v2:revision-1"

    monkeypatch.setattr("app.core.redis.get_redis", lambda: fake_redis)
    monkeypatch.setattr(pipeline, "rebuild_memory_index", _rebuild_memory)
    monkeypatch.setattr(pipeline, "rebuild_source_index", _rebuild_source)
    monkeypatch.setattr(pipeline, "_owner_revision", _revision)
    monkeypatch.setattr(index_cache, "get_index_cache", lambda: fake_cache)
    monkeypatch.setattr(db_session, "ensure_engine", lambda: object())
    monkeypatch.setattr(db_session, "_SessionLocal", _FakeDbContext)

    await config_api._rebuild_index_worker(["user-1"])

    assert {source_type for _, source_type, _ in calls} == set(pipeline.INDEX_REBUILD_SOURCE_TYPES)
    assert "file" not in pipeline.INDEX_REBUILD_SOURCE_TYPES
    assert len(calls) == len(pipeline.INDEX_REBUILD_SOURCE_TYPES)
    assert all(operation == "admin-index-rebuild" for _, _, operation in calls)
    assert fake_cache.loads == [("user-1", "all", "rag:v2:revision-1", True)]
    assert fake_cache.invalidations == [("user-1", True)]

    status = json.loads(fake_redis.values[config_api._INDEX_REBUILD_KEY])
    assert status["status"] == "done"
    assert status["done"] == 1
    assert status["total"] == 1
    assert status["documents"] == 2 + len(pipeline.INDEX_REBUILD_SOURCE_TYPES) - 1
    assert status["failed_users"] == 0
    assert status["failed_sources"] == 0


@pytest.mark.asyncio
async def test_index_rebuild_continues_after_source_failure(monkeypatch):
    fake_redis = _FakeRedis()
    fake_cache = _FakeCache()

    async def _rebuild_memory(user_id, *, operation):
        raise RuntimeError("memory source unavailable")

    async def _rebuild_source(user_id, source_type, *, operation):
        return 1

    async def _revision(db, user_id):
        return "rag:v2:revision-2"

    monkeypatch.setattr("app.core.redis.get_redis", lambda: fake_redis)
    monkeypatch.setattr(pipeline, "rebuild_memory_index", _rebuild_memory)
    monkeypatch.setattr(pipeline, "rebuild_source_index", _rebuild_source)
    monkeypatch.setattr(pipeline, "_owner_revision", _revision)
    monkeypatch.setattr(index_cache, "get_index_cache", lambda: fake_cache)
    monkeypatch.setattr(db_session, "ensure_engine", lambda: object())
    monkeypatch.setattr(db_session, "_SessionLocal", _FakeDbContext)
    monkeypatch.setattr(config_api, "diag_log", lambda *_args: None)

    await config_api._rebuild_index_worker(["user-1"])

    status = json.loads(fake_redis.values[config_api._INDEX_REBUILD_KEY])
    assert status["status"] == "error"
    assert status["failed_users"] == 1
    assert status["failed_sources"] == 1
    assert fake_cache.loads == [("user-1", "all", "rag:v2:revision-2", True)]
