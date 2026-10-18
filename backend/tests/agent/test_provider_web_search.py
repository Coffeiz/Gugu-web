"""原生搜索字段、传输协议与并发 run Schema 隔离回归。"""
from types import SimpleNamespace
import json

import httpx
import pytest

from agent.providers import web_search
from agent.tools import registry
from agent.tools.tool_contract import validate_input


def config(provider, api_format="openai", base_url=""):
    return SimpleNamespace(
        provider=provider, api_format=api_format, base_url=base_url,
        api_key="synthetic-test-key", model="mimo-v2.6-pro" if provider == "mimo" else "synthetic-model",
        ollama_mode="cloud", web_search_enabled=True,
    )


def test_run_schemas_and_validation_stay_bound_to_their_provider():
    """同进程多 Provider 不得相互覆盖参数，旧快照也不能随新 run 改变。"""
    default_schema = registry.snapshot().get("web_search").input_schema.copy()
    specs = [
        (config("minimax"), {"query": "测试"}, {"search_query": "测试"}),
        (config("glm"), {"search_query": "测试", "search_engine": "search_std", "search_intent": False}, {"query": "测试"}),
        (config("qwen", "responses"), {"input": "测试"}, {"query": "测试"}),
        (config("qwen"), {"messages": [{"role": "user", "content": "测试"}]}, {"input": "测试"}),
        (config("deepseek"), {"query": "测试", "count": 5, "need_content": True}, {"search_query": "测试"}),
        (config("ollama"), {"query": "测试", "max_results": 10}, {"count": 5}),
        (config("mimo"), {"messages": [{"role": "user", "content": "测试"}], "tools": [{"type": "web_search", "force_search": True}]}, {"query": "测试"}),
    ]
    snapshots = [registry.snapshot_with_extras(model_cfg=cfg) for cfg, _, _ in specs]
    for snapshot, (_, valid, invalid) in zip(snapshots, specs):
        tool = snapshot.get("web_search")
        assert validate_input(tool._input_validator, valid) == []
        assert validate_input(tool._input_validator, invalid)
        assert validate_input(tool._input_validator, {**valid, "foreign_argument": 3})
        assert snapshot.openai_schemas(["web_search"])[0]["function"]["parameters"] == tool.input_schema
        assert snapshot.anthropic_schemas(["web_search"])[0]["input_schema"] == tool.input_schema
    assert registry.snapshot().get("web_search").input_schema == default_schema


def test_compact_catalog_fields_follow_current_provider():
    """简介模式不得沿用上一家 Provider 的字段提示。"""
    from agent.capabilities.injector import _tool_field_signature
    from agent.llm import modelctx

    previous = modelctx.get_model_cfg()
    try:
        for cfg, field in [
            (config("minimax"), "query"),
            (config("glm"), "search_query"),
            (config("qwen", "responses"), "input"),
            (config("qwen"), "messages"),
            (config("deepseek"), "count"),
            (config("mimo"), "tools"),
            (config("ollama"), "max_results"),
        ]:
            modelctx.set_model_cfg(cfg)
            signature = _tool_field_signature("web_search")
            assert field in signature
            assert "foreign_argument" not in signature
    finally:
        modelctx.set_model_cfg(previous)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,api_format,args,response,expected_path", [
    ("minimax", "openai", {"query": "测试"}, {"organic": [{"url": "https://example.com"}]}, "/v1/coding_plan/search"),
    ("glm", "openai", {"search_query": "测试", "search_engine": "search_std", "search_intent": False, "count": 5, "search_recency_filter": "oneDay"}, {"search_result": [{"link": "https://example.com"}]}, "/api/paas/v4/web_search"),
    ("qwen", "openai", {"messages": [{"role": "user", "content": "测试"}], "search_options": {"forced_search": True}}, {"choices": [{"message": {"content": "搜索答案"}}]}, "/compatible-mode/v1/chat/completions"),
    ("qwen", "responses", {"input": "测试", "max_output_tokens": 800}, {"output": [{"type": "web_search_call", "action": {"sources": [{"url": "https://example.com"}]}}]}, "/compatible-mode/v1/responses"),
])
async def test_provider_sends_native_arguments_and_preserves_native_results(monkeypatch, provider, api_format, args, response, expected_path):
    """验证实际 HTTP 请求，防止只改 Schema 却仍按统一字段发往上游。"""
    cfg = config(provider, api_format)
    adapter = web_search._adapter(cfg)
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json=response)

    monkeypatch.setattr(adapter, "resolve_pinned_ip", lambda _: ("93.184.216.34", None))
    monkeypatch.setattr(adapter, "PinnedHTTPTransport", lambda _: httpx.MockTransport(respond))
    assert await web_search.search(cfg, args) == response
    request = requests[0]
    assert request.url.path == expected_path
    assert request.headers["authorization"] == "Bearer synthetic-test-key"
    body = json.loads(request.content)
    if provider == "minimax":
        assert body == {"q": args["query"]}
    else:
        for key, value in args.items():
            assert body[key] == value
    if provider == "qwen":
        assert body["model"] == cfg.model
        if api_format == "responses":
            assert body["tools"] == [{"type": "web_search"}]
            assert body["store"] is False
        else:
            assert body["enable_search"] is True
            assert body["include_tool_usage"] is True


@pytest.mark.parametrize("provider", ["minimax", "qwen", "glm", "deepseek", "mimo", "ollama"])
def test_foreign_api_host_cannot_receive_provider_credentials(provider):
    assert not web_search.supports_web_search(config(provider, base_url="https://example.com/v1"))


def test_provider_switch_refreshes_restored_schema_without_rewriting_history():
    """MiniMax→GLM→百炼→MiniMax，含持久化重载及同 Provider 切协议。"""
    from agent.context.assembly.area import MessageArea
    from agent.context.canonical_tool_history import (
        append_event, refresh_model_tool_schemas, render_events_for_provider, tool_schema_event,
    )

    configs = [config("minimax"), config("glm"), config("qwen"), config("qwen", "responses"), config("deepseek"), config("mimo"), config("ollama"), config("minimax")]
    snapshots = [registry.snapshot_with_extras(model_cfg=cfg) for cfg in configs]
    history = []
    append_event(history, tool_schema_event(snapshots[0].get("web_search")))
    history.extend([
        {"role": "assistant", "content": [{"type": "tool_call", "id": "past-call", "name": "web_search", "arguments": {"query": "旧查询"}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_call_id": "past-call", "content": "旧结果"}]},
    ])
    for snapshot in snapshots[1:]:
        persisted = json.loads(json.dumps(history))
        area = MessageArea.from_canonical_messages(persisted)
        refresh_model_tool_schemas(area, snapshot, ["web_search"])
        current = tool_schema_event(snapshot.get("web_search"))
        assert area.entries[-1].canonical_message["content"][-1] == current.to_block()
        assert [entry.canonical_message for entry in area.entries[:-1]] == persisted
        assert area.persistence_delta(outcome="success").entries == ()
        rendered = render_events_for_provider(area.provider_projection()).to_messages()
        schema_text = json.dumps(current.schema, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        assert schema_text in rendered[-1]["content"][-1]["text"]
        before = len(area.entries)
        refresh_model_tool_schemas(area, snapshot, ["web_search"])
        assert len(area.entries) == before
        # 模拟本轮 get_tool_schema 的声明落库，下一轮从持久化历史重建。
        append_event(history, current)
        assert history[-1]["content"][-1] == current.to_block()
    assert len([block for message in history for block in message["content"] if block.get("type") == "tool-schema"]) == len(configs)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,api_format,args,result,path,header", [
    ("deepseek", "responses", {"query": "测试", "count": 5, "need_content": True, "ori_question": None, "localization": ""}, {"results": [{"summary": "原生摘要", "authority": 3}]}, "/v1/tools/search", "authorization"),
    ("ollama", "native", {"query": "测试", "max_results": 10}, {"results": [{"title": "原生结果", "url": "https://example.com"}]}, "/api/web_search", "authorization"),
    ("mimo", "anthropic", {"messages": [{"role": "user", "content": "测试"}], "tools": [{"type": "web_search", "max_keyword": 2, "force_search": True, "limit": 1, "user_location": {"type": "approximate", "country": "China"}}], "max_completion_tokens": 512}, {"choices": [{"message": {"content": "搜索答案", "annotations": [{"type": "url_citation", "url": "https://example.com"}]}}], "usage": {"web_search_usage": {"tool_usage": 2}}}, "/v1/chat/completions", "api-key"),
])
async def test_added_providers_send_native_payload_and_keep_sources(monkeypatch, provider, api_format, args, result, path, header):
    from agent.providers import search_http

    cfg = config(provider, api_format)
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json=result)

    monkeypatch.setattr(search_http, "resolve_pinned_ip", lambda _: ("93.184.216.34", None))
    monkeypatch.setattr(search_http, "PinnedHTTPTransport", lambda _: httpx.MockTransport(respond))
    assert await web_search.search(cfg, args) == result
    request = requests[0]
    assert request.url.path == path
    assert request.headers[header] == (cfg.api_key if header == "api-key" else f"Bearer {cfg.api_key}")
    payload = json.loads(request.content)
    for key, value in args.items():
        assert payload[key] == value
    if provider == "mimo":
        assert payload["model"] == cfg.model
        assert payload["stream"] is False
    else:
        assert payload == args


@pytest.mark.asyncio
async def test_search_injection_respects_switch_credentials_and_provider_requirements():
    from agent.tools.search import search_tool_is_configured

    for provider in ["minimax", "glm", "qwen", "deepseek", "mimo", "ollama"]:
        cfg = config(provider)
        assert await search_tool_is_configured("web_search", settings=SimpleNamespace(), model_cfg=cfg)
        cfg.web_search_enabled = False
        assert not await search_tool_is_configured("web_search", settings=SimpleNamespace(), model_cfg=cfg)
        cfg.web_search_enabled = True
        cfg.api_key = ""
        assert not await search_tool_is_configured("web_search", settings=SimpleNamespace(), model_cfg=cfg)
    local = config("ollama", base_url="http://localhost:11434/api")
    assert not await search_tool_is_configured("web_search", settings=SimpleNamespace(), model_cfg=local)
    unsupported = config("mimo")
    unsupported.model = "unsupported-model"
    assert not await search_tool_is_configured("web_search", settings=SimpleNamespace(), model_cfg=unsupported)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [302, 401, 429, 500])
async def test_search_http_does_not_follow_redirect_or_expose_upstream_errors(monkeypatch, status):
    from agent.providers import search_http

    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(status, headers={"Location": "https://example.com/collect"}, json={"error": {"message": "synthetic-private-diagnostic"}})

    monkeypatch.setattr(search_http, "resolve_pinned_ip", lambda _: ("93.184.216.34", None))
    monkeypatch.setattr(search_http, "PinnedHTTPTransport", lambda _: httpx.MockTransport(respond))
    result = await web_search.search(config("deepseek"), {"query": "测试"})
    assert "error" in result
    assert "synthetic-private-diagnostic" not in str(result)
    assert "synthetic-test-key" not in str(result)
    assert len(requests) == 1
