"""通过真实 SDK 与本地兼容传输验证流式、工具调用和超时路径，不访问外部服务。"""
import asyncio
import json
from types import SimpleNamespace

import httpx
import httpx2
import pytest


def _sse(events):
    return "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"


def test_openai_sdk_streams_tool_call_against_openai_compatible_transport():
    from openai import AsyncOpenAI

    requests = []

    async def handler(request):
        requests.append(request)
        assert request.url.path == "/v1/chat/completions"
        payload = json.loads(request.content)
        assert payload["stream"] is True
        assert payload["tools"][0]["function"]["name"] == "lookup"
        chunks = [
            {"id": "chatcmpl-test", "object": "chat.completion.chunk", "created": 1, "model": "test",
             "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "call_1",
                     "type": "function", "function": {"name": "lookup", "arguments": json.dumps({"q": "tea"})}}]},
                 "finish_reason": None}]},
            {"id": "chatcmpl-test", "object": "chat.completion.chunk", "created": 1, "model": "test",
             "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
        ]
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=_sse(chunks))

    async def exercise():
        transport = httpx2.AsyncClient(
            transport=httpx2.MockTransport(handler),
            timeout=httpx2.Timeout(connect=2, read=5, write=3, pool=1),
        )
        async with AsyncOpenAI(api_key="local-test", base_url="https://compatible.test/v1", http_client=transport) as client:
            stream = await client.chat.completions.create(
                model="test-model", messages=[{"role": "user", "content": "lookup tea"}],
                tools=[{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}],
                stream=True,
            )
            chunks = [chunk async for chunk in stream]
            call = chunks[0].choices[0].delta.tool_calls[0]
            assert call.function.name == "lookup"
            assert json.loads(call.function.arguments) == {"q": "tea"}
            assert chunks[-1].choices[0].finish_reason == "tool_calls"

    asyncio.run(exercise())
    assert len(requests) == 1


def test_anthropic_sdk_streams_tool_call_against_anthropic_compatible_transport():
    from anthropic import AsyncAnthropic

    requests = []

    async def handler(request):
        requests.append(request)
        assert request.url.path == "/v1/messages"
        payload = json.loads(request.content)
        assert payload["stream"] is True
        assert payload["tools"][0]["name"] == "lookup"
        events = [
            {"type": "message_start", "message": {"id": "msg_test", "type": "message", "role": "assistant",
             "content": [], "model": "test-model", "stop_reason": None, "stop_sequence": None,
             "usage": {"input_tokens": 10, "output_tokens": 1}}},
            {"type": "content_block_start", "index": 0, "content_block":
             {"type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {}}},
            {"type": "content_block_delta", "index": 0, "delta":
             {"type": "input_json_delta", "partial_json": json.dumps({"q": "tea"})}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None},
             "usage": {"output_tokens": 4}},
            {"type": "message_stop"},
        ]
        body = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events)
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=body)

    async def exercise():
        transport = httpx2.AsyncClient(
            transport=httpx2.MockTransport(handler),
            timeout=httpx2.Timeout(connect=2, read=5, write=3, pool=1),
        )
        async with AsyncAnthropic(api_key="local-test", base_url="https://compatible.test", http_client=transport) as client:
            async with client.messages.stream(
                model="test-model", max_tokens=128,
                messages=[{"role": "user", "content": "lookup tea"}],
                tools=[{"name": "lookup", "input_schema": {"type": "object"}}],
            ) as stream:
                final = await stream.get_final_message()
            tool = final.content[0]
            assert tool.type == "tool_use"
            assert tool.name == "lookup"
            assert tool.input == {"q": "tea"}
            assert final.stop_reason == "tool_use"

    asyncio.run(exercise())
    assert len(requests) == 1


@pytest.mark.parametrize("sdk", ["openai", "anthropic"])
def test_sdk_classifies_transport_timeout(sdk):
    from anthropic import AsyncAnthropic
    from openai import AsyncOpenAI

    async def handler(_request):
        raise httpx2.ReadTimeout("local timeout")

    async def exercise():
        transport = httpx2.AsyncClient(
            transport=httpx2.MockTransport(handler),
            timeout=httpx2.Timeout(connect=1, read=0.01, write=1, pool=1),
        )
        client_type = AsyncOpenAI if sdk == "openai" else AsyncAnthropic
        client = client_type(api_key="local-test", base_url="https://compatible.test", http_client=transport)
        try:
            if sdk == "openai":
                await client.chat.completions.create(model="test-model", messages=[{"role": "user", "content": "x"}])
            else:
                await client.messages.create(model="test-model", max_tokens=8,
                                             messages=[{"role": "user", "content": "x"}])
        except Exception as error:
            expected = (httpx2.TimeoutException,)
            assert isinstance(error, expected) or error.__class__.__name__ in {"APITimeoutError", "APIConnectionError"}
        else:
            raise AssertionError("SDK 应将传输超时作为请求错误返回")
        finally:
            await client.close()

    asyncio.run(exercise())


def test_provider_builders_translate_timeout_objects_for_sdk_major_versions(monkeypatch):
    from agent import providers

    captured = {}
    monkeypatch.setattr("openai.AsyncOpenAI", lambda **kwargs: captured.setdefault("openai", kwargs))
    monkeypatch.setattr("anthropic.AsyncAnthropic", lambda **kwargs: captured.setdefault("anthropic", kwargs))
    ai = SimpleNamespace(provider="custom", api_key="local-test", base_url="https://compatible.test/v1")
    timeout = httpx.Timeout(connect=4, read=20, write=6, pool=2)

    providers.build_openai_client(ai, timeout)
    openai_timeout = captured["openai"]["timeout"]
    assert isinstance(openai_timeout, httpx2.Timeout)
    assert (openai_timeout.connect, openai_timeout.read, openai_timeout.write, openai_timeout.pool) == (4, 20, 6, 2)

    providers.build_anthropic_client(ai, timeout)
    assert captured["anthropic"]["timeout"] == 20
