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

驱动接口四个构造方法：
- `prepare(tool_names, ai, messages, system_text)`：调用一次的一次性准备（建 client、
  算 tools schema/缓存能力/思考参数），返回 `(client, ctx)`。
- `run_round(client, ctx, messages)`：跑一轮，是个 async generator——流式 yield
  `("token", str)`，最后 yield `("done", RoundResult)`。
- `build_tool_round(result, dispatched)`：构造这一轮的 assistant 消息 + 工具结果消息，
  不直接修改 history；两边格式差异大，整段交给驱动自己拼。
- `build_followup(result, next_content, assistant_fallback="（…）")`：构造核实 prompt
  或守卫 nudge 使用的消息批次。`assistant_fallback` 是 assistant 内容为空时的占位——
  两边各自的占位规则跟改动前逐条对齐，见各自实现里的注释。
- `build_guard_followup(result, next_content)`：构造内部守卫消息批次。
- `build_empty_retry(result)`：构造空回复追问批次。两边这里"assistant 是否入历史"
  本身就不一样，因此保留在各自 Provider renderer 中。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Protocol

from app.core.errors import RetryableError
from app.core.redaction import diag_log
from agent.context.canonical_tool_history import ToolCall

_log = logging.getLogger("agent.core")

# OpenAI 路工具参数 JSON 截断（多为 max_tokens 截断）的统一错误文案——两边共用同一份文字，
# 只是各自的 build_tool_round 决定怎么包装成 tool_result 消息。
TOOL_ARGS_TRUNCATED_ERROR = json.dumps(
    {"error": "参数不完整（内容可能过长被截断），请精简这次调用的参数后重试"}, ensure_ascii=False)


@dataclass
class NormalizedToolCall(ToolCall):
    """运行时工具调用，在 canonical 字段上补充 provider 解析状态。"""

    parse_error: bool = False   # 只有 OpenAI 路会真的置真（JSON 截断解析失败）


@dataclass
class RoundResult:
    text: str                          # 本轮纯文本正文（不含工具调用/思考）
    tool_calls: list = field(default_factory=list)   # list[NormalizedToolCall]
    # provider 若以后能返回显式决策，可在这里填入；当前驱动以原生 tool_calls 推导。
    # 这是运行时状态，不会写入对话历史或下一轮 prompt。
    requires_tools: bool | None = None
    usage_in: int = 0
    usage_out: int = 0
    cache_tokens: int = 0              # 统一映射：anthropic 的 cache_read_input_tokens /
                                        # deepseek 的 prompt_cache_hit_tokens，对外 SSE 字段名
                                        # 两边本来就都叫 cache_read，这里合并成一个字段不改变行为。
    raw: Any = None                    # 驱动私有：给 append_* 方法用的原始数据


class LoopDriver(Protocol):
    api_format: str

    def prepare(self, tool_names: list[str], ai, messages: list, system_text: str | None): ...
    def update_tools(self, ctx, tool_names: list[str]) -> None: ...
    def run_round(self, client, ctx, messages: list) -> AsyncGenerator[tuple, None]: ...
    def build_tool_round(self, result: RoundResult, dispatched: list) -> list[dict]: ...
    def build_followup(self, result: RoundResult, next_content: str,
                       assistant_fallback: str = "（…）") -> list[dict]: ...
    def build_guard_followup(self, result: RoundResult, next_content: str) -> list[dict]: ...
    def build_empty_retry(self, result: RoundResult) -> list[dict]: ...


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
    generation_param: dict


def _contains_volatile_image(value: Any) -> bool:
    """识别会改变请求前缀的内联图片，不把其后的内容推进缓存断点。"""
    if isinstance(value, dict):
        if value.get("type") == "image":
            source = value.get("source") or {}
            if isinstance(source, dict) and source.get("type") == "base64" and source.get("data"):
                return True
        if value.get("type") == "image_url":
            image_url = value.get("image_url") or {}
            url = image_url.get("url") if isinstance(image_url, dict) else image_url
            if isinstance(url, str) and url.startswith("data:"):
                return True
        return any(_contains_volatile_image(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_volatile_image(item) for item in value)
    return False


def _volatile_message_indices(messages: list) -> set[int]:
    """记录首轮请求中带内联图片的消息位置，后续只折叠这些初始图片。"""
    return {
        index for index, message in enumerate(messages)
        if _contains_volatile_image(message)
    }


def _collapse_volatile_messages(messages: list, indices: set[int]) -> None:
    """模型首轮消费图片后，把初始图片消息收敛为稳定文本，避免跨 round/run 断前缀。"""
    for index in indices:
        if index < 0 or index >= len(messages):
            continue
        message = messages[index]
        content = message.get("content")
        if not isinstance(content, list) or not _contains_volatile_image(content):
            continue
        text_parts = [
            str(block.get("text"))
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text")
        ]
        message["content"] = "\n".join(text_parts) or "[图片已查看]"


def _history_cache_state(messages: list) -> tuple[int, set[int]]:
    """计算实际请求会使用的稳定边界和缓存断点。

    这个计算同时被发送路径和 LoopScope 诊断使用，避免监控看到的是装配前状态，
    而 provider 实际拿到的副本已经有另一套断点。
    """
    conversation = getattr(messages, "conversation", messages)
    cache_limit = len(conversation)
    if cache_limit <= 0:
        return 0, set()

    volatile_index = next(
        (index for index, message in enumerate(conversation[:cache_limit])
         if _contains_volatile_image(message)),
        None,
    )
    stable_limit = volatile_index if volatile_index is not None else cache_limit
    anchor_indices = {
        index for index in getattr(messages, "cache_anchor_indices", [])
        if 0 <= index < stable_limit
    }
    latest_anchor = stable_limit - 1
    if anchor_indices:
        # 续轮只保留最早 baseline 和当前尾部；不要再把中间普通 user 消息
        # 提升为断点，否则工具结果会把稳定前缀缓存锚点挤掉。
        anchor_indices = {min(anchor_indices)}
    else:
        if latest_anchor >= 0:
            anchor_indices.add(latest_anchor)
        # 新请求会重建 PromptMessages，因此首轮需要从稳定 conversation 中
        # 找到 baseline；工具结果不能作为首轮 baseline。
        for index in range(stable_limit - 2, -1, -1):
            message = conversation[index]
            if message.get("role") != "user":
                continue
            content = message.get("content")
            blocks = content if isinstance(content, list) else []
            if blocks and all(isinstance(block, dict) and block.get("type") == "tool_result"
                              for block in blocks):
                continue
            anchor_indices.add(index)
            break
    if latest_anchor >= 0:
        anchor_indices.add(latest_anchor)
    return stable_limit, anchor_indices


def _cache_message_copy(messages: list, rendered: list[dict], stable_limit: int):
    """复制缓存标记后的消息，同时保留 PromptMessages 的动态尾缀边界。"""
    if not hasattr(messages, "conversation"):
        return rendered

    from agent.context.assembly import PromptMessages

    result = PromptMessages(
        rendered[:stable_limit],
        fixed_prefix_size=getattr(messages, "fixed_prefix_size", 0),
    )
    if len(rendered) > stable_limit:
        result.set_dynamic_tail(rendered[stable_limit:])
    result._cache_anchor_indices = list(getattr(messages, "cache_anchor_indices", ()))
    for name in ("canonical_context", "_canonical_batches", "_canonical_batch_digests",
                 "_canonical_batch_metadata"):
        if hasattr(messages, name):
            setattr(result, name, getattr(messages, name))
    return result


def _with_history_cache(messages: list) -> list:
    """给消息历史添加 cache_control，参考 dsh/pi-ai 的实现。

    MiniMax/Anthropic 缓存机制是前缀匹配：
    - 找到第一个 cache_control 标记
    - 缓存从请求开头到该标记的所有内容
    - 后续请求如果前缀相同，就能命中缓存

    dsh 的做法（已验证 50% 缓存率）：
    1. system 块加 cache_control（已在 prepare 中处理）
    2. 最后一条用户消息加 cache_control（缓存完整对话历史）

    这比每个块都加更有效，因为：
    - MiniMax 只处理有限数量的 cache_control 断点
    - 最后一条消息的 cache_control 能覆盖整个历史前缀
    """
    if not messages:
        return messages

    # PromptMessages 的动态尾部每轮都会变化，缓存断点必须落在固定 conversation 的末尾；
    # 否则时间 reminder 会被包含在断点前缀中，下一轮必然失去命中。
    stable_limit, anchor_indices = _history_cache_state(messages)
    if stable_limit <= 0:
        return list(messages)
    remember_anchor = getattr(messages, "remember_cache_anchor", None)
    if remember_anchor is not None:
        for index in sorted(anchor_indices):
            remember_anchor(index)

    # 浅拷贝 messages 列表
    new_messages = []

    for i, msg in enumerate(messages):
        msg = dict(msg)
        content = msg.get("content")

        # 只给 conversation baseline 加 cache_control；动态尾部永远不加。
        is_anchor = i in anchor_indices and i < stable_limit

        if isinstance(content, list) and is_anchor and content:
            new_content = content[:-1] + [
                {**content[-1], "cache_control": {"type": "ephemeral"}}
            ]
        elif isinstance(content, str) and is_anchor:
            new_content = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
        else:
            # 其他消息不加 cache_control
            new_content = content

        msg["content"] = new_content
        new_messages.append(msg)

    return _cache_message_copy(messages, new_messages, stable_limit)


def _with_single_history_cache(messages: list) -> list:
    """给稳定 conversation 保留跨 Run baseline 和最新尾部两个历史锚点。"""
    stable_limit, anchor_indices = _history_cache_state(messages)
    if stable_limit <= 0:
        return list(messages)
    remember_anchor = getattr(messages, "remember_cache_anchor", None)
    if remember_anchor is not None:
        for index in sorted(anchor_indices):
            remember_anchor(index)
    new_messages = []
    for index, message in enumerate(messages):
        clone = dict(message)
        content = clone.get("content")
        if index in anchor_indices and index < stable_limit:
            if isinstance(content, list) and content:
                clone["content"] = content[:-1] + [
                    {**content[-1], "cache_control": {"type": "ephemeral"}}
                ]
            elif isinstance(content, str):
                clone["content"] = [{
                    "type": "text", "text": content,
                    "cache_control": {"type": "ephemeral"},
                }]
        elif message.get("role") != "system":
            if isinstance(content, list):
                clone["content"] = [
                    {key: value for key, value in block.items() if key != "cache_control"}
                    if isinstance(block, dict) else block
                    for block in content
                ]
        new_messages.append(clone)
    return _cache_message_copy(messages, new_messages, stable_limit)


class AnthropicDriver:
    api_format = "anthropic"

    def prepare(self, tool_names, ai, messages, system_text):
        import httpx
        from agent import providers
        from agent.llm.llm_select import supports_anthropic_active_cache
        from agent.tools import registry

        tools = registry.anthropic_schemas(tool_names)
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        supports_active_cache = supports_anthropic_active_cache(ai)
        adapter = providers.adapter_for(ai)
        client = providers.build_anthropic_client(ai, _timeout)
        thinking_param = adapter.build_anthropic_thinking_params(ai)

        # system_text 来自 build_split 的稳定前缀；动态上下文已经移到 messages。
        if system_text:
            if supports_active_cache:
                system_param = [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}]
            else:
                system_param = system_text
        else:
            system_param = system_text

        ctx = _AnthropicCtx(
            tools=tools, max_tokens=ai.max_tokens, temperature=ai.temperature,
            thinking_param=thinking_param, system_param=system_param,
            supports_active_cache=supports_active_cache, adapter=adapter, model=ai.model,
            generation_param=adapter.build_anthropic_generation_params(ai),
        )
        return client, ctx

    def update_tools(self, ctx, tool_names: list[str]) -> None:
        from agent.tools import registry
        ctx.tools = registry.anthropic_schemas(tool_names)

    async def run_round(self, client, ctx, messages):
        from agent.core import _stream_round   # 延迟 import 避免循环依赖（core.py 反过来 import 本模块）

        # ② 给发出去的 messages 打一个滚动缓存断点（每条 message 的最后一个块）：多轮工具循环里
        #    历史越滚越长，缓存住已发生的几轮、每轮只重算新增。用副本、不改原 messages（原列表要持久化，
        #    绝不能混入 cache_control，否则下次加载历史会带着旧断点、累积超过 4 个上限）。
        outbound = ctx.adapter.render_history(messages)
        from agent.context.provider_history import render_anthropic_message_roles
        outbound = render_anthropic_message_roles(outbound, ctx.adapter)
        _msgs = _with_history_cache(outbound) if ctx.supports_active_cache else outbound
        kwargs = dict(
            model=ctx.model, system=ctx.system_param, messages=_msgs,
            tools=ctx.tools, max_tokens=ctx.max_tokens,
            **ctx.thinking_param,
            **ctx.generation_param,
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
            text=text, tool_calls=tool_calls, requires_tools=bool(tool_calls),
            usage_in=final.usage.input_tokens, usage_out=final.usage.output_tokens,
            cache_tokens=getattr(final.usage, "cache_read_input_tokens", 0) or 0,
            raw=final.content,
        ))

    def _content_dicts(self, result: RoundResult) -> list:
        return [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in result.raw]

    def build_tool_round(self, result, dispatched, *, allow_images: bool = True):
        # 序列化为 dict：让 messages 列表 JSON 可序列化（便于持久化），
        # 同时保留 thinking blocks（MiniMax / Anthropic 多轮时原样回传）
        messages = [{"role": "assistant", "content": self._content_dicts(result)}]
        tool_results = [{"type": "tool_result", "tool_use_id": tc.id, "content": res} for tc, res in dispatched]
        messages.append({"role": "user", "content": tool_results})
        return messages

    def build_followup(self, result, next_content, assistant_fallback="（…）"):
        return [
            {"role": "assistant", "content": self._content_dicts(result)},
            {"role": "user", "content": next_content},
        ]

    def build_guard_followup(self, result, next_content):
        """追加内部守卫控制消息；守卫不是用户新消息，保留 system 语义。"""
        return [
            {"role": "assistant", "content": self._content_dicts(result)},
            {"role": "system", "content": next_content},
        ]

    def build_empty_retry(self, result):
        # 占位保证 user/assistant 交替合法（真·空 content 会被 Anthropic 拒）；
        # 这条守卫消息不入历史（tool_rounds_only 过滤）
        content_dicts = self._content_dicts(result) or [{"type": "text", "text": "（…）"}]
        return [
            {"role": "assistant", "content": content_dicts},
            {"role": "user", "content": "（把要回复用户的话直接说出来就好，别只在心里想。）"},
        ]


# ══════════════════════════════════════════════════════════════════════════
# OpenAI（小米 MiMo / DeepSeek / 其它 OpenAI 兼容厂商，走 openai 格式）
# ══════════════════════════════════════════════════════════════════════════

@dataclass
class _OpenAICtx:
    tools: list
    max_tokens: int
    temperature: float
    think_kwargs: dict
    model: str
    supports_active_cache: bool
    supports_explicit_cache: bool
    adapter: Any
    ai: Any


@dataclass
class _OpenAIRaw:
    """驱动私有：append_* 需要的这一轮原始数据——content/reasoning 是给下一轮历史消息用的，
    tool_calls_payload 是给 OpenAI `tool_calls` 字段用的原始形状（跟 NormalizedToolCall 分开存，
    因为后者的 .input 已经是解析后的 dict，OpenAI 历史消息里 tool_calls.function.arguments
    要求的是原始未解析字符串）。"""
    content: str
    reasoning: str
    tool_calls_payload: list


def _openai_tool_result(res: Any, *, allow_images: bool = True) -> tuple[str, list[dict]]:
    """把工具返回的 Anthropic 视觉块转换成 OpenAI 可接受的消息。

    工具 registry 为了兼容 Anthropic，会把图片放成 ``image/source`` 块。
    OpenAI 兼容接口不能把这种块原样放进 ``role=tool``；文本结果留在 tool
    消息里，图片作为紧随其后的 user 多模态消息交给模型。图片是否出站由本轮
    provider 能力决定，避免把视觉块发给只接受文本的模型。
    """
    if not isinstance(res, list):
        if isinstance(res, str):
            return res, []
        return json.dumps(res, ensure_ascii=False), []

    text_parts: list[str] = []
    image_parts: list[dict] = []
    for block in res:
        if not isinstance(block, dict):
            text_parts.append(str(block))
            continue
        if block.get("type") == "text":
            value = block.get("text")
            if value:
                text_parts.append(str(value))
            continue
        if block.get("type") == "image":
            if not allow_images:
                text_parts.append("[图片结果已返回，但当前模型不支持视觉输入]")
                continue
            source = block.get("source") or {}
            if source.get("type") == "base64" and source.get("data"):
                media = source.get("media_type") or "image/jpeg"
                image_parts.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{media};base64,{source['data']}", "detail": "auto"},
                })
                continue
        # 未知块不要直接丢失，保留一个不会破坏 OpenAI schema 的摘要。
        text_parts.append(json.dumps(block, ensure_ascii=False))

    return "\n".join(text_parts) or "工具已执行。", image_parts


class OpenAIDriver:
    api_format = "openai"

    def prepare(self, tool_names, ai, messages, system_text):
        import httpx
        from agent import providers
        from agent.tools import registry

        adapter = providers.adapter_for(ai)
        model = getattr(ai, "model", "") or ""
        supports_active_cache = adapter.supports_active_cache(model)
        supports_explicit_cache = adapter.supports_explicit_cache(model)

        # OpenAI 兼容 provider 的 cache_control 语义并不统一。经过验证的 Qwen
        # 端点会把标记作为缓存边界；连续的 system 消息都是稳定前缀的一部分，
        # 必须一起标记，才能覆盖 system + snapshot。稳定 conversation 的唯一
        # 历史锚点统一由 run_round 的显式策略放在末尾，动态尾部也不会被纳入。
        # DeepSeek 走服务端自动缓存，
        # 不进入这条分支。
        if supports_explicit_cache:
            cache_messages = getattr(messages, "conversation", messages)
            for message in cache_messages:
                if message.get("role") != "system":
                    break
                content = message.get("content")
                if isinstance(content, str):
                    message["content"] = [{
                        "type": "text", "text": content,
                        "cache_control": {"type": "ephemeral"},
                    }]
                elif isinstance(content, list) and content and "cache_control" not in content[-1]:
                    content[-1] = {
                        **content[-1], "cache_control": {"type": "ephemeral"},
                    }

        declared = providers.capability_snapshot(ai)
        tools = registry.openai_schemas(tool_names) if declared.get("tools", True) else []
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        client = providers.build_openai_client(ai, _timeout)

        think_kwargs = adapter.build_openai_thinking_kwargs(ai)

        ctx = _OpenAICtx(
            tools=tools, max_tokens=ai.max_tokens, temperature=ai.temperature,
            think_kwargs=think_kwargs, model=ai.model,
            supports_active_cache=supports_active_cache,
            supports_explicit_cache=supports_explicit_cache,
            adapter=adapter,
            ai=ai,
        )
        return client, ctx

    def update_tools(self, ctx, tool_names: list[str]) -> None:
        from agent.tools import registry
        from agent import providers
        ctx.tools = registry.openai_schemas(tool_names) if providers.capability_snapshot(ctx.ai).get("tools", True) else []

    async def run_round(self, client, ctx, messages):
        # OpenAI 兼容模型也需要把缓存断点放在 conversation 末尾；动态尾部不能进入断点。
        # 使用副本，避免 cache_control 被写回会话历史或下一轮的 PromptMessages。
        outbound = ctx.adapter.render_history(messages)
        # OpenAI 兼容端点的原生 KV cache 不等于支持显式 cache_control。
        # DeepSeek 依赖服务端自动缓存；只有经过验证的 provider 才能在消息中
        # 插入显式锚点，避免把 DeepSeek 的自动缓存误走成 Anthropic/Qwen 策略。
        if ctx.supports_explicit_cache:
            if ctx.adapter.uses_single_history_cache_anchor(ctx.model):
                messages = _with_single_history_cache(outbound)
            else:
                messages = _with_history_cache(outbound)
        else:
            messages = outbound
        tool_params = ctx.adapter.build_tool_params(ctx.ai, ctx.tools)
        cache_kwargs = ctx.adapter.build_openai_cache_kwargs(ctx.ai)
        stream = await client.chat.completions.create(
            model=ctx.model,
            messages=messages,
            max_tokens=ctx.max_tokens,
            temperature=ctx.temperature,
            stream=True,
            stream_options={"include_usage": True},
            **ctx.think_kwargs,
            **tool_params,
            **cache_kwargs,
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
                    # 缓存命中：DeepSeek 用 prompt_cache_hit_tokens；Qwen/阿里用 prompt_tokens_details.cached_tokens
                    cache_hit = getattr(chunk.usage, "prompt_cache_hit_tokens", 0) or 0
                    if not cache_hit:
                        details = getattr(chunk.usage, "prompt_tokens_details", None)
                        if details:
                            cache_hit = getattr(details, "cached_tokens", 0) or 0
                    total_cache += cache_hit
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
            text=content, tool_calls=tool_calls, requires_tools=bool(tool_calls),
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

    def build_tool_round(self, result, dispatched, *, allow_images: bool = True):
        raw = result.raw
        messages = [self._asst(
            raw, raw.content or None,
            tool_calls_payload=[
                {"id": b["id"], "type": "function",
                 "function": {"name": b["name"], "arguments": b["args"]}}
                for b in raw.tool_calls_payload
            ],
        )]
        visual_parts: list[dict] = []
        for tc, res in dispatched:
            content, images = _openai_tool_result(res, allow_images=allow_images)
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": content})
            visual_parts.extend(images)
        if visual_parts:
            messages.append({
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "工具返回了以下图片，请结合工具文字结果继续处理。",
                }, *visual_parts],
            })

        return messages

    def build_followup(self, result, next_content, assistant_fallback="（…）"):
        return [
            self._asst(result.raw, result.text or assistant_fallback),
            {"role": "user", "content": next_content},
        ]

    def build_guard_followup(self, result, next_content):
        """追加内部守卫控制消息，不把它伪装成用户指令。"""
        return [
            self._asst(result.raw, result.text or "（…）"),
            {"role": "system", "content": next_content},
        ]

    def build_empty_retry(self, result):
        # 跟 Anthropic 路不一样：这里不把 assistant 消息入历史，直接追问——是改动前就有的既有行为
        # （openai 路空回复兜底那段代码本来就没有 messages.append(_asst(...)) 这一步），原样保留。
        return [{"role": "user", "content": "（把要回复用户的话直接说出来就好，别只在心里想。）"}]


# ══════════════════════════════════════════════════════════════════════════
# Ollama 原生（/api/chat，NDJSON）
# ══════════════════════════════════════════════════════════════════════════

@dataclass
class _OllamaCtx:
    tools: list
    max_tokens: int
    temperature: float
    model: str
    think: bool | str
    keep_alive: str
    base_url: str
    adapter: Any


@dataclass
class _OllamaRaw:
    content: str
    thinking: str
    tool_calls_payload: list


def _ollama_messages(messages: list) -> list:
    """移除其它 provider 的缓存标记，保留 Ollama 原生可理解的消息字段。"""
    result = []
    for message in messages:
        clean = {}
        for key in ("role", "content", "images", "tool_calls", "thinking"):
            if key in message:
                clean[key] = message[key]
        # 历史里已有 OpenAI reasoning_content 时，转换为 Ollama 的 thinking 字段。
        if "thinking" not in clean and message.get("reasoning_content"):
            clean["thinking"] = message["reasoning_content"]
        if isinstance(clean.get("content"), list):
            text_parts = []
            images = list(clean.get("images") or [])
            for block in clean["content"]:
                if isinstance(block, dict) and block.get("type") == "text":
                    if block.get("text"):
                        text_parts.append(str(block["text"]))
                elif isinstance(block, dict) and block.get("type") == "image_url":
                    url = (block.get("image_url") or {}).get("url", "")
                    if isinstance(url, str) and "," in url and url.startswith("data:"):
                        images.append(url.split(",", 1)[1])
                else:
                    text_parts.append(json.dumps(block, ensure_ascii=False))
            clean["content"] = "\n".join(text_parts)
            if images:
                clean["images"] = images
        result.append(clean)
    return result


class OllamaDriver:
    """Ollama 原生聊天驱动，独立于 OpenAI SDK 的兼容通道。"""

    api_format = "ollama"

    def prepare(self, tool_names, ai, messages, system_text):
        import httpx
        from agent import providers
        from agent.tools import registry

        adapter = providers.adapter_for(ai)
        if adapter.name != "ollama":
            raise ValueError("OllamaDriver 只能用于 Ollama provider")
        timeout = httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=5.0)
        client = providers.build_ollama_client(ai, timeout)
        effort = getattr(ai, "reasoning_effort", "") or "medium"
        think: bool | str = False if getattr(ai, "thinking", "disabled") != "adaptive" else effort
        if think not in {False, "low", "medium", "high", "max"}:
            think = "medium"
        tools = registry.openai_schemas(tool_names)
        return client, _OllamaCtx(
            tools=tools,
            max_tokens=ai.max_tokens,
            temperature=ai.temperature,
            model=ai.model,
            think=think,
            keep_alive=getattr(ai, "ollama_keep_alive", "5m") or "5m",
            base_url=adapter.resolve_native_base_url(ai),
            adapter=adapter,
        )

    def update_tools(self, ctx, tool_names: list[str]) -> None:
        from agent.tools import registry
        ctx.tools = registry.openai_schemas(tool_names)

    async def run_round(self, client, ctx, messages):
        payload = {
            "model": ctx.model,
            "messages": _ollama_messages(ctx.adapter.render_history(messages)),
            "stream": True,
            "think": ctx.think,
            "keep_alive": ctx.keep_alive,
            "options": {"temperature": ctx.temperature, "num_predict": ctx.max_tokens},
        }
        if ctx.tools:
            payload["tools"] = ctx.tools
        content = ""
        thinking = ""
        tool_calls = []
        async with client.stream("POST", f"{ctx.base_url}/chat", json=payload) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                message = chunk.get("message") or {}
                text = message.get("content") or ""
                if text:
                    content += text
                    yield ("token", text)
                thinking += message.get("thinking") or ""
                for index, call in enumerate(message.get("tool_calls") or []):
                    function = call.get("function") or {}
                    args = function.get("arguments") or {}
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except json.JSONDecodeError:
                            args = {}
                    tool_calls.append({
                        "id": call.get("id") or f"ollama-call-{index}",
                        "type": "function",
                        "function": {"name": function.get("name", ""), "arguments": args},
                    })
                if chunk.get("done"):
                    usage_in = int(chunk.get("prompt_eval_count") or 0)
                    usage_out = int(chunk.get("eval_count") or 0)
                    break
            else:
                usage_in = usage_out = 0

        normalized = [NormalizedToolCall(
            id=call["id"], name=call["function"]["name"], input=call["function"]["arguments"]
        ) for call in tool_calls if call["function"]["name"]]
        yield ("done", RoundResult(
            text=content, tool_calls=normalized, requires_tools=bool(normalized),
            usage_in=usage_in, usage_out=usage_out,
            raw=_OllamaRaw(content=content, thinking=thinking, tool_calls_payload=tool_calls),
        ))

    def _assistant(self, raw: _OllamaRaw, text: str) -> dict:
        message = {"role": "assistant", "content": text}
        if raw.thinking:
            message["thinking"] = raw.thinking
        if raw.tool_calls_payload:
            message["tool_calls"] = raw.tool_calls_payload
        return message

    def build_tool_round(self, result, dispatched, *, allow_images: bool = True):
        messages = [self._assistant(result.raw, result.raw.content)]
        for tc, res in dispatched:
            content, _images = _openai_tool_result(res, allow_images=allow_images)
            messages.append({"role": "tool", "tool_name": tc.name, "content": content})
        return messages

    def build_followup(self, result, next_content, assistant_fallback="（…）"):
        return [
            self._assistant(result.raw, result.text or assistant_fallback),
            {"role": "user", "content": next_content},
        ]

    def build_guard_followup(self, result, next_content):
        return [
            self._assistant(result.raw, result.text or "（…）"),
            {"role": "system", "content": next_content},
        ]

    def build_empty_retry(self, result):
        return [{"role": "user", "content": "（把要回复用户的话直接说出来就好，别只在心里想。）"}]
