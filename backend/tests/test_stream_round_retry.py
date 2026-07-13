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
    client = _FakeClient(fail_times=99)   # 一直失败，超过 _RETRY_BACKOFF 长度
    with pytest.raises(RetryableError):
        await _drain(_stream_round(client, {}, _MINIMAX_ADAPTER))


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
