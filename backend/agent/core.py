"""LLM 主循环（迁自原 agent.py 的 _loop_anthropic / _loop_openai）。

Anthropic 路：单次流式调用（带 tools）—— 实时流式输出文本的同时，结束后从
get_final_message 取 tool_use；有工具则执行（走 skills.registry）回填后继续，
无工具则收尾。一次调用兼顾流式与工具检测，既保留真流式、又无"双调用敷衍"。
OpenAI 路：非流式探测工具 → 无工具时分块输出已生成文本。工具 schema 由 profile
启用的工具名从 registry 派生，消除手写双格式。temperature 已加到调用上保证离散度生效。
"""
import asyncio
import json
from typing import AsyncGenerator

from agent.skills import registry

# ⑦ 慢尾兜底：LLM 瞬时错误（限流 429 / 超时 / 网络 / 5xx）退避重试——贴着并发上限跑时
# 把偶发 429 吸收成短延迟、不丢消息。只在「本轮还没吐 token 前」重试（已吐过再重试会重复输出）。
_RETRY_BACKOFF = [1, 2, 4]   # 退避秒数；最多重试 3 次


async def _stream_round(client, kwargs):
    """跑一轮 Anthropic 流式，遇瞬时错误在出 token 前退避重试。
    yield ('token', delta) 逐字；结束 yield ('final', message)。重试用尽 / 不可重试 → 抛出。"""
    import anthropic
    transient = (anthropic.RateLimitError, anthropic.APITimeoutError,
                 anthropic.APIConnectionError, anthropic.InternalServerError)
    last = None
    for i in range(len(_RETRY_BACKOFF) + 1):
        emitted = False
        try:
            async with client.messages.stream(**kwargs) as stream:
                async for delta in stream.text_stream:
                    emitted = True
                    yield ("token", delta)
                yield ("final", await stream.get_final_message())
                return
        except transient as e:
            last = e
            if emitted or i >= len(_RETRY_BACKOFF):
                raise              # 已吐 token（重试会重复）或重试用尽 → 抛给上层降级
            print(f"[core] LLM 瞬时错误 {type(e).__name__}，{_RETRY_BACKOFF[i]}s 后重试({i+1})", flush=True)
            await asyncio.sleep(_RETRY_BACKOFF[i])
    if last:
        raise last

# 工具循环最大轮次。配合「工具使用准则」(skills.md，先规划后执行、别重复验证) + 强工具
# (create_project 带 stages/todos、set_stages 整体替换、move_items/批量 rename/edit 一次处理多个)，
# 多步任务通常 2~3 轮就完成。设 6 给复杂任务留余量、同时收紧慢尾（封顶单条耗时）；真撞上限会友好提示「前面已生效，要不要接着做」。
MAX_ROUNDS = 6
_CANCEL_CHECK_EVERY = 24   # 流式途中每 N 个 token 协作检查一次取消（单轮长回答只能在这里掐断）


async def _im_cancelled() -> bool:
    """IM 路：用户中途发「算了」→ 网关置了取消标志。web 路无 imctx，恒 False。"""
    from agent import imctx
    im = imctx.get_im()
    if not im or not im.get("puid"):
        return False
    from agent import runtime_state as rt
    return await rt.is_cancelled(im["platform"], im["puid"])


async def _im_set_tool_state(tool_name: str) -> None:
    """据工具名打细粒度状态（web_search→SEARCHING、create_document→GENERATING），
    让网关「还在吗」答得更准。web 路无 imctx 时 no-op。"""
    from agent import imctx
    im = imctx.get_im()
    if not im or not im.get("puid"):
        return
    from agent import runtime_state as rt
    fine = rt.TOOL_STATE.get(tool_name)
    if fine:
        await rt.set_state(im["platform"], im["puid"], fine)


class LLMRunner:
    """provider 无关的工具循环执行器。"""

    def __init__(self, tool_names: list[str], settings):
        self.tool_names = tool_names
        self.settings = settings
        self.labels = registry.labels()

    def run(self, user_id, system_text: str, messages: list,
            use_anthropic: bool, model_cfg=None) -> AsyncGenerator[str, None]:
        # model_cfg：pick_model 解析出的模型配置（预设或 settings.ai）；None 时退回 settings.ai
        ai = model_cfg if model_cfg is not None else self.settings.ai
        if use_anthropic:
            return self._run_anthropic(user_id, system_text, messages, ai)
        return self._run_openai(user_id, messages, ai)

    # ── Anthropic（MiniMax / Anthropic）─────────────────────────────────────
    async def _run_anthropic(self, user_id, system_text: str,
                             messages: list, ai=None) -> AsyncGenerator[str, None]:
        import httpx
        from anthropic import AsyncAnthropic

        settings = self.settings
        ai = ai if ai is not None else settings.ai
        tools = registry.anthropic_schemas(self.tool_names)
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        client = AsyncAnthropic(
            api_key=ai.api_key or "dummy",
            base_url=ai.base_url,
            http_client=httpx.AsyncClient(timeout=_timeout),
        )

        total_in = total_out = total_cache_read = 0
        max_tokens  = ai.max_tokens
        temperature = ai.temperature
        thinking_val = getattr(ai, "thinking", "disabled")
        thinking_param = {"thinking": {"type": thinking_val}} if thinking_val == "adaptive" else {}

        # prompt 缓存：把 system（含人格/记忆/上下文）作为稳定前缀缓存。
        # Anthropic 顺序 tools→system→messages，断点打在 system 即缓存 tools+system，
        # 多轮工具循环只重算新增 messages，命中后读取便宜 ~90%。
        system_param = (
            [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}]
            if system_text else system_text
        )

        for _ in range(MAX_ROUNDS):
            # 用户中途「算了」→ 轮间协作中断（单次 LLM 流式调用本身切不了，故粒度是轮与轮之间）
            if await _im_cancelled():
                yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                return
            # 单次流式调用：既实时流式输出文本，又能拿到 tool_use（无双调用、无敷衍）
            # 经 _stream_round 包一层瞬时错误退避重试（⑦）；流式途中仍协作检查取消。
            _kwargs = dict(
                model=ai.model, system=system_param, messages=messages,
                tools=tools, max_tokens=max_tokens, temperature=temperature, **thinking_param,
            )
            _tok = 0
            final = None
            try:
                async for _kind, _val in _stream_round(client, _kwargs):
                    if _kind == "final":
                        final = _val
                        break
                    yield f"data: {json.dumps({'type': 'token', 'content': _val})}\n\n"
                    # 流式途中也协作检查取消：单轮长回答没有「下一轮」，只能在这里掐断；
                    # 退出生成器会关闭 stream、断开上游请求，真正停掉生成（不是只丢弃后续 token）
                    _tok += 1
                    if _tok % _CANCEL_CHECK_EVERY == 0 and await _im_cancelled():
                        yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                        return
            except Exception as e:
                import anthropic
                busy = isinstance(e, getattr(anthropic, "RateLimitError", ()))
                detail = "咕咕这会儿有点忙（接口繁忙），过几秒再发一次试试 🙏" if busy else "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                print(f"[core] LLM 调用失败（已重试）: {type(e).__name__}: {str(e)[:120]}", flush=True)
                yield f"data: {json.dumps({'type': 'error', 'detail': detail}, ensure_ascii=False)}\n\n"
                return

            total_in  += final.usage.input_tokens
            total_out += final.usage.output_tokens
            total_cache_read += getattr(final.usage, "cache_read_input_tokens", 0) or 0

            tool_blocks = [b for b in final.content if b.type == "tool_use"]
            if tool_blocks:
                tool_results = []
                for block in tool_blocks:
                    label = self.labels.get(block.name, block.name)
                    await _im_set_tool_state(block.name)
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': block.name, 'label': label, 'input': block.input}, ensure_ascii=False)}\n\n"
                    result, artifact = await registry.dispatch(user_id, block.name, block.input)
                    yield f"data: {json.dumps({'type': 'tool_done', 'name': block.name, 'label': label}, ensure_ascii=False)}\n\n"
                    if artifact:
                        yield f"data: {json.dumps({'type': 'file', 'file': artifact}, ensure_ascii=False)}\n\n"
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result,
                    })
                # 序列化为 dict：让 messages 列表 JSON 可序列化（便于持久化），
                # 同时保留 thinking blocks（MiniMax / Anthropic 多轮时原样回传）
                content_dicts = [
                    b.model_dump() if hasattr(b, "model_dump") else dict(b)
                    for b in final.content
                ]
                messages.append({"role": "assistant", "content": content_dicts})
                messages.append({"role": "user", "content": tool_results})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue

            yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'output': total_out, 'cache_read': total_cache_read})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'error', 'detail': '这步操作有点多，咕咕没在一口气里全做完 😅 前面几步已经生效了，要我接着把剩下的做完吗？'}, ensure_ascii=False)}\n\n"

    # ── OpenAI ──────────────────────────────────────────────────────────────
    async def _run_openai(self, user_id, messages: list, ai=None) -> AsyncGenerator[str, None]:
        import httpx
        from openai import AsyncOpenAI

        settings = self.settings
        ai = ai if ai is not None else settings.ai
        tools = registry.openai_schemas(self.tool_names)
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        client = AsyncOpenAI(
            api_key=ai.api_key or "dummy",
            base_url=ai.base_url,
            timeout=_timeout,
        )

        max_tokens  = ai.max_tokens
        temperature = ai.temperature
        total_in = total_out = 0
        for _ in range(MAX_ROUNDS):
            if await _im_cancelled():
                yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                return
            stream = await client.chat.completions.create(
                model=ai.model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                max_tokens=max_tokens,
                temperature=temperature,
                stream=True,
                stream_options={"include_usage": True},
            )
            content = ""
            tool_buf: dict[int, dict] = {}   # index → {id, name, args}，流式分片累积
            announced = False                # 工具参数流式期间先亮个指示，免得前端空窗以为卡死
            _tok = 0
            async for chunk in stream:
                if getattr(chunk, "usage", None):
                    total_in  += chunk.usage.prompt_tokens or 0
                    total_out += chunk.usage.completion_tokens or 0
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    content += delta.content
                    yield f"data: {json.dumps({'type': 'token', 'content': delta.content})}\n\n"
                    # 流式途中协作检查取消（同 Anthropic 路：单轮长回答只能在这里掐断）
                    _tok += 1
                    if _tok % _CANCEL_CHECK_EVERY == 0 and await _im_cancelled():
                        try:
                            await stream.close()
                        except Exception:
                            pass
                        yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                        return
                if delta.tool_calls and not announced:
                    # 工具调用开始（此后在流式输出工具参数，可能很长，无 token、tool_call 也要等参数收完才发）
                    announced = True
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': '_preparing', 'label': '咕咕正在整理…'}, ensure_ascii=False)}\n\n"
                for tc in (delta.tool_calls or []):
                    b = tool_buf.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                    if tc.id:
                        b["id"] = tc.id
                    if tc.function and tc.function.name:
                        b["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        b["args"] += tc.function.arguments

            if tool_buf:
                ordered = [tool_buf[i] for i in sorted(tool_buf)]
                messages.append({
                    "role": "assistant",
                    "content": content or None,
                    "tool_calls": [
                        {"id": b["id"], "type": "function",
                         "function": {"name": b["name"], "arguments": b["args"]}}
                        for b in ordered
                    ],
                })
                for b in ordered:
                    label = self.labels.get(b["name"], b["name"])
                    try:
                        args = json.loads(b["args"])
                    except Exception:
                        # 参数 JSON 解析失败（常见于长内容被 max_tokens 截断）→ 记下原文便于排查
                        print(f"[core] 工具 {b['name']} 参数解析失败(疑似 max_tokens 截断), "
                              f"len={len(b['args'])} 尾部={b['args'][-120:]!r}", flush=True)
                        args = {}
                    await _im_set_tool_state(b["name"])
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': b['name'], 'label': label, 'input': args}, ensure_ascii=False)}\n\n"
                    result, artifact = await registry.dispatch(user_id, b["name"], args)
                    yield f"data: {json.dumps({'type': 'tool_done', 'name': b['name'], 'label': label}, ensure_ascii=False)}\n\n"
                    if artifact:
                        yield f"data: {json.dumps({'type': 'file', 'file': artifact}, ensure_ascii=False)}\n\n"
                    messages.append({
                        "role": "tool",
                        "tool_call_id": b["id"],
                        "content": result,
                    })
                continue

            # 无工具调用：正文已逐 token 流式输出完毕
            yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'output': total_out})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'error', 'detail': '这步操作有点多，咕咕没在一口气里全做完 😅 前面几步已经生效了，要我接着把剩下的做完吗？'}, ensure_ascii=False)}\n\n"
