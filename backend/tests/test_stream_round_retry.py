"""`_stream_round` 的 provider 专属重试白名单测试（PRD-LLM-1 FR-LLM-4）。

复现 2026-07-14 QQ「重写 PRD README/INDEX」故障的最小回归用例：官方 anthropic SDK 流式
消费内部遇到 `usage=None` 时抛 `AttributeError`（`gugu-diag.log` 实测 traceback，见
docs/product/PRD/PRD-LLM-1-provider适配层重构与core瘦身.md）。这里不真的引入 SDK、也不
真的等退避秒数，用假 `client.messages.stream` 模拟同样的异常时序，验证：
1. 传 MiniMax 适配器时，AttributeError 被当瞬时错误重试、重试成功后正常吐出内容；
2. 传 MiniMax 适配器但连续失败到用尽重试预算 → 抛 RetryableError（不是原样冒泡）；
3. **不传适配器 / 传 default 适配器时，同样的 AttributeError 不会被重试**——钉死「只对
   MiniMax 生效，不全局放宽」这条设计红线。
"""
import asyncio
from types import SimpleNamespace

import pytest

from agent.core import _stream_round
from agent.providers import adapter_for
from app.core.errors import RetryableError

_MINIMAX_ADAPTER = adapter_for(SimpleNamespace(provider="minimax"))
_DEFAULT_ADAPTER = adapter_for(SimpleNamespace(provider="anthropic"))


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """重试测试不用真等退避秒数——把 asyncio.sleep 打成立即返回，只验证调用次数/行为。"""
    async def _fast_sleep(_seconds):
        return None
    monkeypatch.setattr(asyncio, "sleep", _fast_sleep)


class _FakeFinalMessage:
    def __init__(self):
        self.usage = SimpleNamespace(input_tokens=1, output_tokens=1, cache_read_input_tokens=0)
        self.content = []


class _FakeStreamCtx:
    """模拟 `async with client.messages.stream(**kwargs) as stream:`——`should_raise` 为真时，
    迭代 `text_stream` 直接抛 AttributeError（对齐 SDK accumulate_event() 遇 usage=None 崩溃
    的真实位置：崩在事件累加阶段，emitted 守卫应判定为「还没吐过 token」）。"""
    def __init__(self, should_raise: bool):
        self.should_raise = should_raise

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    @property
    def text_stream(self):
        return self._iter()

    async def _iter(self):
        if self.should_raise:
            raise AttributeError("'NoneType' object has no attribute 'output_tokens'")
        yield "hello"

    async def get_final_message(self):
        return _FakeFinalMessage()


class _FakeMessages:
    def __init__(self, fail_times: int):
        self.fail_times = fail_times
        self.calls = 0

    def stream(self, **kwargs):
        should_raise = self.calls < self.fail_times
        self.calls += 1
        return _FakeStreamCtx(should_raise)


class _FakeClient:
    def __init__(self, fail_times: int):
        self.messages = _FakeMessages(fail_times)


async def _drain(gen):
    tokens = []
    final = None
    async for kind, val in gen:
        if kind == "token":
            tokens.append(val)
        else:
            final = val
    return tokens, final


async def test_minimax_attribute_error_retries_then_succeeds():
    client = _FakeClient(fail_times=2)   # 前两次抛 AttributeError，第三次正常
    tokens, final = await _drain(_stream_round(client, {}, _MINIMAX_ADAPTER))
    assert tokens == ["hello"]
    assert final is not None
    assert client.messages.calls == 3


async def test_minimax_attribute_error_exhausts_to_retryable():
    client = _FakeClient(fail_times=99)   # 一直失败，超过统一重试预算
    with pytest.raises(RetryableError):
        await _drain(_stream_round(client, {}, _MINIMAX_ADAPTER))


async def test_overloaded_529_retries_up_to_shared_budget(monkeypatch):
    """2026-09-18 MiniMax 高峰 529 连穿回归：OverloadedError 必须进重试循环，
    节奏=共享 RetryPolicy（max_retries 次重试 → 共 max_retries+1 次尝试）。"""
    import httpx
    import anthropic

    from app.core.retry import LLM_RETRY

    def _overload_error():
        resp = httpx.Response(529, request=httpx.Request("POST", "https://mcp.example"))
        return anthropic.OverloadedError("529 overloaded", response=resp, body=None)

    class _OverloadStreamCtx(_FakeStreamCtx):
        async def _iter(self):
            raise _overload_error()
            yield ""   # pragma: no cover

    class _OverloadMessages(_FakeMessages):
        def stream(self, **kwargs):
            self.calls += 1
            return _OverloadStreamCtx(should_raise=True)

    class _Client:
        def __init__(self):
            self.messages = _OverloadMessages(99)

    import agent.loop.provider as provider_mod
    from app.core.retry import RetryPolicy
    monkeypatch.setattr(provider_mod, "LLM_RETRY", RetryPolicy(interval_seconds=0.0))
    client = _Client()
    with pytest.raises(RetryableError) as exc_info:
        await _drain(_stream_round(client, {}, _MINIMAX_ADAPTER))
    # 首次 + LLM_RETRY.max_retries 次重试
    assert client.messages.calls == LLM_RETRY.max_retries + 1
    assert isinstance(exc_info.value.cause, anthropic.OverloadedError)


async def test_retry_wall_clock_cap_stops_before_attempt_budget(monkeypatch):
    """超时类错误每次尝试烧满读超时：总墙钟上限先到为准，不再硬吃满次数。"""
    import time as _time

    import anthropic

    from app.core.retry import LLM_RETRY

    import agent.loop.provider as provider_mod
    from app.core.retry import RetryPolicy
    monkeypatch.setattr(provider_mod, "LLM_RETRY", RetryPolicy(interval_seconds=0.0))
    real_monotonic = _time.monotonic
    clock = {"t": real_monotonic()}
    # 全局打点（app.core.retry 与 loop.provider 引用同一个 time 模块）：
    # 每次失败推进 100s，模拟「每次尝试烧满一个读超时」
    monkeypatch.setattr(_time, "monotonic", lambda: clock["t"])

    class _TimeoutMessages(_FakeMessages):
        def stream(self, **kwargs):
            self.calls += 1
            clock["t"] += 100.0
            raise anthropic.APITimeoutError("read timed out")

    class _Client:
        def __init__(self):
            self.messages = _TimeoutMessages(99)

    client = _Client()
    with pytest.raises(RetryableError):
        await _drain(_stream_round(client, {}, _MINIMAX_ADAPTER))
    # 第一次失败后墙钟即超限：尝试次数远少于满额
    assert client.messages.calls < LLM_RETRY.max_retries + 1


async def test_default_adapter_attribute_error_not_retried():
    """非 MiniMax（default 适配器）遇到同样的 AttributeError——不在白名单里，
    应该原样冒泡，而不是被当成瞬时错误重试/包装成 RetryableError。"""
    client = _FakeClient(fail_times=1)
    with pytest.raises(AttributeError):
        await _drain(_stream_round(client, {}, _DEFAULT_ADAPTER))
    assert client.messages.calls == 1   # 没有重试


async def test_no_adapter_attribute_error_not_retried():
    """`adapter=None`（未传）时行为等价于 default——同样不重试 AttributeError。"""
    client = _FakeClient(fail_times=1)
    with pytest.raises(AttributeError):
        await _drain(_stream_round(client, {}))
    assert client.messages.calls == 1


# ── OpenAIDriver：统一重试节奏覆盖 openai 兼容链路（2026-09-18 补齐）─────────────

def _openai_ctx_stub():
    from types import SimpleNamespace as _NS
    return _NS(
        model="deepseek-chat", max_tokens=100, think_kwargs={}, tools=[],
        supports_active_cache=False, supports_explicit_cache=False,
        adapter=_NS(
            render_history=lambda messages: list(messages),
            uses_single_history_cache_anchor=lambda _m: False,
            build_tool_params=lambda ai, tools: {},
            build_openai_cache_kwargs=lambda ai: {},
        ),
        ai=_NS(model="deepseek-chat", provider="deepseek"),
    )


def _openai_content_chunk(text: str):
    return SimpleNamespace(
        usage=None,
        choices=[SimpleNamespace(delta=SimpleNamespace(
            content=text, reasoning_content=None, tool_calls=[]))],
    )


def _openai_rate_limit_error():
    import httpx
    import openai
    resp = httpx.Response(429, request=httpx.Request("POST", "https://api.example/v1"))
    return openai.RateLimitError("429 rate limited", response=resp, body=None)


class _FlakyOpenAIClient:
    """create 前 N 次抛瞬时错误，之后返回正常流。"""

    def __init__(self, fail_times: int):
        self.fail_times = fail_times
        self.calls = 0

    async def _create(self, **_kwargs):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise _openai_rate_limit_error()
        chunk = SimpleNamespace(
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=1,
                                  prompt_cache_hit_tokens=0,
                                  prompt_tokens_details=None),
            choices=[SimpleNamespace(delta=SimpleNamespace(
                content="ok", reasoning_content=None, tool_calls=[]))],
        )

        class _Stream:
            async def close(self):
                pass

            def __aiter__(self):
                return self

            async def __anext__(self):
                if not getattr(self, "_done", False):
                    self._done = True
                    return chunk
                raise StopAsyncIteration

        return _Stream()

    @property
    def chat(self):
        return SimpleNamespace(completions=SimpleNamespace(create=self._create))


async def _drain_openai(client):
    from agent.loop_drivers import OpenAIDriver

    tokens = []
    events = []
    async for kind, val in OpenAIDriver().run_round(client, _openai_ctx_stub(), []):
        if kind == "token":
            tokens.append(val)
        elif kind == "retry":
            events.append(val)
    return tokens, events


async def test_openai_driver_retries_transient_then_succeeds(monkeypatch):
    import agent.loop_drivers as drivers_mod
    from app.core.retry import RetryPolicy

    monkeypatch.setattr(drivers_mod, "LLM_RETRY", RetryPolicy(interval_seconds=0.0))
    client = _FlakyOpenAIClient(fail_times=2)
    tokens, events = await _drain_openai(client)
    assert tokens == ["ok"]
    assert client.calls == 3
    assert [e["attempt"] for e in events] == [1, 2]
    assert events[0]["error_kind"] == "rate_limited"


async def test_openai_driver_exhausts_to_retryable(monkeypatch):
    import agent.loop_drivers as drivers_mod
    from app.core.retry import RetryPolicy
    from app.core.errors import RetryableError

    monkeypatch.setattr(drivers_mod, "LLM_RETRY", RetryPolicy(interval_seconds=0.0, max_retries=2))
    client = _FlakyOpenAIClient(fail_times=99)
    with pytest.raises(RetryableError) as exc_info:
        await _drain_openai(client)
    assert client.calls == 3   # 首次 + 2 次重试
    assert isinstance(exc_info.value.cause, Exception)


async def test_upstream_busy_status_matches_both_sdks():
    """忙碌判定按状态码与 SDK 解耦：anthropic 529 与 openai 429 都算忙。"""
    import httpx
    import anthropic
    import openai

    from agent.providers.errors import upstream_busy_status

    a_resp = httpx.Response(529, request=httpx.Request("POST", "https://x"))
    assert upstream_busy_status(anthropic.OverloadedError("529", response=a_resp, body=None)) is True
    o_resp = httpx.Response(429, request=httpx.Request("POST", "https://x"))
    assert upstream_busy_status(openai.RateLimitError("429", response=o_resp, body=None)) is True
    o_500 = httpx.Response(500, request=httpx.Request("POST", "https://x"))
    assert upstream_busy_status(openai.InternalServerError("500", response=o_500, body=None)) is False


# ── SDK 流式解析越界的降级兜底（2026-09-18 生产 anthropic 1.6.0 7 连发）──────────
# accumulate_event content[index] 越界 IndexError 不是瞬时网络错误，重试同一流式通道
# 大概率再崩；未吐 token 时应整轮降级 non-streaming 重发。

class _IndexErrorStreamCtx(_FakeStreamCtx):
    async def _iter(self):
        raise IndexError("list index out of range")
        yield ""   # pragma: no cover


class _EmittedThenIndexCtx(_FakeStreamCtx):
    async def _iter(self):
        yield "hello"
        raise IndexError("list index out of range")


class _CreateMessages(_FakeMessages):
    def __init__(self, fail_times: int):
        super().__init__(fail_times)
        self.create_calls = 0

    def stream(self, **kwargs):
        self.calls += 1
        return _IndexErrorStreamCtx(should_raise=True)

    async def create(self, **kwargs):
        self.create_calls += 1
        return _FakeFinalMessage()


async def test_index_error_falls_back_to_non_streaming():
    """无 adapter 时流式解析越界：不重试流式，降级 non-streaming 拿到完整消息。"""
    client = SimpleNamespace(messages=_CreateMessages(fail_times=99))
    tokens, final = await _drain(_stream_round(client, {}))
    assert tokens == []
    assert final is not None
    assert client.messages.calls == 1
    assert client.messages.create_calls == 1


async def test_index_error_after_emitted_raises_through():
    """已吐过 token 的解析越界不能降级重发（会重复输出），原样抛给上层。"""
    class _Messages(_CreateMessages):
        def stream(self, **kwargs):
            self.calls += 1
            return _EmittedThenIndexCtx(should_raise=False)

    client = SimpleNamespace(messages=_Messages(fail_times=99))
    with pytest.raises(IndexError):
        await _drain(_stream_round(client, {}))
    assert client.messages.create_calls == 0


class _FlakyIndexMessages(_FakeMessages):
    """前 fail_times 次抛 IndexError，之后正常吐 token；记录 create 调用次数。"""

    def __init__(self, fail_times: int):
        super().__init__(fail_times)
        self.create_calls = 0

    def stream(self, **kwargs):
        should_raise = self.calls < self.fail_times
        self.calls += 1
        if should_raise:
            return _IndexErrorStreamCtx(should_raise=True)
        return _FakeStreamCtx(should_raise=False)

    async def create(self, **kwargs):
        self.create_calls += 1
        return _FakeFinalMessage()


async def test_minimax_index_error_keeps_transient_retry_semantics():
    """adapter 已把 IndexError 声明为瞬时的（MiniMax）维持重试语义，不走降级分支。"""
    client = SimpleNamespace(messages=_FlakyIndexMessages(fail_times=2))
    tokens, final = await _drain(_stream_round(client, {}, _MINIMAX_ADAPTER))
    assert tokens == ["hello"]
    assert final is not None
    assert client.messages.calls == 3
    assert client.messages.create_calls == 0
