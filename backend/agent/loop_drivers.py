"""LLM 主循环的 provider 驱动层（PRD-LLM-1 Phase 2）。

`agent/core.py` 的 `_run_anthropic`/`_run_openai` 曾经是两条完整独立的循环，控制流
（工具调用/核实阶段状态机/三条防幻觉守卫/空回复兜底/轮次上限）逐字复制了约 90%，
真正不同的只是"怎么跟这个 provider 打交道"这几件事：

1. 流式事件形状——Anthropic SDK 给的是已解析好的 `final.content` 块列表；OpenAI
   给的是要自己手动拼的原始 delta 片段。
2. 工具调用参数——Anthropic 已经是解析好的 dict；OpenAI 是要 `json.loads()` 的字符串，
   还有一段处理"JSON 被截断"的专属容错，Anthropic 那边完全不存在这个问题。
3. 历史消息格式——Anthropic 的 assistant 消息是 `content:[多个块]`，工具结果打包成
   一条 user 消息里的多个 tool_result 块；OpenAI 的 assistant 消息是
   `content:字符串`+`tool_calls:[...]`，每个工具结果各自一条独立的 `role:"tool"` 消息。
4. 缓存/思考记账——字段名和语义都不完全一样。

这个文件把这几件事收拢成两个 `LoopDriver` 实现（`AnthropicDriver`/`OpenAIDriver`），
`core.py` 只写一条共享的 `_run_loop`，需要跟 provider 打交道时调用驱动。

驱动接口四个方法：
- `prepare(tool_names, ai, messages, system_text)`：调用一次的一次性准备（建 client、
  算 tools schema/缓存能力/思考参数），返回 `(client, ctx)`。
- `run_round(client, ctx, messages)`：跑一轮，是个 async generator——流式 yield
  `("token", str)`，最后 yield `("done", RoundResult)`。
- `append_tool_round(messages, result, dispatched)`：把这一轮的 assistant 消息 + 工具
  结果消息追加进 `messages`（原地修改）——两边格式差异大，整段交给驱动自己拼，不硬拆。
- `append_followup(messages, result, next_content, assistant_fallback="（…）")`：核实
  prompt / 三条守卫 nudge 共用的形状——都是"这轮的 assistant 文本 + 一条后续 user
  提示"，只有提示内容不一样。`assistant_fallback` 是 assistant 内容为空时的占位——
  两边各自的占位规则跟改动前逐条对齐，见各自实现里的注释。
- `append_empty_retry(messages, result)`：空回复追问兜底单独一个方法——两边这里
  "assistant 是否入历史"本身就不一样（Anthropic 入、OpenAI 不入），不是同一个形状
  加参数能糊过去的，改动前就是这样，这里原样保留。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Protocol

from app.core.errors import RetryableError
from app.core.redaction import diag_log

_log = logging.getLogger("agent.core")

# OpenAI 路工具参数 JSON 截断（多为 max_tokens 截断）的统一错误文案——两边共用同一份文字，
# 只是各自的 append_tool_round 决定怎么包装成 tool_result 消息。
TOOL_ARGS_TRUNCATED_ERROR = json.dumps(
    {"error": "参数不完整（内容可能过长被截断），请精简这次调用的参数后重试"}, ensure_ascii=False)


@dataclass
class NormalizedToolCall:
    id: str
    name: str
    input: dict
    parse_error: bool = False   # 只有 OpenAI 路会真的置真（JSON 截断解析失败）


@dataclass
class RoundResult:
    text: str                          # 本轮纯文本正文（不含工具调用/思考）
    tool_calls: list = field(default_factory=list)   # list[NormalizedToolCall]
    usage_in: int = 0
    usage_out: int = 0
    cache_tokens: int = 0              # 统一映射：anthropic 的 cache_read_input_tokens /
                                        # deepseek 的 prompt_cache_hit_tokens，对外 SSE 字段名
                                        # 两边本来就都叫 cache_read，这里合并成一个字段不改变行为。
    raw: Any = None                    # 驱动私有：给 append_* 方法用的原始数据


class LoopDriver(Protocol):
    api_format: str

    def prepare(self, tool_names: list[str], ai, messages: list, system_text: str | None): ...
    def run_round(self, client, ctx, messages: list) -> AsyncGenerator[tuple, None]: ...
    def append_tool_round(self, messages: list, result: RoundResult, dispatched: list) -> None: ...
    def append_followup(self, messages: list, result: RoundResult, next_content: str,
                          assistant_fallback: str = "（…）") -> None: ...
    def append_empty_retry(self, messages: list, result: RoundResult) -> None: ...


# ══════════════════════════════════════════════════════════════════════════
# Anthropic（MiniMax / Anthropic 原生，走 anthropic 块格式）
# ══════════════════════════════════════════════════════════════════════════

@dataclass
class _AnthropicCtx:
    tools: list
    max_tokens: int
    temperature: float
    thinking_param: dict
    system_param: Any
    supports_active_cache: bool
    adapter: Any
    model: str


def _with_history_cache(messages: list) -> list:
    """MiniMax 被动缓存模式下不需要给消息历史加 cache_control。

    MiniMax 服务端会自动识别重复内容并缓存，无需客户端显式标记。
    此函数保留为 Anthropic 原生 API 使用（主动缓存模式）。
    对于 MiniMax，直接返回原始消息即可。"""
    # 被动缓存：不添加 cache_control，让 MiniMax 自动处理
    return messages


class AnthropicDriver:
    api_format = "anthropic"

    def prepare(self, tool_names, ai, messages, system_text):
        import httpx
        from agent import providers
        from agent.context import builder as _builder
        from agent.llm.llm_select import supports_anthropic_active_cache, _is_mimo
        from agent.tools import registry

        tools = registry.anthropic_schemas(tool_names)
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        is_mimo = _is_mimo(ai)
        supports_active_cache = supports_anthropic_active_cache(ai)
        adapter = providers.adapter_for(ai)
        client = providers.build_anthropic_client(ai, _timeout)

        thinking_val = getattr(ai, "thinking", "disabled")
        if is_mimo:
            # mimo 的 thinking 取值用文档确认的 disabled；想开就不传、用其默认（避免猜它的 enable 取值）
            thinking_param = {"thinking": {"type": "disabled"}} if thinking_val != "adaptive" else {}
        else:
            thinking_param = {"thinking": {"type": thinking_val}} if thinking_val == "adaptive" else {}

        # prompt 缓存：MiniMax 被动缓存模式（2026-08-19 优化）
        # MiniMax 文档说明：
        #   被动缓存（推荐）- API 自动识别重复内容，无需 cache_control，需要 ≥512 tokens
        #   主动缓存（Anthropic 兼容）- 需要显式 cache_control，MiniMax-M3 不支持
        # 实测对比（test_cache_mode_compare.py）：
        #   主动缓存 Round 1: cache_read=128（几乎无效）
        #   被动缓存 Round 1: cache_read=391（效果好得多）
        # Qwen-paw 缓存率 98.7%，MiniMax 之前只有72.2%，差距主要来自主动缓存的 Round 1 损失。
        # 移除所有 cache_control，让 MiniMax 服务端自动管理缓存。
        if system_text:
            stripped = _builder.strip_cache_marker(system_text)
            # 被动缓存：不添加 cache_control，让 MiniMax 自动处理
            system_param = stripped
        else:
            system_param = system_text

        ctx = _AnthropicCtx(
            tools=tools, max_tokens=ai.max_tokens, temperature=ai.temperature,
            thinking_param=thinking_param, system_param=system_param,
            supports_active_cache=supports_active_cache, adapter=adapter, model=ai.model,
        )
        return client, ctx

    async def run_round(self, client, ctx, messages):
        from agent.core import _stream_round   # 延迟 import 避免循环依赖（core.py 反过来 import 本模块）

        # ② 给发出去的 messages 打一个滚动缓存断点（每条 message 的最后一个块）：多轮工具循环里
        #    历史越滚越长，缓存住已发生的几轮、每轮只重算新增。用副本、不改原 messages（原列表要持久化，
        #    绝不能混入 cache_control，否则下次加载历史会带着旧断点、累积超过 4 个上限）。
        _msgs = _with_history_cache(messages) if ctx.supports_active_cache else messages
        kwargs = dict(
            model=ctx.model, system=ctx.system_param, messages=_msgs,
            tools=ctx.tools, max_tokens=ctx.max_tokens, temperature=ctx.temperature,
            **ctx.thinking_param,
        )
        final = None
        async for kind, val in _stream_round(client, kwargs, ctx.adapter):
            if kind == "final":
                final = val
                break
            yield ("token", val)

        tool_blocks = [b for b in final.content if b.type == "tool_use"]
        text = "".join(b.text for b in final.content if b.type == "text")
        tool_calls = [NormalizedToolCall(id=b.id, name=b.name, input=b.input) for b in tool_blocks]
        yield ("done", RoundResult(
            text=text, tool_calls=tool_calls,
            usage_in=final.usage.input_tokens, usage_out=final.usage.output_tokens,
            cache_tokens=getattr(final.usage, "cache_read_input_tokens", 0) or 0,
            raw=final.content,
        ))

    def _content_dicts(self, result: RoundResult) -> list:
        return [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in result.raw]

    def append_tool_round(self, messages, result, dispatched):
        # 序列化为 dict：让 messages 列表 JSON 可序列化（便于持久化），
        # 同时保留 thinking blocks（MiniMax / Anthropic 多轮时原样回传）
        messages.append({"role": "assistant", "content": self._content_dicts(result)})
        tool_results = [{"type": "tool_result", "tool_use_id": tc.id, "content": res} for tc, res in dispatched]
        messages.append({"role": "user", "content": tool_results})

    def append_followup(self, messages, result, next_content, assistant_fallback="（…）"):
        messages.append({"role": "assistant", "content": self._content_dicts(result)})
        messages.append({"role": "user", "content": next_content})

    def append_empty_retry(self, messages, result):
        # 占位保证 user/assistant 交替合法（真·空 content 会被 Anthropic 拒）；
        # 这条守卫消息不入历史（tool_rounds_only 过滤）
        content_dicts = self._content_dicts(result) or [{"type": "text", "text": "（…）"}]
        messages.append({"role": "assistant", "content": content_dicts})
        messages.append({"role": "user", "content": "（把要回复用户的话直接说出来就好，别只在心里想。）"})


# ══════════════════════════════════════════════════════════════════════════
# OpenAI（小米 MiMo / DeepSeek / 其它 OpenAI 兼容厂商，走 openai 格式）
# ══════════════════════════════════════════════════════════════════════════

@dataclass
class _OpenAICtx:
    tools: list
    max_tokens: int
    temperature: float
    think_extra: dict
    model: str


@dataclass
class _OpenAIRaw:
    """驱动私有：append_* 需要的这一轮原始数据——content/reasoning 是给下一轮历史消息用的，
    tool_calls_payload 是给 OpenAI `tool_calls` 字段用的原始形状（跟 NormalizedToolCall 分开存，
    因为后者的 .input 已经是解析后的 dict，OpenAI 历史消息里 tool_calls.function.arguments
    要求的是原始未解析字符串）。"""
    content: str
    reasoning: str
    tool_calls_payload: list


class OpenAIDriver:
    api_format = "openai"

    def prepare(self, tool_names, ai, messages, system_text):
        import httpx
        from agent import providers
        from agent.context import builder as _builder
        from agent.llm.llm_select import supports_thinking_toggle, _is_deepseek
        from agent.tools import registry

        # system 里可能带 builder 的缓存断点标记（CACHE_BREAK）——openai 通道不支持 anthropic 式
        # cache_control，去掉它还原成普通 system 串（标记仅出现在 system 消息里，每轮重建、
        # 改它无副作用）。这段是一次性的（调用方已经把 system 拼进 messages[0]，不是走 system_text
        # 参数——_run_openai 现状就不接 system_text，这里原样保留这个既有行为，不是本次改动引入的）。
        for _m in messages:
            if _m.get("role") == "system" and isinstance(_m.get("content"), str) and _builder.CACHE_BREAK in _m["content"]:
                _m["content"] = _builder.strip_cache_marker(_m["content"])

        tools = registry.openai_schemas(tool_names)
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        client = providers.build_openai_client(ai, _timeout)

        # 思考开关：mimo 与 deepseek 都用同一 OpenAI 参数 `{"thinking":{"type":...}}`（见各自官方文档）。
        # 思考关时显式传 disabled——mimo 从源头避免「正文全进 reasoning_content、content 空」的空气泡，
        # deepseek 则省下推理 token/延迟。思考开（adaptive）则不传、用厂商默认（两家默认都是开），靠
        # 空回复兜底。仅对支持该参数的厂商发（qwen/openai 没这参数，传了可能报错）。
        # 思考开（adaptive）时，DeepSeek 还可带「思考强度」reasoning_effort（high/max；思考模式下
        # temperature 失效，effort 是唯一质量/成本旋钮）。mimo 文档无此参数，故只对 deepseek 发。
        think_extra = {}
        if supports_thinking_toggle(ai):
            if getattr(ai, "thinking", "disabled") != "adaptive":
                think_extra["thinking"] = {"type": "disabled"}
            elif _is_deepseek(ai) and getattr(ai, "reasoning_effort", ""):
                think_extra["reasoning_effort"] = ai.reasoning_effort

        ctx = _OpenAICtx(tools=tools, max_tokens=ai.max_tokens, temperature=ai.temperature,
                          think_extra=think_extra, model=ai.model)
        return client, ctx

    async def run_round(self, client, ctx, messages):
        stream = await client.chat.completions.create(
            model=ctx.model,
            messages=messages,
            tools=ctx.tools,
            tool_choice="auto",
            max_tokens=ctx.max_tokens,
            temperature=ctx.temperature,
            stream=True,
            stream_options={"include_usage": True},
            extra_body=ctx.think_extra,
        )
        content = ""
        reasoning = ""                   # mimo 深度思考产出（reasoning_content）：多轮+工具调用必须原样回传，否则 400
        tool_buf: dict[int, dict] = {}   # index → {id, name, args}，流式分片累积
        total_in = total_out = total_cache = 0
        try:
            async for chunk in stream:
                if getattr(chunk, "usage", None):
                    total_in  += chunk.usage.prompt_tokens or 0
                    total_out += chunk.usage.completion_tokens or 0
                    # DeepSeek 自动上下文缓存命中（prompt_cache_hit_tokens）；非 DeepSeek 厂商无此字段 → 0
                    total_cache += getattr(chunk.usage, "prompt_cache_hit_tokens", 0) or 0
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                _rc = getattr(delta, "reasoning_content", None)
                if _rc:
                    reasoning += _rc   # 思考分片（流式里先于 content 到）；只入历史回传，不流式发给用户
                if delta.content:
                    content += delta.content
                    yield ("token", delta.content)
                for tc in (delta.tool_calls or []):
                    b = tool_buf.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                    if tc.id:
                        b["id"] = tc.id
                    if tc.function and tc.function.name:
                        b["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        b["args"] += tc.function.arguments
        finally:
            # 共享循环协作检查取消时会提前 return，不再继续消费这个 async generator——Python 关闭
            # 生成器会在这里的挂起点（yield）抛 GeneratorExit，靠 finally 兜住确保底层流被关掉
            # （原 _run_openai 在取消分支里显式 await stream.close()，这里换成 try/finally 达到
            # 同样效果，且正常耗尽/异常路径也一并覆盖，不止取消这一种）。
            try:
                await stream.close()
            except Exception:
                pass

        ordered = [tool_buf[i] for i in sorted(tool_buf)]
        tool_calls = []
        for b in ordered:
            try:
                args = json.loads(b["args"])
                tool_calls.append(NormalizedToolCall(id=b["id"], name=b["name"], input=args))
            except Exception:
                # 参数 JSON 解析失败（多为长内容被 max_tokens 截断）→ 别拿空参跑：增删改工具吃到 {} 会
                # 误伤数据或报错，还会白置 did_mutate 触发一整轮核实。标 parse_error，共享循环据此跳过
                # 真实 dispatch、改回一条错误 tool_result 让模型把这次调用参数精简后重发。
                print(f"[core] 工具 {b['name']} 参数解析失败(疑似 max_tokens 截断), "
                      f"len={len(b['args'])} 尾部={b['args'][-120:]!r}", flush=True)
                tool_calls.append(NormalizedToolCall(id=b["id"], name=b["name"], input={}, parse_error=True))

        yield ("done", RoundResult(
            text=content, tool_calls=tool_calls,
            usage_in=total_in, usage_out=total_out, cache_tokens=total_cache,
            raw=_OpenAIRaw(content=content, reasoning=reasoning, tool_calls_payload=ordered),
        ))

    def _asst(self, raw: _OpenAIRaw, text: str, tool_calls_payload=None) -> dict:
        # 统一构造 assistant 历史消息：mimo 开思考时把本轮 reasoning_content 一并带回（文档硬性要求，
        # 多轮 Function Call 缺它 → 400）。思考关时 reasoning 恒空、不加该字段，行为与原先逐字一致。
        m = {"role": "assistant", "content": text}
        if tool_calls_payload is not None:
            m["tool_calls"] = tool_calls_payload
        if raw.reasoning:
            m["reasoning_content"] = raw.reasoning
        return m

    def append_tool_round(self, messages, result, dispatched):
        raw = result.raw
        messages.append(self._asst(
            raw, raw.content or None,
            tool_calls_payload=[
                {"id": b["id"], "type": "function",
                 "function": {"name": b["name"], "arguments": b["args"]}}
                for b in raw.tool_calls_payload
            ],
        ))
        for tc, res in dispatched:
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": res})

    def append_followup(self, messages, result, next_content, assistant_fallback="（…）"):
        messages.append(self._asst(result.raw, result.text or assistant_fallback))
        messages.append({"role": "user", "content": next_content})

    def append_empty_retry(self, messages, result):
        # 跟 Anthropic 路不一样：这里不把 assistant 消息入历史，直接追问——是改动前就有的既有行为
        # （openai 路空回复兜底那段代码本来就没有 messages.append(_asst(...)) 这一步），原样保留。
        messages.append({"role": "user", "content": "（把要回复用户的话直接说出来就好，别只在心里想。）"})
