"""BYOK Embedding 凭据：解析回退、run 级绑定与 model_tag 跟随（PRD-SEC-2 Phase 1）。"""
from types import SimpleNamespace

import httpx
import pytest

import agent.memory.embedding as embedding
import app.byok.service as byok_service
from app.byok.service import bind_user_embedding, effective_embedding_override, resolve_embedding_settings


PLATFORM = SimpleNamespace(
    enabled=False, multimodal=True, provider="platform", api_key="plat-key",
    base_url="https://platform.example/v1", model="plat-model", dimensions=8,
)

OVERRIDE = {"provider": "dashscope", "api_key": "user-key", "base_url": "https://dashscope.example/compatible-mode/v1",
            "model": "text-embedding-v4", "dimensions": 0}


@pytest.fixture(autouse=True)
def _platform_settings(monkeypatch):
    monkeypatch.setattr(embedding, "get_settings",
                        lambda: SimpleNamespace(embedding=PLATFORM))


@pytest.fixture()
def _clean_override():
    token = byok_service._embedding_override.set(None)
    yield
    byok_service._embedding_override.reset(token)


class _FakeResponse:
    def __init__(self, payload):
        self.status_code = 200
        self._payload = payload
    def json(self):
        return self._payload


class _FakeClient:
    last_request = None
    def __init__(self, *a, **kw):
        pass
    async def __aenter__(self):
        return self
    async def __aexit__(self, *exc):
        return False
    async def post(self, url, json=None, headers=None):
        _FakeClient.last_request = {"url": url, "json": json, "headers": headers}
        return _FakeResponse({"data": [{"embedding": [0.1, 0.2]}]})


def test_unbound_falls_back_to_platform(_clean_override):
    """未绑定（无凭据用户/平台链路）：is_enabled/model_tag/embed 全部走平台配置。"""
    assert effective_embedding_override() is None
    assert embedding.is_enabled() is False          # 平台 enabled=False → 词法回退
    assert embedding.model_tag() == "platform:plat-model:8"


def test_bound_override_enables_and_follows_tag(_clean_override):
    """BYOK 生效：不受平台 enabled 开关限制，tag 用用户的 provider/model/dimensions。"""
    with bind_user_embedding(OVERRIDE):
        assert embedding.is_enabled() is True
        assert embedding.model_tag() == "dashscope:text-embedding-v4:default"
    assert embedding.is_enabled() is False          # 退出绑定后回落平台
    assert embedding.model_tag() == "platform:plat-model:8"


def test_embed_uses_user_endpoint_and_key(monkeypatch, _clean_override):
    """embed 请求打到用户 base_url 的 /embeddings，带用户 key；dimensions=0 不传维度。"""
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)
    with bind_user_embedding(OVERRIDE):
        vec = __import__("asyncio").run(embedding.embed("hello"))
    assert vec == [0.1, 0.2]
    req = _FakeClient.last_request
    assert req["url"] == "https://dashscope.example/compatible-mode/v1/embeddings"
    assert req["headers"]["Authorization"] == "Bearer user-key"
    assert req["json"]["model"] == "text-embedding-v4"
    assert "dimensions" not in req["json"]


def test_embed_override_never_routes_to_platform_multimodal(monkeypatch, _clean_override):
    """平台开了百炼多模态也不影响 BYOK：覆盖配置只走 OpenAI 兼容文本端点。"""
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)
    with bind_user_embedding(OVERRIDE):
        __import__("asyncio").run(embedding.embed("hello"))
    assert _FakeClient.last_request["url"].endswith("/embeddings")
    assert "multimodal-embedding" not in _FakeClient.last_request["url"]


def test_embed_missing_base_url_never_sends_user_key(monkeypatch, _clean_override):
    """纵深防御：即使覆盖配置缺 base_url（目的地不明），embed() 也绝不发带用户
    Key 的请求——is_enabled 判定过不了，退回词法检索。"""
    import asyncio

    class _BoomClient:
        def __init__(self, *a, **kw):
            raise AssertionError("缺目的地时不得发起任何 HTTP 请求")

    monkeypatch.setattr(httpx, "AsyncClient", _BoomClient)
    cfg = {"provider": "openai", "api_key": "sk-user-secret", "base_url": "",
           "model": "user-model", "dimensions": 0}
    with bind_user_embedding(cfg):
        assert embedding.is_enabled() is False
        assert asyncio.run(embedding.embed("hello")) is None


def test_bind_resets_on_exception(_clean_override):
    """绑定异常路径也必须 reset，防止 ContextVar 泄漏到后续调用。"""
    with pytest.raises(RuntimeError):
        with bind_user_embedding(OVERRIDE):
            raise RuntimeError("boom")
    assert effective_embedding_override() is None


def _patch_resolver(monkeypatch, row, decrypt=None):
    # 桩必须是 async（与真实 get_active_credential 同签名），否则 resolve 里
    # await 一个同步返回值会 TypeError，掩盖真实路径。
    async def _get(db, uid, cap):
        return row
    monkeypatch.setattr(byok_service, "get_active_credential", _get)
    if decrypt is not None:
        monkeypatch.setattr(byok_service, "decrypt_value", decrypt)


BASE = SimpleNamespace(model="plat-model", base_url="https://platform.example/v1")


@pytest.mark.asyncio
async def test_resolve_full_override(monkeypatch):
    row = SimpleNamespace(provider="openai", model="user-model", base_url="https://user.example/v1",
                          dimensions=1024, encrypted_value="x")
    _patch_resolver(monkeypatch, row, decrypt=lambda r: "user-key")
    cfg = await resolve_embedding_settings(None, "uid", BASE)
    # 目的地绑定：model/base_url 都只来自用户凭据，绝不继承平台值
    assert cfg == {"provider": "openai", "api_key": "user-key",
                   "base_url": "https://user.example/v1",
                   "model": "user-model", "dimensions": 1024}


@pytest.mark.asyncio
async def test_resolve_never_inherits_platform_destination(monkeypatch):
    """运行时目的地绑定收口：用户 Key 的 model/base_url 缺失时回落平台配置（None），
    绝不继承平台 URL/模型名——否则平台 dashscope URL 会拼上用户 OpenAI Key 发出去。"""
    row = SimpleNamespace(provider="openai", model="", base_url="",
                          dimensions=1024, encrypted_value="x")
    _patch_resolver(monkeypatch, row, decrypt=lambda r: "user-key")
    # 平台是 dashscope URL + 平台模型：用户凭据缺 model → 覆盖放弃
    assert await resolve_embedding_settings(None, "uid", BASE) is None

    # 有 model 但 base_url 空，且 provider 解析不出官方默认端点 → 同样放弃
    row = SimpleNamespace(provider="openai", model="user-model", base_url="",
                          dimensions=None, encrypted_value="x")
    _patch_resolver(monkeypatch, row, decrypt=lambda r: "user-key")
    assert await resolve_embedding_settings(None, "uid", BASE) is None


@pytest.mark.asyncio
async def test_resolve_empty_base_url_uses_provider_default_endpoint(monkeypatch):
    """base_url 空串 = provider 官方默认端点（与保存链路 _effective_origin 同口径），
    不看平台配置；glm 有 adapter 默认端点，解析结果必须是大模型默认端点。"""
    row = SimpleNamespace(provider="glm", model="embedding-3", base_url="",
                          dimensions=None, encrypted_value="x")
    _patch_resolver(monkeypatch, row, decrypt=lambda r: "user-key")
    cfg = await resolve_embedding_settings(None, "uid", BASE)
    assert cfg is not None
    assert cfg["base_url"] == "https://open.bigmodel.cn/api/paas/v4"
    assert "platform.example" not in cfg["base_url"]


@pytest.mark.asyncio
async def test_resolve_incomplete_returns_none(monkeypatch):
    """model 缺失且 base_url 解析不出默认端点 → 覆盖不完整，回落平台配置
    （None=不覆盖）。平台配置不参与补齐用户凭据的目的地字段。"""
    empty_base = SimpleNamespace(model="", base_url="")
    row = SimpleNamespace(provider="openai", model="", base_url="",
                          dimensions=None, encrypted_value="x")
    _patch_resolver(monkeypatch, row, decrypt=lambda r: "user-key")
    assert await resolve_embedding_settings(None, "uid", empty_base) is None


@pytest.mark.asyncio
async def test_resolve_no_credential_or_decrypt_failure(monkeypatch):
    _patch_resolver(monkeypatch, None)
    assert await resolve_embedding_settings(None, "uid", BASE) is None

    def boom(_row):
        raise ValueError("corrupt")
    row = SimpleNamespace(provider="openai", model="m", base_url="https://u.example/v1",
                          dimensions=None, encrypted_value="x")
    _patch_resolver(monkeypatch, row, decrypt=boom)
    assert await resolve_embedding_settings(None, "uid", BASE) is None


@pytest.mark.asyncio
async def test_resolve_dimensions_zero_means_model_default(monkeypatch):
    """dimensions=0/None = 用模型默认维度，不继承平台值。"""
    row = SimpleNamespace(provider="openai", model="user-model",
                          base_url="https://u.example/v1", dimensions=0,
                          encrypted_value="x")
    _patch_resolver(monkeypatch, row, decrypt=lambda r: "k")
    cfg = await resolve_embedding_settings(None, "uid", BASE)
    assert cfg["dimensions"] == 0


# ── Phase 2：run 入口绑定与 Admin 重建 ────────────────────────────────────────

def test_resolve_and_bind_swallows_resolver_failure(monkeypatch, _clean_override):
    """绑定入口绝不抛：解析失败按 None 处理（回落平台），不影响 run。
    绑定与读取必须在同一任务上下文内（asyncio.run 的任务上下文是拷贝）。"""
    import asyncio

    settings = SimpleNamespace(embedding=SimpleNamespace())
    def boom(*a, **kw):
        raise RuntimeError("db down")
    monkeypatch.setattr(byok_service, "resolve_embedding_settings", boom)

    async def fail_case():
        await byok_service.resolve_and_bind_user_embedding(settings, None, "uid")
        return effective_embedding_override()

    assert asyncio.run(fail_case()) is None

    async def fake_resolve(*a, **kw):
        return dict(OVERRIDE)
    monkeypatch.setattr(byok_service, "resolve_embedding_settings", fake_resolve)

    async def bind_case():
        await byok_service.resolve_and_bind_user_embedding(settings, None, "uid")
        return effective_embedding_override()

    assert asyncio.run(bind_case()) == OVERRIDE


def test_rebuild_all_vecs_binds_per_user(monkeypatch, tmp_path, _clean_override):
    """批量重建逐用户绑定：每个用户任务内读到自己的配置，任务外互不影响。"""
    import asyncio
    from agent.memory import store

    seen = {}

    async def fake_sync(uid, items, force, *, strict=False):
        seen[uid] = dict(effective_embedding_override() or {})
        return len(items)

    monkeypatch.setattr(store, "read_pattern_list", lambda uid: _ret(["p"]))
    monkeypatch.setattr(store, "read_memory_doc", lambda uid: _ret(""))
    monkeypatch.setattr(store, "sync_pattern_vecs", fake_sync)
    monkeypatch.setattr(store, "sync_memory_vecs", fake_sync)

    cfgs = {"u1": dict(OVERRIDE), "u2": None}
    summary = asyncio.run(store.rebuild_all_vecs(["u1", "u2"], bind_cfgs=cfgs))
    assert summary["failed_users"] == 0
    assert seen["u1"] == OVERRIDE
    assert seen["u2"] == {}
    assert effective_embedding_override() is None   # 汇总任务上下文不被污染


async def _ret(v):
    return v


# ── Phase 3：测试连接（/embeddings 试呼）─────────────────────────────────────

def test_test_embedding_credential_pass_and_fail(monkeypatch, _clean_override):
    import asyncio
    from app.api.v1.byok import _test_embedding_credential

    class Resp:
        def __init__(self, status, payload=None, text=""):
            self.status_code, self._p, self.text = status, payload, text
        def json(self):
            if self._p is None:
                raise ValueError("not json")
            return self._p

    class Client(_FakeClient):
        response: Resp
        async def post(self, url, json=None, headers=None):
            _FakeClient.last_request = {"url": url, "json": json, "headers": headers}
            return Client.response

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    Client.response = Resp(200, {"data": [{"embedding": [0.5]}]})
    result = asyncio.run(_test_embedding_credential(
        api_key="sk-user", base_url="https://u.example/v1", model="emb-1", dimensions=1024))
    assert result["ok"] is True and result["status"] == 200
    req = _FakeClient.last_request
    assert req["url"] == "https://u.example/v1/embeddings"
    assert req["json"] == {"model": "emb-1", "input": "ping", "dimensions": 1024}
    assert req["headers"]["Authorization"] == "Bearer sk-user"

    # 非 200：状态与脱敏摘要进 message，不带 Authorization 回显
    Client.response = Resp(401, text='{"error":"bad key sk-user"}')
    result = asyncio.run(_test_embedding_credential(
        api_key="sk-user", base_url="https://u.example/v1", model="emb-1"))
    assert result["ok"] is False and result["status"] == 401

    # 200 但无向量数据 → 格式异常
    Client.response = Resp(200, {"data": []})
    result = asyncio.run(_test_embedding_credential(
        api_key="k", base_url="https://u.example/v1", model="m"))
    assert result["ok"] is False and result["status"] == 200 and "格式异常" in result["message"]

    # 非 JSON 响应 → 同样判格式异常而非抛异常
    Client.response = Resp(200, None)
    result = asyncio.run(_test_embedding_credential(
        api_key="k", base_url="https://u.example/v1", model="m"))
    assert result["ok"] is False and "格式异常" in result["message"]


@pytest.mark.asyncio
async def test_resolve_awaits_real_credential_query(_clean_override, caplog):
    """回归：resolve 必须真正 await 凭据查询。

    漏 await 时 get_active_credential 返回 coroutine（永非 None），无凭据用户
    也会误入解密分支打 warning；此处不 mock 查询层，用 stub db 走真实代码路径，
    断言「无凭据 → 静默返回 None 且零 warning」。"""
    import logging
    from uuid import uuid4

    import app.byok.service as svc

    class _Result:
        def scalars(self):
            return self
        def all(self):
            return []

    class _DB:
        async def execute(self, _query):
            return _Result()

    monkey = getattr(svc, "byok_enabled", None)
    svc.byok_enabled = lambda: True
    try:
        with caplog.at_level(logging.WARNING, logger="app.byok.service"):
            cfg = await svc.resolve_embedding_settings(_DB(), uuid4(), PLATFORM)
    finally:
        if monkey is not None:
            svc.byok_enabled = monkey
    assert cfg is None
    assert caplog.text == "", f"无凭据不应产生任何 warning: {caplog.text}"
