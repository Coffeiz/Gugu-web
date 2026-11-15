"""服务状态Python直接对照，仅合成心跳和依赖探测，不重启服务。"""
import asyncio

from app.api.v1 import services_admin as api


def test_service_status_boundary_and_dependency_failure(monkeypatch):
    async def beats():
        return {"worker": {"pid": 10, "host": "synthetic-worker", "ts": 84, "extra": {"ready": True}},
                "gateway": {"pid": 11, "host": "synthetic-gateway", "ts": 85}}
    async def healthy():
        return True
    async def queue():
        return {"length": 4, "pending": 2, "lag": 1, "consumers": 1}
    monkeypatch.setattr(api.health, "read_all", beats)
    monkeypatch.setattr(api.R, "ping", healthy)
    monkeypatch.setattr(api, "_db_ok", healthy)
    monkeypatch.setattr(api, "_queue_info", queue)
    monkeypatch.setattr(api.time, "time", lambda: 100)
    monkeypatch.setattr(api, "_WEB_START", 50)
    monkeypatch.setattr(api, "_HOST", "synthetic-node")
    monkeypatch.setattr(api.os, "getpid", lambda: 12)
    result = asyncio.run(api.list_services())
    assert result["services"][0]["pid"] == 12
    assert result["services"][0]["uptime_secs"] == 50
    assert result["services"][1]["status"] == "online"
    assert result["services"][2]["status"] == "stale"
    assert result["services"][2]["last_seen_secs"] == 16
    assert result["deps"] == {"redis": True, "db": True}
    assert result["queue"] == {"length": 4, "pending": 2, "lag": 1, "consumers": 1}
