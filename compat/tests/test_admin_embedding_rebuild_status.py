"""平台重建只读协议：真实 Worker 状态生成，不运行模型。"""
import json
import sys
from types import SimpleNamespace
import pytest


@pytest.mark.asyncio
async def test_real_worker_status_protocol_without_provider(monkeypatch):
    from app.api.v1 import config
    from app.core import redis
    import app.db.session as sessions
    import agent.memory as memory
    values = {}

    class Redis:
        async def get(self, key):
            assert key == "emb:rebuild"
            return values.get(key)

        async def set(self, key, value, **kwargs):
            assert key == "emb:rebuild"
            assert kwargs.get("ex") == 3600
            values[key] = value

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    async def rebuild(user_ids, **kwargs):
        assert user_ids == []
        return {"pattern_vectors": 2, "memory_vectors": 3, "failed_users": 0}

    async def rag(*args, **kwargs):
        raise AssertionError("空用户批次不得调用模型或RAG")

    monkeypatch.setattr(redis, "get_redis", lambda: Redis())
    monkeypatch.setattr(sessions, "_engine", object())
    monkeypatch.setattr(sessions, "_SessionLocal", Session)
    monkeypatch.setattr(memory, "embedding", SimpleNamespace(is_enabled=lambda: False), raising=False)
    monkeypatch.setattr(memory, "store", SimpleNamespace(rebuild_all_vecs=rebuild, VECTOR_REBUILD_CONCURRENCY=1), raising=False)
    monkeypatch.setitem(sys.modules, "agent.rag.pipeline", SimpleNamespace(rebuild_memory_index=rag))
    await config._rebuild_worker([])
    result = await config.embedding_rebuild_status()
    assert result["status"] == "done"
    assert result["pattern_vectors"] == 2
    assert result["memory_vectors"] == 3
    assert result["rag_failed_users"] == 0
    assert result["tag"] == "byok"
    assert result["message"] == "重建完成：pattern 2 条，memory 3 块"
    assert isinstance(result["ts"], float)
    values["emb:rebuild"] = "{"
    assert await config.embedding_rebuild_status() == {"status": "idle"}
    values["emb:rebuild"] = json.dumps(None)
    assert await config.embedding_rebuild_status() is None
