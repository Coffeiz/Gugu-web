"""主 LLM BYOK 的运行时目的地绑定：用户 Key 绝不拼平台 Base URL。

resolve_run_config_for_user 是主模型链路独立的 BYOK 覆盖实现（不走 service
resolver），曾与 embedding/stt 同病：用户 base_url 为空时回退平台 base_url——
平台 DashScope 端点 + 用户 DeepSeek Key 的混配在创建凭据时就能形成。该问题为
存量（PR50 base main@0dd637e2 已存在），与 service 两个 resolver 一并收口：
目的地只来自用户凭据（空串按 provider 官方默认端点解析），解析不出就放弃
覆盖回落平台配置。
"""
from types import SimpleNamespace

import pytest

import agent.llm.llm_select as llm_select
import app.byok.service as byok_service
from agent.llm.llm_select import ModelRunConfig, resolve_run_config_for_user
from app.core.config import AIPresetItem

PLATFORM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


def _platform_model():
    return AIPresetItem(model="platform-model", provider="dashscope", api_key="platform-secret",
                        base_url=PLATFORM_BASE_URL, context_tokens=80000)


def _platform_config():
    return ModelRunConfig(model=_platform_model(), use_anthropic=False,
                          context_tokens=80000, is_byok=False)


class _Scalars:
    def __init__(self, rows):
        self._rows = rows
    def scalars(self):
        return self
    def all(self):
        return self._rows


class _Db:
    def __init__(self, rows):
        self._rows = rows
    async def execute(self, _query):
        return _Scalars(self._rows)


def _user_row(**overrides):
    row = SimpleNamespace(provider="deepseek", api_format="openai", base_url="",
                          model="deepseek-v4", context_tokens=None, max_tokens=None,
                          thinking=None, reasoning_effort=None, reasoning_persistence="off")
    for key, value in overrides.items():
        setattr(row, key, value)
    return [row]


@pytest.fixture
def harness(monkeypatch):
    monkeypatch.setattr(llm_select, "resolve_run_config",
                        lambda settings, ctx: _platform_config())
    settings = SimpleNamespace(
        byok=SimpleNamespace(enabled=True),
        ai=SimpleNamespace(deployment_mode="hosted", context_tokens=80000),
    )
    monkeypatch.setattr(byok_service, "decrypt_value", lambda _row: "sk-deepseek-secret")
    return settings


@pytest.mark.asyncio
async def test_user_key_without_base_url_never_rides_platform_endpoint(monkeypatch, harness):
    """用户 DeepSeek Key + base_url 空：deepseek 解析不出官方默认端点 → 放弃覆盖
    回落平台配置。绝不能出现平台 DashScope URL + 用户 DeepSeek Key 的混配。"""
    db = _Db(_user_row(base_url=""))
    cfg = await resolve_run_config_for_user(harness, db, "uid")
    assert cfg.is_byok is False
    assert cfg.model.api_key == "platform-secret"
    assert cfg.model.base_url == PLATFORM_BASE_URL


@pytest.mark.asyncio
async def test_user_explicit_base_url_is_used_as_destination(monkeypatch, harness):
    db = _Db(_user_row(base_url="https://my-deepseek-proxy.example/v1"))
    cfg = await resolve_run_config_for_user(harness, db, "uid")
    assert cfg.is_byok is True
    assert cfg.model.provider == "deepseek"
    assert cfg.model.api_key == "sk-deepseek-secret"
    assert cfg.model.base_url == "https://my-deepseek-proxy.example/v1"
    assert PLATFORM_BASE_URL not in cfg.model.base_url


@pytest.mark.asyncio
async def test_user_empty_base_url_resolves_provider_default(monkeypatch, harness):
    """有官方默认端点的 provider：空 base_url 落到 provider 默认端点（glm）。"""
    db = _Db(_user_row(provider="glm", base_url=""))
    cfg = await resolve_run_config_for_user(harness, db, "uid")
    assert cfg.is_byok is True
    assert cfg.model.api_key == "sk-deepseek-secret"
    assert cfg.model.base_url == "https://open.bigmodel.cn/api/paas/v4"


@pytest.mark.asyncio
async def test_no_credential_returns_platform_config(monkeypatch, harness):
    db = _Db([])
    cfg = await resolve_run_config_for_user(harness, db, "uid")
    assert cfg.is_byok is False
    assert cfg.model.api_key == "platform-secret"
