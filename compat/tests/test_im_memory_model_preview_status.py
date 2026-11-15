"""IM模型维护状态只读对照，不启动模型和记忆维护。"""
import asyncio
import json

import pytest

from app.api.v1 import agent_admin as api
from app.core import redis


def test_model_preview_status_defaults_payload_and_malformed_json(monkeypatch):
    data = {}
    class Store:
        async def get(self, key):
            assert key == "im_memory:maintenance:model_preview"
            return data.get(key)
    monkeypatch.setattr(redis, "get_redis", lambda: Store())
    async def scenario():
        assert await api.im_memory_model_preview_status() == {
            "status": "idle", "done": 0, "total": 0, "needs_review": 0,
            "failed": 0, "plan_ready": False,
        }
        value = {"status": "done", "done": 2, "total": 2, "needs_review": 1, "failed": 0, "plan_ready": True}
        data[api._IM_MODEL_PREVIEW_KEY] = json.dumps(value)
        assert await api.im_memory_model_preview_status() == value
        data[api._IM_MODEL_PREVIEW_KEY] = "broken"
        with pytest.raises(json.JSONDecodeError):
            await api.im_memory_model_preview_status()
    asyncio.run(scenario())
