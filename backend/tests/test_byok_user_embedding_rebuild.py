"""用户侧 Embedding 向量重建端点：凭据门槛、Redis 状态机与后台 worker（PRD-SEC-2）。"""
import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

import app.api.v1.byok as byok_api
import app.byok.service as byok_service
import app.core.redis as redis_mod

CFG = {"provider": "dashscope", "api_key": "user-key", "base_url": "https://x.example/v1",
       "model": "text-embedding-v4", "dimensions": 0}


class _FakeRedis:
    def __init__(self):
        self.store = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value


@pytest.fixture(autouse=True)
def _gate_open(monkeypatch):
    """BYOK 开关在单测里恒开；主密钥/设置门槛由 policy 模块自测覆盖。"""
    monkeypatch.setattr(byok_api, "require_byok_enabled", lambda: None)


@pytest.fixture()
def fake_redis(monkeypatch):
    fake = _FakeRedis()
    monkeypatch.setattr(redis_mod, "get_redis", lambda: fake)
    return fake


def _user():
    return SimpleNamespace(id=uuid4())


async def _wait_terminal(fake_redis, user_id, limit=200):
    """create_task 的 worker 与测试同循环，sleep(0) 逐步让步直到写出终态。"""
    key = f"emb:rebuild:user:{user_id}"
    for _ in range(limit):
        raw = fake_redis.store.get(key)
        if raw:
            d = json.loads(raw if isinstance(raw, str) else raw.decode())
            if d.get("status") != "running":
                return d
        await asyncio.sleep(0)
    raise AssertionError(f"重建未在预算内完成: {fake_redis.store.get(key)}")


@pytest.mark.asyncio
async def test_rebuild_without_credential_rejected(monkeypatch, fake_redis):
    """没有生效 embedding 凭据 → 拒绝且不写任何 Redis 状态。"""
    async def _none(db, user_id, base):
        return None
    monkeypatch.setattr(byok_service, "resolve_embedding_settings", _none)
    res = await byok_api.rebuild_my_vectors(user=_user(), db=None)
    assert res["ok"] is False
    assert "Embedding" in res["message"]
    assert fake_redis.store == {}


@pytest.mark.asyncio
async def test_rebuild_starts_and_finishes(monkeypatch, fake_redis):
    """有凭据 → 启动后台重建，pattern/memory 计数与 RAG 索引结果落到状态里。"""
    async def _cfg(db, user_id, base):
        return dict(CFG)
    monkeypatch.setattr(byok_service, "resolve_embedding_settings", _cfg)

    calls = {}

    async def _rebuild(user_ids, on_progress=None, bind_cfgs=None):
        calls["user_ids"] = user_ids
        calls["bind"] = bind_cfgs
        assert bind_cfgs[user_ids[0]]["api_key"] == "user-key"
        return {"failed_users": 0, "pattern_vectors": 3, "memory_vectors": 5}

    async def _rag(uid, operation=None):
        calls["rag_uid"] = uid
        return None

    import agent.memory.store as store_mod
    import agent.rag.pipeline as pipeline_mod
    monkeypatch.setattr(store_mod, "rebuild_all_vecs", _rebuild)
    monkeypatch.setattr(pipeline_mod, "rebuild_memory_index", _rag)

    user = _user()
    res = await byok_api.rebuild_my_vectors(user=user, db=None)
    assert res["ok"] is True
    status = await _wait_terminal(fake_redis, user.id)
    assert calls["user_ids"] == [str(user.id)]
    assert status["status"] == "done"
    assert status["pattern_vectors"] == 3
    assert status["memory_vectors"] == 5
    assert "重建完成" in status["message"]
    assert str(calls["rag_uid"]) == str(user.id)
    # 其它用户查不到这份状态
    assert (await byok_api.rebuild_my_vectors_status(user=_user())) == {"status": "idle"}


@pytest.mark.asyncio
async def test_rebuild_rag_failure_marks_error(monkeypatch, fake_redis):
    """RAG 索引失败不吞掉：整体状态标 error，向量计数仍然上报。"""
    async def _cfg(db, user_id, base):
        return dict(CFG)
    monkeypatch.setattr(byok_service, "resolve_embedding_settings", _cfg)

    async def _rebuild(user_ids, on_progress=None, bind_cfgs=None):
        return {"failed_users": 0, "pattern_vectors": 1, "memory_vectors": 0}

    async def _rag(uid, operation=None):
        raise RuntimeError("rag down")

    import agent.memory.store as store_mod
    import agent.rag.pipeline as pipeline_mod
    monkeypatch.setattr(store_mod, "rebuild_all_vecs", _rebuild)
    monkeypatch.setattr(pipeline_mod, "rebuild_memory_index", _rag)

    user = _user()
    await byok_api.rebuild_my_vectors(user=user, db=None)
    status = await _wait_terminal(fake_redis, user.id)
    assert status["status"] == "error"
    assert "RAG 索引失败" in status["message"]


@pytest.mark.asyncio
async def test_rebuild_double_start_guarded(monkeypatch, fake_redis):
    """已有任务在跑 → 第二次启动被拒绝。"""
    async def _cfg(db, user_id, base):
        return dict(CFG)
    monkeypatch.setattr(byok_service, "resolve_embedding_settings", _cfg)

    async def _never(user_ids, on_progress=None, bind_cfgs=None):
        await asyncio.sleep(60)

    import agent.memory.store as store_mod
    monkeypatch.setattr(store_mod, "rebuild_all_vecs", _never)

    user = _user()
    first = await byok_api.rebuild_my_vectors(user=user, db=None)
    assert first["ok"] is True
    second = await byok_api.rebuild_my_vectors(user=user, db=None)
    assert second["ok"] is False
    assert second["message"] == "已有重建任务在跑"


@pytest.mark.asyncio
async def test_status_idle(monkeypatch, fake_redis):
    user = _user()
    assert await byok_api.rebuild_my_vectors_status(user=user) == {"status": "idle"}
    fake_redis.store[f"emb:rebuild:user:{user.id}"] = json.dumps({"status": "done", "message": "x"})
    assert (await byok_api.rebuild_my_vectors_status(user=user))["message"] == "x"
