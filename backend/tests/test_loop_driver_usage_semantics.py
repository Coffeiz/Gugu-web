"""LoopDriver usage 口径回归测试。

两条 provider 路径的 usage 语义不同，RoundResult 必须统一成：
usage_in = 未命中缓存的新增输入，cache_tokens = 缓存命中，两者相加才是总输入。

- Anthropic：split 口径，input_tokens 天然不含 cache_read_input_tokens，直接透传。
- OpenAI 兼容（DeepSeek/Qwen/OpenAI）：prompt_tokens 已包含缓存命中
  （prompt = hit + miss），必须在驱动层扣掉，否则统计层 tokens_in + cache_read
  会把命中部分重复计入总量、缓存率分母虚大（PR #42 审核发现的 P1）。
"""
from types import SimpleNamespace

import pytest

from agent.loop_drivers import AnthropicDriver, OpenAIDriver


def _openai_ctx():
    return SimpleNamespace(
        model="deepseek-chat", max_tokens=100,
        think_kwargs={}, tools=[],
        supports_active_cache=False, supports_explicit_cache=False,
        adapter=SimpleNamespace(
            render_history=lambda messages: list(messages),
            uses_single_history_cache_anchor=lambda _model: False,
            build_tool_params=lambda ai, tools: {},
            build_openai_cache_kwargs=lambda ai: {},
        ),
        ai=SimpleNamespace(model="deepseek-chat"),
    )


class _FakeOpenAIStream:
    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        self._iter = iter(self._chunks)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class _FakeOpenAIClient:
    def __init__(self, chunks):
        self._chunks = chunks
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **_kwargs):
        return _FakeOpenAIStream(self._chunks)


async def _collect_openai(chunks):
    driver = OpenAIDriver()
    client = _FakeOpenAIClient(chunks)
    result = None
    async for kind, val in driver.run_round(client, _openai_ctx(), []):
        if kind == "done":
            result = val
    return result


@pytest.mark.asyncio
async def test_openai_prompt_tokens_subtracts_deepseek_cache_hit():
    # DeepSeek 语义：prompt_tokens=100 包含 cache_hit=80 → usage_in 应为 20
    chunk = SimpleNamespace(
        usage=SimpleNamespace(prompt_tokens=100, completion_tokens=5,
                              prompt_cache_hit_tokens=80,
                              prompt_tokens_details=None),
        choices=[],
    )
    result = await _collect_openai([chunk])
    assert result.usage_in == 20
    assert result.cache_tokens == 80
    assert result.usage_out == 5


@pytest.mark.asyncio
async def test_openai_prompt_tokens_subtracts_details_cached_tokens():
    # OpenAI/Qwen 语义：prompt_tokens_details.cached_tokens 是 prompt_tokens 的子集
    chunk = SimpleNamespace(
        usage=SimpleNamespace(prompt_tokens=100, completion_tokens=5,
                              prompt_cache_hit_tokens=0,
                              prompt_tokens_details=SimpleNamespace(cached_tokens=60)),
        choices=[],
    )
    result = await _collect_openai([chunk])
    assert result.usage_in == 40
    assert result.cache_tokens == 60


@pytest.mark.asyncio
async def test_openai_no_cache_keeps_prompt_tokens():
    chunk = SimpleNamespace(
        usage=SimpleNamespace(prompt_tokens=100, completion_tokens=5,
                              prompt_cache_hit_tokens=0,
                              prompt_tokens_details=None),
        choices=[],
    )
    result = await _collect_openai([chunk])
    assert result.usage_in == 100
    assert result.cache_tokens == 0


@pytest.mark.asyncio
async def test_anthropic_split_usage_passes_through(monkeypatch):
    # Anthropic 口径：input_tokens 本来就不含 cache_read，必须原样透传，不能再扣
    import agent.core as core

    final = SimpleNamespace(
        content=[],
        usage=SimpleNamespace(input_tokens=20, output_tokens=5,
                              cache_read_input_tokens=80),
    )

    async def fake_stream_round(_client, _kwargs, _adapter):
        yield ("final", final)

    monkeypatch.setattr(core, "_stream_round", fake_stream_round)
    ctx = SimpleNamespace(
        model="claude-fake", max_tokens=100, tools=[],
        system_param={}, thinking_param={}, generation_param={},
        supports_active_cache=False,
        adapter=SimpleNamespace(render_history=lambda messages: list(messages)),
    )
    driver = AnthropicDriver()
    result = None
    async for kind, val in driver.run_round(object(), ctx, []):
        if kind == "done":
            result = val
    assert result.usage_in == 20
    assert result.cache_tokens == 80
    assert result.usage_out == 5
