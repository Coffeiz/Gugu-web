"""LLM 主循环（迁自原 agent.py 的 _loop_anthropic / _loop_openai）。

Anthropic 路：单次流式调用（带 tools）—— 实时流式输出文本的同时，结束后从
get_final_message 取 tool_use；有工具则执行（走 skills.registry）回填后继续，
无工具则收尾。一次调用兼顾流式与工具检测，既保留真流式、又无"双调用敷衍"。
OpenAI 路：非流式探测工具 → 无工具时分块输出已生成文本。工具 schema 由 profile
启用的工具名从 registry 派生，消除手写双格式。temperature 已加到调用上保证离散度生效。
"""
import json
from typing import AsyncGenerator

from agent.skills import registry

MAX_ROUNDS = 5


class LLMRunner:
    """provider 无关的工具循环执行器。"""

    def __init__(self, tool_names: list[str], settings):
        self.tool_names = tool_names
        self.settings = settings
        self.labels = registry.labels()

    def run(self, user_id, system_text: str, messages: list,
            use_anthropic: bool) -> AsyncGenerator[str, None]:
        if use_anthropic:
            return self._run_anthropic(user_id, system_text, messages)
        return self._run_openai(user_id, messages)

    # ── Anthropic（MiniMax / Anthropic）─────────────────────────────────────
    async def _run_anthropic(self, user_id, system_text: str,
                             messages: list) -> AsyncGenerator[str, None]:
        import httpx
        from anthropic import AsyncAnthropic

        settings = self.settings
        tools = registry.anthropic_schemas(self.tool_names)
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        client = AsyncAnthropic(
            api_key=settings.ai.api_key or "dummy",
            base_url=settings.ai.base_url,
            http_client=httpx.AsyncClient(timeout=_timeout),
        )

        total_in = total_out = total_cache_read = 0
        max_tokens  = settings.ai.max_tokens
        temperature = settings.ai.temperature
        thinking_val = getattr(settings.ai, "thinking", "disabled")
        thinking_param = {"thinking": {"type": thinking_val}} if thinking_val == "adaptive" else {}

        # prompt 缓存：把 system（含人格/记忆/上下文）作为稳定前缀缓存。
        # Anthropic 顺序 tools→system→messages，断点打在 system 即缓存 tools+system，
        # 多轮工具循环只重算新增 messages，命中后读取便宜 ~90%。
        system_param = (
            [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}]
            if system_text else system_text
        )

        for _ in range(MAX_ROUNDS):
            # 单次流式调用：既实时流式输出文本，又能拿到 tool_use（无双调用、无敷衍）
            async with client.messages.stream(
                model=settings.ai.model,
                system=system_param,
                messages=messages,
                tools=tools,
                max_tokens=max_tokens,
                temperature=temperature,
                **thinking_param,
            ) as stream:
                async for delta in stream.text_stream:
                    yield f"data: {json.dumps({'type': 'token', 'content': delta})}\n\n"
                final = await stream.get_final_message()

            total_in  += final.usage.input_tokens
            total_out += final.usage.output_tokens
            total_cache_read += getattr(final.usage, "cache_read_input_tokens", 0) or 0

            tool_blocks = [b for b in final.content if b.type == "tool_use"]
            if tool_blocks:
                tool_results = []
                for block in tool_blocks:
                    label = self.labels.get(block.name, block.name)
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': block.name, 'label': label, 'input': block.input}, ensure_ascii=False)}\n\n"
                    result = await registry.dispatch(user_id, block.name, block.input)
                    yield f"data: {json.dumps({'type': 'tool_done', 'name': block.name, 'label': label}, ensure_ascii=False)}\n\n"
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

        yield f"data: {json.dumps({'type': 'error', 'detail': '工具调用轮次超限'})}\n\n"

    # ── OpenAI ──────────────────────────────────────────────────────────────
    async def _run_openai(self, user_id, messages: list) -> AsyncGenerator[str, None]:
        import httpx
        from openai import AsyncOpenAI

        settings = self.settings
        tools = registry.openai_schemas(self.tool_names)
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        client = AsyncOpenAI(
            api_key=settings.ai.api_key or "dummy",
            base_url=settings.ai.base_url,
            timeout=_timeout,
        )

        max_tokens  = settings.ai.max_tokens
        temperature = settings.ai.temperature
        total_in = total_out = 0
        for _ in range(MAX_ROUNDS):
            resp = await client.chat.completions.create(
                model=settings.ai.model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                max_tokens=max_tokens,
                temperature=temperature,
            )
            if resp.usage:
                total_in  += resp.usage.prompt_tokens
                total_out += resp.usage.completion_tokens
            msg = resp.choices[0].message

            if msg.tool_calls:
                messages.append(msg)
                for tc in msg.tool_calls:
                    label = self.labels.get(tc.function.name, tc.function.name)
                    try:
                        args = json.loads(tc.function.arguments)
                    except Exception:
                        args = {}
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': tc.function.name, 'label': label, 'input': args}, ensure_ascii=False)}\n\n"
                    result = await registry.dispatch(user_id, tc.function.name, args)
                    yield f"data: {json.dumps({'type': 'tool_done', 'name': tc.function.name, 'label': label}, ensure_ascii=False)}\n\n"
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": result,
                    })
                continue

            # 无工具调用：首次调用已生成完整答复，直接输出，不再发第二次请求。
            text = msg.content or ""
            for i in range(0, len(text), 40):
                yield f"data: {json.dumps({'type': 'token', 'content': text[i:i + 40]})}\n\n"

            yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'output': total_out})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'error', 'detail': '工具调用轮次超限'})}\n\n"
