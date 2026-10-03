"""ContextBranch 共用的 provider 调用器。

只负责 provider 路由、调用参数和结果解析；领域写入仍由上层负责，用量则通过当前
用户链路上下文写入统一账本；反思与压缩均通过 ``ContextBranch`` 调用这里。
"""
from __future__ import annotations

import json

from agent.providers.standalone import output_budget
from agent.security.sanitize import strip_think_blocks


def _branch_projection(sys, history, user, ai, *, api_format: str, separate_system: bool):
    """给 provider 历史追加分支增量；canonical 输入只在此处首次投影。"""
    from agent.context.provider_conversation import ProviderConversation

    if isinstance(history, ProviderConversation):
        messages = history.to_messages()
        fixed_prefix_size = history.fixed_prefix_size
        if sys and not separate_system:
            messages.insert(0, {"role": "system", "content": sys})
            fixed_prefix_size += 1
        messages.append({"role": "user", "content": user})
        return history.with_messages(
            messages,
            fixed_prefix_size=fixed_prefix_size,
            dynamic_tail_size=1,
        )

    from agent.context.assembly import MessageArea
    from agent.context.history import render_canonical_area_snapshot

    area = MessageArea.from_canonical_messages(
        history or (),
        render_options={"api_format": api_format},
    )
    if sys and not separate_system:
        area.insert_request_message(0, {"role": "system", "content": sys})
    area.set_dynamic_tail([{"role": "user", "content": user}])
    return render_canonical_area_snapshot(
        area.snapshot(), source=area, options=area.render_options,
    )


async def complete_text(sys: str, user: str, settings, max_tokens: int | None = 800) -> str:
    from agent.llm.llm_select import use_anthropic_for
    from agent.llm.modelctx import effective_ai

    ai = effective_ai(settings)
    use_anthropic = use_anthropic_for(ai)
    thinking = getattr(ai, "thinking", None)
    return (
        await _anthropic(sys, user, ai, max_tokens, thinking=thinking, settings=settings)
        if use_anthropic
        else await _non_anthropic(sys, user, ai, max_tokens, thinking=thinking, settings=settings)
    )


async def complete_messages(
    sys: str,
    history: list,
    user: str,
    settings,
    max_tokens: int | None = 800,
    json_mode: bool = False,
    tools: list | None = None,
    usage_sink: list | None = None,
    read_timeout: float | None = None,
) -> str:
    """追加式分支：复用不可变 ProviderConversation，delta 只追加一次。

    history 应为已渲染的 ProviderConversation；裸 canonical 历史仅用于尚未投影的
    compaction 重建路径。ProviderConversation 不得再回流到 canonical renderer。
    历史必须与主 run 发给 provider 的消息同构（同一路由的同一种格式），
    这样分支请求与主对话的最后一帧共享逐 token 前缀，才能命中会话内缓存。
    tools 同样要带上：provider 把工具声明算进可缓存前缀，缺了它命中率会从
    接近 100% 掉到一成出头。

    anthropic 路由还要与主 run 逐参数对齐（thinking/generation 走同一个
    adapter 构造）：请求参数也参与 provider 的缓存键，分支曾因手拼
    ``thinking={"type": "adaptive"}``（主 run 根本不发这个参数）整段 miss，
    实测 99.9% 命中的暖前缀分支只拿到 0.1%。
    """
    from agent.llm.llm_select import use_anthropic_for
    from agent.llm.modelctx import effective_ai

    ai = effective_ai(settings)
    use_anthropic = use_anthropic_for(ai)
    thinking = getattr(ai, "thinking", None)
    if use_anthropic:
        text = await _anthropic(sys, user, ai, max_tokens,
                                settings=settings, history=history, tools=tools,
                                align_with_main_run=True, usage_sink=usage_sink,
                                read_timeout=read_timeout)
        return _parse_json(text) if json_mode else text
    text = await _non_anthropic(sys, user, ai, max_tokens, json_mode=json_mode,
                         thinking=thinking, settings=settings, history=history,
                         tools=tools, usage_sink=usage_sink,
                         read_timeout=read_timeout)
    return _parse_json(text) if json_mode else text


async def _non_anthropic(sys, user, ai, max_tokens, *, json_mode=False,
                         thinking=None, settings=None, history=None, tools=None,
                         usage_sink=None, read_timeout=None):
    """文本、JSON、追加分支共用协议路由，不载入主对话的推理状态。"""
    from agent import providers

    if providers.adapter_for(ai).protocol_format(ai) == "responses":
        from agent.providers.openai_responses import complete_branch
        # 显式分支思考设置仅作用于本请求的副本，不修改用户配置。
        branch_ai = ai
        if thinking is not None and thinking != getattr(ai, "thinking", None):
            from copy import copy
            branch_ai = copy(ai)
            branch_ai.thinking = thinking
        return strip_think_blocks(await complete_branch(
            sys, history or (), user, branch_ai, settings,
            max_output_tokens=output_budget(branch_ai, max_tokens),
            tools=tools,
            json_mode=json_mode,
            usage_sink=usage_sink,
            read_timeout=read_timeout,
        ))
    return await _openai(sys, user, ai, max_tokens, json_mode=json_mode,
                         thinking=thinking, settings=settings, history=history,
                         tools=tools, usage_sink=usage_sink,
                         read_timeout=read_timeout)


async def complete_json(
    sys: str,
    user: str,
    settings,
    max_tokens: int | None = 1500,
    thinking: str | None = None,
    read_timeout: float | None = None,
) -> dict:
    from agent.llm.llm_select import use_anthropic_for
    from agent.llm.modelctx import effective_ai

    ai = effective_ai(settings)
    use_anthropic = use_anthropic_for(ai)
    # 分支不覆盖模型配置；只有显式传入时才允许调用方临时指定。
    effective_thinking = (
        thinking if thinking is not None else getattr(ai, "thinking", None)
    )
    text = (
        await _anthropic(
            sys, user, ai, max_tokens, thinking=effective_thinking,
            settings=settings, read_timeout=read_timeout,
        )
        if use_anthropic
        else await _non_anthropic(sys, user, ai, max_tokens, json_mode=True,
                           thinking=effective_thinking, settings=settings,
                           read_timeout=read_timeout)
    )
    return _parse_json(text)


async def _anthropic(
    sys: str,
    user: str,
    ai,
    max_tokens: int,
    thinking: str | None = None,
    settings=None,
    history: list | None = None,
    tools: list | None = None,
    align_with_main_run: bool = False,
    usage_sink: list | None = None,
    read_timeout: float | None = None,
) -> str:
    import httpx
    from agent import providers

    client = providers.build_anthropic_client(
        ai, httpx.Timeout(
            connect=10.0, read=read_timeout or 40.0, write=10.0, pool=5.0,
        ))
    # Anthropic API 必填 max_tokens，无法真正不限；None 时给高预算。
    if max_tokens is None:
        max_tokens = 32768
    else:
        max_tokens = output_budget(ai, max_tokens)
    # 与主对话一致的主动缓存：稳定 system 前缀打 ephemeral 断点（分支的 user
    # 消息带时间戳每轮必变，只有 system 前缀能命中）。
    from agent.llm.llm_select import supports_anthropic_active_cache
    system = sys
    if supports_anthropic_active_cache(ai) and sys:
        system = [{"type": "text", "text": sys, "cache_control": {"type": "ephemeral"}}]
    projection = _branch_projection(
        "", history, user, ai, api_format="anthropic", separate_system=True,
    )
    if projection.conversation or projection.dynamic_tail:
        from agent.context.provider_history import sanitize_anthropic_branch_history

        # 主对话在 Anthropic driver 入口清理历史；后台追加分支不会经过该入口，
        # 因此在这里复用同一套边界清洗，避免 reasoning_content 和不配对工具事件触发 400。
        projection = sanitize_anthropic_branch_history(projection)
    if projection.conversation:
        # 追加式分支在「历史末尾 + 追加指令之前」打第二个断点：与主 run 的
        # 「固定前缀 + 末尾断点」口径一致，前缀部分才能整段命中。
        projection = _with_trailing_cache_anchor(projection)
    messages = projection.to_messages()
    # temperature 已全局下线（anthropic SDK 1.x 不再接受该参数）。
    kwargs = dict(
        model=ai.model,
        messages=messages,
        max_tokens=max_tokens,
    )
    if system:
        # 空 system 不发（如手动 /compact 的追加式调用没有主 run 的 system），
        # anthropic 兼容端点对空字符串 system 会报错。
        kwargs["system"] = system
    if tools:
        # 与主 run 一致：工具声明一起发，provider 才算得出同一份可缓存前缀。
        # 不设 tool_choice——实测它会让命中失效（100% → 15%），改用末尾指令约束
        # 模型只输出摘要正文。
        kwargs["tools"] = tools
    if align_with_main_run:
        # 与主 run 完全同源的参数构造；请求参数参与 provider 缓存键，
        # 多发/少发一个 thinking 都会让整段前缀缓存失效。
        from agent.providers import adapter_for

        adapter = adapter_for(ai)
        kwargs.update(adapter.build_anthropic_thinking_params(ai))
        kwargs.update(adapter.build_anthropic_generation_params(ai))
    elif thinking is not None:
        kwargs.update(providers.adapter_for(ai).build_anthropic_thinking_params(ai, thinking=thinking))
    resp = await client.messages.create(**kwargs)
    usage = getattr(resp, "usage", None)
    from agent.usage import normalize_anthropic_usage
    usage = normalize_anthropic_usage(usage)
    if usage_sink is not None:
        usage_sink.append(usage)
    await _record_usage(settings, ai, usage)
    return strip_think_blocks("".join(b.text for b in resp.content if getattr(b, "type", "") == "text"))


def _with_trailing_cache_anchor(messages):
    """在不可变 projection 的稳定历史末尾放置缓存断点，不触碰 dynamic tail。"""
    from agent.context.provider_conversation import ProviderConversation
    if not isinstance(messages, ProviderConversation):
        raise TypeError("分支缓存断点只接受 ProviderConversation")
    values = messages.to_messages()
    index = messages.conversation_count - 1
    if index < 0:
        return messages
    clone = dict(values[index])
    content = clone.get("content")
    if isinstance(content, list) and content:
        clone["content"] = content[:-1] + [
            {**content[-1], "cache_control": {"type": "ephemeral"}}]
    elif isinstance(content, str) and content:
        clone["content"] = [{"type": "text", "text": content,
                             "cache_control": {"type": "ephemeral"}}]
    values[index] = clone
    return messages.with_messages(values)


async def _openai(
    sys: str,
    user: str,
    ai,
    max_tokens: int | None,
    json_mode: bool = False,
    thinking: str | None = None,
    settings=None,
    history: list | None = None,
    tools: list | None = None,
    usage_sink: list | None = None,
    read_timeout: float | None = None,
) -> str:
    import httpx
    from agent import providers

    client = providers.build_openai_client(
        ai, httpx.Timeout(
            connect=10.0, read=read_timeout or 40.0, write=10.0, pool=5.0,
        ))
    # max_tokens 为 None 表示不限制输出预算，交给 provider 使用模型默认上限。
    # 追加式历史只读来自 Area 的 projection；system 与 delta 都是本次请求专属内容。
    projection = _branch_projection(
        sys, history, user, ai, api_format="openai", separate_system=False,
    )
    from agent.providers.message_utils import render_openai_request_history
    projection = render_openai_request_history(projection, providers.adapter_for(ai))
    kwargs = dict(
        model=ai.model,
        messages=projection,
    )
    if max_tokens is not None:
        kwargs["max_tokens"] = output_budget(ai, max_tokens)
    adapter = providers.adapter_for(ai)
    from agent.providers.message_utils import merge_openai_system_messages
    kwargs["messages"] = merge_openai_system_messages(kwargs["messages"])
    if tools:
        # 与主 run 同款：OpenAI 兼容端要把工具声明一起发，才能命中同一份前缀缓存。
        kwargs.update(adapter.build_tool_params(ai, tools))
    # 与主对话一致：仅对验证过显式锚点行为的 provider 给稳定 system 前缀打
    # cache_control（DeepSeek 走服务端自动缓存，不打锚点）。
    if adapter.supports_explicit_cache(getattr(ai, "model", "") or ""):
        from agent.providers.message_utils import _with_system_cache_control
        kwargs["messages"] = _with_system_cache_control(kwargs["messages"])
    if json_mode:
        kwargs.update(adapter.build_structured_output(ai))
    if thinking is not None:
        thinking_params = adapter.build_openai_thinking_kwargs(
            ai, thinking=thinking)
        if thinking_params:
            kwargs.update(thinking_params)
    kwargs["messages"] = kwargs["messages"].to_messages()
    resp = await client.chat.completions.create(**kwargs)
    usage = getattr(resp, "usage", None)
    from agent.usage import normalize_openai_usage
    usage = normalize_openai_usage(usage)
    if usage_sink is not None:
        usage_sink.append(usage)
    await _record_usage(settings, ai, usage)
    return strip_think_blocks(resp.choices[0].message.content or "")


async def _record_usage(settings, model_cfg, usage: dict) -> None:
    """用量记账失败不能改变反思/压缩的业务结果。"""
    try:
        from agent.usage import record_current_usage

        await record_current_usage(settings, model_cfg, usage)
    except Exception as exc:
        # provider_runner 的调用方只关心模型结果；记账故障由诊断日志和后续重试处理。
        from app.core.redaction import diag_log
        diag_log("agent.usage.provider", exc)


def _parse_json(text: str) -> dict:
    """从模型输出里提取 JSON 对象，容忍 markdown 围栏。"""
    if not text:
        return {}
    value = strip_think_blocks(text).strip()
    if "```" in value:
        value = value.split("```", 2)[1]
        if value.startswith("json"):
            value = value[4:]
    lo, hi = value.find("{"), value.rfind("}")
    if lo == -1 or hi == -1:
        return {}
    try:
        parsed = json.loads(value[lo:hi + 1])
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}
