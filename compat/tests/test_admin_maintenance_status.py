"""后台维护状态Python直接对照，合成Redis且不执行维护。"""
import asyncio
import json

from app.api.v1 import config as api
from app.core import redis


def test_maintenance_status_payload_boundary_and_ttl(monkeypatch):
    data, writes = {}, []
    class Store:
        async def get(self, key):
            return data.get(key)
        async def set(self, key, value, ex):
            writes.append((key, json.loads(value), ex))
            data[key] = value
    monkeypatch.setattr(redis, "get_redis", lambda: Store())
    monkeypatch.setattr(api.time, "time", lambda: 1000)
    async def scenario():
        assert await api.index_rebuild_status() == {"status": "idle"}
        assert await api.memory_cleanup_status() == {"status": "idle"}
        data[api._INDEX_REBUILD_KEY] = "broken"
        assert await api.index_rebuild_status() == {"status": "idle"}
        data[api._INDEX_REBUILD_KEY] = "[1,2]"
        assert await api.index_rebuild_status() == [1, 2]
        data[api._MEM_CLEANUP_KEY] = json.dumps({"status": "running", "ts": 401, "done": 2, "total": 5})
        assert (await api.memory_cleanup_status())["status"] == "running"
        assert writes == []
        data[api._MEM_CLEANUP_KEY] = json.dumps({"status": "running", "ts": 400, "done": 2, "total": 5})
        assert await api.memory_cleanup_status() == {"status": "stale", "done": 2, "total": 5, "message": "上次预览已超时，请重新生成"}
        assert writes[-1][2] == 3600
    asyncio.run(scenario())
