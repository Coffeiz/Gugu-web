"""OpenAI Responses API 的 provider driver。

Responses 的 response-chain 和流式事件协议与 Chat Completions 不同，单独放置
以保持共享 loop driver 模块聚焦于通用协议和其它 provider。
"""
from __future__ import annotations

import copy
import hashlib
import json

from dataclasses import dataclass
from typing import Any

from agent.providers.message_utils import _openai_tool_result


# OpenAI Responses（独立于 Chat Completions 的 response chain）
# ══════════════════════════════════════════════════════════════════════════

@dataclass
class _ResponsesCtx:
    tools: list
    max_output_tokens: int
    model: str
    instructions: str | None
    adapter: Any
    ai: Any
    previous_response_id: str | None = None
    tool_state_digest: str = ""


@dataclass
class _ResponsesRaw:
    content: str
    response_id: str | None
    previous_response_id: str | None
    tool_calls_payload: list[dict]
    output_items: list[dict]


def _responses_tools(tools: list[dict]) -> list[dict]:
    """把 Chat Completions function schema 转成 Responses function schema。"""
    result = []
    for tool in tools:
        function = tool.get("function") if isinstance(tool, dict) else None
        if not isinstance(function, dict) or not function.get("name"):
            continue
        result.append({
            "type": "function",
            "name": function["name"],
            "description": function.get("description") or "",
            "parameters": function.get("parameters") or {"type": "object"},
        })
    return result


def _responses_input(messages: list[dict]) -> list[dict]:
    """将现有 OpenAI 投影转换成 Responses input items。"""
    items: list[dict] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "system":
            continue
        if role == "assistant" and message.get("tool_calls"):
            if message.get("content"):
                items.append({"role": "assistant", "content": message["content"]})
            for call in message["tool_calls"]:
                function = call.get("function") or {}
                items.append({
                    "type": "function_call",
                    "call_id": call.get("id") or call.get("call_id") or "tool-call",
                    "name": function.get("name") or "unknown_tool",
                    "arguments": function.get("arguments") or "{}",
                })
            continue
        if role == "tool":
            items.append({
                "type": "function_call_output",
                "call_id": message.get("tool_call_id") or message.get("call_id") or "tool-call",
                "output": message.get("content") or "",
            })
            continue
        if role in {"user", "assistant"}:
            items.append({"role": role, "content": message.get("content") or ""})
    return items


class OpenAIResponsesDriver:
    """OpenAI Responses API 驱动；不复用 Chat Completions 的 continuation 语义。"""

    api_format = "responses"
    continuation_available = True

    def prepare(self, tool_names, ai, messages, system_text):
        import httpx
        from agent import providers
        from agent.tools import registry

        client = providers.build_openai_client(
            ai, httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=5.0)
        )
        chat_tools = registry.openai_schemas(tool_names)
        tools = _responses_tools(chat_tools)
        return client, _ResponsesCtx(
            tools=tools, max_output_tokens=ai.max_tokens, model=ai.model,
            instructions=system_text, adapter=providers.adapter_for(ai), ai=ai,
            tool_state_digest=hashlib.sha256(json.dumps(
                tools, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")).hexdigest()[:16],
        )

    def update_tools(self, ctx, tool_names: list[str]) -> None:
        from agent.tools import registry
        ctx.tools = _responses_tools(registry.openai_schemas(tool_names))

    async def run_round(self, client, ctx, messages):
        rendered = ctx.adapter.render_history(messages)
        if ctx.previous_response_id:
            # response chain 已经包含旧历史；只发送上一个 response 之后的增量，
            # 但仍在每次请求显式发送 instructions/tools。
            last_assistant = max(
                (index for index, item in enumerate(rendered)
                 if isinstance(item, dict) and item.get("role") == "assistant"),
                default=-1,
            )
            rendered = rendered[last_assistant + 1:] or rendered[-1:]
        request = {
            "model": ctx.model,
            "instructions": ctx.instructions,
            "input": _responses_input(rendered),
            "max_output_tokens": ctx.max_output_tokens,
            "tools": ctx.tools,
            "stream": True,
        }
        if ctx.previous_response_id:
            request["previous_response_id"] = ctx.previous_response_id
        effort = getattr(ctx.ai, "reasoning_effort", "") or ""
        if effort:
            request["reasoning"] = {"effort": effort}
        # Responses continuation 依赖服务端 response chain；只有明确配置为 False
        # 时才关闭存储。该值会随 reasoning config fingerprint 参与状态匹配。
        request["store"] = bool(getattr(ctx.ai, "store", True))

        stream = await client.responses.create(**{key: value for key, value in request.items()
                                                  if value is not None})
        content = ""
        response_id = None
        previous_response_id = ctx.previous_response_id
        output_items: dict[str, dict] = {}
        tool_buf: dict[str, dict] = {}
        usage_in = usage_out = 0
        try:
            async for event in stream:
                event_type = str(getattr(event, "type", "") or "")
                if event_type == "response.output_text.delta":
                    delta = str(getattr(event, "delta", "") or "")
                    content += delta
                    if delta:
                        yield ("token", delta)
                elif event_type == "response.output_item.added":
                    item = getattr(event, "item", None)
                    item = item.model_dump() if hasattr(item, "model_dump") else item
                    if isinstance(item, dict):
                        key = str(item.get("id") or item.get("call_id") or len(output_items))
                        output_items[key] = copy.deepcopy(item)
                elif event_type == "response.function_call_arguments.delta":
                    item_id = str(getattr(event, "item_id", "") or "")
                    buf = tool_buf.setdefault(item_id, {"id": item_id, "name": "", "args": ""})
                    buf["args"] += str(getattr(event, "delta", "") or "")
                elif event_type == "response.output_item.done":
                    item = getattr(event, "item", None)
                    item = item.model_dump() if hasattr(item, "model_dump") else item
                    if isinstance(item, dict):
                        key = str(item.get("id") or item.get("call_id") or len(output_items))
                        output_items[key] = copy.deepcopy(item)
                elif event_type == "response.completed":
                    response = getattr(event, "response", None)
                    response_data = response.model_dump() if hasattr(response, "model_dump") else response
                    if isinstance(response_data, dict):
                        response_id = str(response_data.get("id") or "") or None
                        previous_response_id = response_data.get("previous_response_id") or previous_response_id
                        usage = response_data.get("usage") or {}
                        usage_in = int(usage.get("input_tokens") or 0)
                        usage_out = int(usage.get("output_tokens") or 0)
                        for item in response_data.get("output") or []:
                            if isinstance(item, dict):
                                key = str(item.get("id") or item.get("call_id") or len(output_items))
                                output_items[key] = copy.deepcopy(item)
        finally:
            try:
                await stream.close()
            except Exception:
                pass

        ordered = list(output_items.values())
        tool_payload = []
        from agent.loop_drivers import NormalizedToolCall, RoundResult

        normalized = []
        for item in ordered:
            if item.get("type") != "function_call":
                continue
            call_id = str(item.get("call_id") or item.get("id") or "tool-call")
            args_text = item.get("arguments") or tool_buf.get(str(item.get("id") or ""), {}).get("args") or "{}"
            name = str(item.get("name") or "unknown_tool")
            tool_payload.append({"id": call_id, "type": "function", "function": {
                "name": name, "arguments": args_text,
            }})
            parse_error = False
            try:
                args = json.loads(args_text)
            except (TypeError, json.JSONDecodeError):
                args = {}
                parse_error = True
            normalized.append(NormalizedToolCall(
                id=call_id, name=name, input=args,
                parse_error=parse_error,
            ))
        if response_id:
            # 先更新上下文再 yield；核心循环在拿到 done 后会结束当前 generator，
            # 不能依赖 yield 之后的代码执行。
            ctx.previous_response_id = response_id
        yield ("done", RoundResult(
            text=content, tool_calls=normalized, requires_tools=bool(normalized),
            usage_in=usage_in, usage_out=usage_out,
            raw=_ResponsesRaw(
                content=content, response_id=response_id,
                previous_response_id=previous_response_id,
                tool_calls_payload=tool_payload, output_items=ordered,
            ),
        ))

    def extract_provider_state(self, result: RoundResult) -> dict | None:
        raw = result.raw
        if not isinstance(raw, _ResponsesRaw) or not raw.response_id:
            return None
        return {
            "state_kind": "openai_responses_chain",
            "payload": {
                "response_id": raw.response_id,
                "previous_response_id": raw.previous_response_id,
            },
            "summary": {
                "response_chain": True,
                "response_id_fingerprint": hashlib.sha256(raw.response_id.encode()).hexdigest()[:16],
            },
        }

    def restore_provider_state(self, ctx: _ResponsesCtx, payload: Any) -> bool:
        response_id = payload.get("response_id") if isinstance(payload, dict) else None
        if not isinstance(response_id, str) or not response_id.strip():
            return False
        ctx.previous_response_id = response_id
        return True

    def _asst(self, raw: _ResponsesRaw, text: str, tool_calls_payload=None) -> dict:
        message = {"role": "assistant", "content": text}
        if tool_calls_payload:
            message["tool_calls"] = tool_calls_payload
        return message

    def build_tool_round(self, result, dispatched, *, allow_images: bool = True):
        from agent.loop_drivers import _dispatched_tool_ids
        dispatched_ids = _dispatched_tool_ids(dispatched)
        raw = result.raw
        calls = [call for call in raw.tool_calls_payload if str(call.get("id")) in dispatched_ids]
        messages = [self._asst(raw, raw.content or None, calls)]
        for tc, res in dispatched:
            content, _images = _openai_tool_result(res, allow_images=allow_images)
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": content})
        return messages

    def build_followup(self, result, next_content, assistant_fallback="（…）"):
        return [self._asst(result.raw, result.text or assistant_fallback), {"role": "user", "content": next_content}]

    def build_guard_followup(self, result, next_content):
        return [self._asst(result.raw, result.text or "（…）"), {"role": "system", "content": next_content}]

    def build_empty_retry(self, result):
        return [{"role": "user", "content": "（把要回复用户的话直接说出来就好，别只在心里想。）"}]
