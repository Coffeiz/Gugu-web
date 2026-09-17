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

from agent.context.budget import is_context_overflow_error
from agent.context.canonical_context import digest
from agent.providers.message_utils import _openai_tool_result


class ResponsesCompatibilityError(RuntimeError):
    """完整 Responses 请求被兼容服务以协议错误拒绝。"""

    def __init__(self, status_code: int):
        self.status_code = int(status_code)
        super().__init__(f"Responses 协议不兼容：HTTP {self.status_code}")


def _raise_if_responses_compatibility_error(exc: Exception) -> None:
    status_code = getattr(exc, "status_code", None)
    # 上下文超限、模型不存在和普通参数错误不能被误判为协议不兼容；它们
    # 应继续交给主循环的原有错误恢复/诊断路径处理。
    if is_context_overflow_error(exc):
        return
    if status_code in {405, 415, 501}:
        raise ResponsesCompatibilityError(status_code) from exc
    if status_code not in {400, 404, 422}:
        return

    searchable = " ".join(
        str(value) for value in (
            str(exc),
            getattr(exc, "code", None),
            getattr(exc, "type", None),
            getattr(exc, "param", None),
            getattr(exc, "message", None),
            getattr(exc, "body", None),
        ) if value is not None
    ).lower()
    compatibility_markers = (
        "json_parse_error",
        "responseinput",
        "response input",
        "responses endpoint",
        "responses api",
        "does not support responses",
        "unsupported responses",
    )
    if any(marker in searchable for marker in compatibility_markers):
        raise ResponsesCompatibilityError(status_code) from exc


def _is_stale_response_tool_call_error(exc: Exception) -> bool:
    """识别 response chain 丢失工具调用 ID 的可恢复错误。

    兼容服务可能在交互暂停后丢失服务端 response chain，但本地仍保留完整的
    assistant/tool 往返。这里只匹配明确的 tool-id 错误，避免把普通 400 当成
    Responses 不兼容或盲目重试。
    """
    searchable = " ".join(
        str(value) for value in (
            str(exc),
            getattr(exc, "code", None),
            getattr(exc, "type", None),
            getattr(exc, "message", None),
            getattr(exc, "body", None),
        ) if value is not None
    ).lower()
    return "tool id" in searchable and "not found" in searchable


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
    supports_active_cache: bool = False
    base_instructions: str | None = None
    snapshot_instructions: str | None = None
    supports_prompt_cache_key: bool = False


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


def _responses_instruction_parts(
    messages: list[dict], system_text: str | None,
) -> tuple[str | None, str | None, str | None]:
    """合并稳定 system prompt 与 snapshot system 消息。

    Responses 的 ``input`` 投影不发送 system 消息；基础 system prompt 由
    ``instructions`` 承载，而 session snapshot 也使用 system role。若只传基础
    prompt，snapshot 会静默丢失；若把 snapshot 改成 user，又会破坏内部上下文边界。
    """
    base = str(system_text).strip() if system_text and str(system_text).strip() else None
    system_messages = [
        str(message.get("content") or "").strip()
        for message in messages
        if isinstance(message, dict)
        and message.get("role") == "system"
        and str(message.get("content") or "").strip()
    ]
    # goal mode 等运行时策略可能追加在 system_text 后面；只要首条消息是
    # instructions 的稳定前缀，就视为已经由调用方传入，避免重复拼接。
    if base and system_messages and base.startswith(system_messages[0]):
        system_messages.pop(0)
    snapshot = "\n\n---\n\n".join(system_messages) or None
    instructions = "\n\n---\n\n".join(
        part for part in (base, snapshot) if part
    ) or None
    return base, snapshot, instructions


def _responses_instructions(messages: list[dict], system_text: str | None) -> str | None:
    """返回 Responses 请求使用的完整 instructions，保留旧调用方接口。"""
    return _responses_instruction_parts(messages, system_text)[2]


def _tool_state_digest(tools: list[dict]) -> str:
    return digest(tools)


def _set_tools(ctx: _ResponsesCtx, tools: list[dict]) -> None:
    ctx.tools = tools
    ctx.tool_state_digest = _tool_state_digest(tools)


def _responses_prompt_cache_key(ctx: _ResponsesCtx) -> str | None:
    if not ctx.supports_prompt_cache_key:
        return None
    cache_key_material = {
        "model": ctx.model,
        "base_instructions": ctx.base_instructions or ctx.instructions or "",
        "tool_state_digest": ctx.tool_state_digest,
    }
    return "gugu-" + digest(cache_key_material, length=32)


class OpenAIResponsesDriver:
    """OpenAI Responses API 驱动；不复用 Chat Completions 的 continuation 语义。"""

    api_format = "responses"
    continuation_available = True

    def prepare(self, tool_names, ai, messages, system_text, tool_snapshot=None):
        import httpx
        from agent import providers
        from agent.tools import registry

        client = providers.build_openai_client(
            ai, httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=5.0)
        )
        schema_source = tool_snapshot or registry.snapshot()
        chat_tools = schema_source.openai_schemas(tool_names)
        tools = _responses_tools(chat_tools)
        adapter = providers.adapter_for(ai)
        base_instructions, snapshot_instructions, instructions = _responses_instruction_parts(
            messages, system_text,
        )
        return client, _ResponsesCtx(
            tools=tools, max_output_tokens=ai.max_tokens, model=ai.model,
            instructions=instructions,
            adapter=adapter, ai=ai,
            supports_active_cache=adapter.supports_active_cache(ai.model),
            tool_state_digest=_tool_state_digest(tools),
            base_instructions=base_instructions,
            snapshot_instructions=snapshot_instructions,
            supports_prompt_cache_key=adapter.supports_responses_prompt_cache_key(ai),
        )

    def update_tools(self, ctx, tool_names: list[str], tool_snapshot=None) -> None:
        from agent.tools import registry
        schema_source = tool_snapshot or registry.snapshot()
        _set_tools(ctx, _responses_tools(schema_source.openai_schemas(tool_names)))

    async def run_round(self, client, ctx, messages, stream_round=None):
        # stream_round 仅 AnthropicDriver 使用；本驱动接收并忽略，保持统一调用签名。
        full_rendered = ctx.adapter.render_history(messages)
        rendered = full_rendered
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
        # Responses 的自动前缀缓存需要稳定的路由 key 才能跨 run 复用；key
        # 只由实际固定前缀身份组成，不包含本轮用户消息或动态工具结果。
        prompt_cache_key = _responses_prompt_cache_key(ctx)
        if prompt_cache_key:
            request["prompt_cache_key"] = prompt_cache_key

        wire_request = {key: value for key, value in request.items() if value is not None}
        try:
            stream = await client.responses.create(**wire_request)
        except Exception as exc:
            # 某些 OpenAI-compatible Responses 服务在 ask_user 等交互暂停期间
            # 不保留原 response chain。恢复时本地历史仍完整，因此用无状态完整
            # 历史重试一次，避免把可恢复的 tool-id 失效误报成通用模型错误。
            if ctx.previous_response_id and _is_stale_response_tool_call_error(exc):
                retry_request = dict(wire_request)
                retry_request.pop("previous_response_id", None)
                retry_request["input"] = _responses_input(full_rendered)
                try:
                    stream = await client.responses.create(**retry_request)
                except Exception as retry_exc:
                    _raise_if_responses_compatibility_error(retry_exc)
                    raise
            else:
                _raise_if_responses_compatibility_error(exc)
                raise
        content = ""
        response_id = None
        previous_response_id = ctx.previous_response_id
        output_items: dict[str, dict] = {}
        tool_buf: dict[str, dict] = {}
        usage_in = usage_out = cache_read = cache_write = 0
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
                        from agent.usage import normalize_responses_usage

                        normalized_usage = normalize_responses_usage(usage)
                        usage_in = normalized_usage["input"]
                        usage_out = normalized_usage["output"]
                        cache_read = normalized_usage["cache_read"]
                        cache_write = normalized_usage["cache_write"]
                        for item in response_data.get("output") or []:
                            if isinstance(item, dict):
                                key = str(item.get("id") or item.get("call_id") or len(output_items))
                                output_items[key] = copy.deepcopy(item)
        except Exception as exc:
            _raise_if_responses_compatibility_error(exc)
            raise
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
                raw_arguments=args_text if not parse_error else None,
            ))
        if response_id:
            # 先更新上下文再 yield；核心循环在拿到 done 后会结束当前 generator，
            # 不能依赖 yield 之后的代码执行。
            ctx.previous_response_id = response_id
        yield ("done", RoundResult(
            text=content, tool_calls=normalized, requires_tools=bool(normalized),
            usage_in=usage_in, usage_out=usage_out,
            cache_tokens=cache_read, cache_write_tokens=cache_write,
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
        visual_parts: list[dict] = []
        for tc, res in dispatched:
            content, images = _openai_tool_result(res, allow_images=allow_images)
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": content})
            visual_parts.extend(images)
        if visual_parts:
            # _openai_tool_result 使用 Chat Completions 的 image_url 形状；Responses
            # 要求同一内容改成 input_image，不能只把图片列表丢掉。
            input_images = []
            for part in visual_parts:
                image_url = part.get("image_url") if isinstance(part, dict) else None
                if not isinstance(image_url, dict) or not image_url.get("url"):
                    continue
                input_images.append({
                    "type": "input_image",
                    "image_url": image_url["url"],
                    "detail": image_url.get("detail", "auto"),
                })
            if input_images:
                messages.append({
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "工具返回了以下图片，请结合工具文字结果继续处理。"},
                        *input_images,
                    ],
                })
        return messages

    def build_followup(self, result, next_content, assistant_fallback="（…）"):
        return [self._asst(result.raw, result.text or assistant_fallback), {"role": "user", "content": next_content}]

    def build_guard_followup(self, result, next_content):
        return [self._asst(result.raw, result.text or "（…）"), {"role": "system", "content": next_content}]

    def build_empty_retry(self, result):
        return [{"role": "user", "content": "（把要回复用户的话直接说出来就好，别只在心里想。）"}]
