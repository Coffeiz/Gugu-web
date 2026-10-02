"""OpenAI Responses API 的 Provider 驱动。"""
from __future__ import annotations

import copy
import json
import time

from dataclasses import dataclass
from typing import Any

from agent.context.budget import is_context_overflow_error
from agent.context.canonical_context import digest
from agent.providers.message_utils import _openai_tool_result, render_provider_history


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


# OpenAI Responses（独立于 Chat Completions 的 item 协议）
# ══════════════════════════════════════════════════════════════════════════

@dataclass
class _ResponsesCtx:
    tools: list
    max_output_tokens: int
    model: str
    instructions: str | None
    adapter: Any
    ai: Any
    reasoning_replay_enabled: bool = False
    reasoning_items: list[dict] | None = None
    tool_state_digest: str = ""
    supports_active_cache: bool = False
    base_instructions: str | None = None
    snapshot_instructions: str | None = None
    supports_prompt_cache_key: bool = False


@dataclass
class _ResponsesRaw:
    content: str
    tool_calls_payload: list[dict]
    output_items: list[dict]


def _responses_reasoning_items(items: list[dict] | None) -> list[dict]:
    """只保留已完成、可回放的 reasoning item；payload 由状态服务加密保存。"""
    result = []
    for item in items or ():
        if not isinstance(item, dict) or item.get("type") != "reasoning":
            continue
        if item.get("status") not in {None, "completed"}:
            continue
        result.append(copy.deepcopy(item))
    return result


def _insert_responses_reasoning_items(
    items: list[dict], reasoning_items: list[dict] | None,
) -> list[dict]:
    """把最新 reasoning item 放在其对应的最近 assistant 输出之前。"""
    if not reasoning_items:
        return items
    assistant_anchors = [
        index for index, item in enumerate(items)
        if isinstance(item, dict) and item.get("role") == "assistant"
    ]
    # 工具调用轮可能同时投影出 assistant 文本与 function_call；reasoning 属于
    # 整个 assistant 输出，必须排在文本/调用项之前，而不是插在两者之间。
    anchors = assistant_anchors or [
        index for index, item in enumerate(items)
        if isinstance(item, dict) and item.get("type") == "function_call"
    ]
    anchor = max(anchors, default=-1)
    if anchor < 0:
        return items
    return [*items[:anchor], *copy.deepcopy(reasoning_items), *items[anchor:]]


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


def _responses_content(content: Any) -> Any:
    """把 Chat Completions 文本内容块转成 Responses input 内容块。"""
    if not isinstance(content, list):
        return content or ""
    return [
        {**part, "type": "input_text"}
        if isinstance(part, dict) and part.get("type") == "text"
        else part
        for part in content
    ]


def _responses_content_is_empty(content: Any) -> bool:
    """判断普通消息是否只有空文本；非文本结构块保持有效。"""
    if content is None:
        return True
    if isinstance(content, str):
        return not content.strip()
    if isinstance(content, list):
        return not any(
            not isinstance(part, dict)
            or part.get("type") not in {"text", "input_text"}
            or str(part.get("text") or "").strip()
            for part in content
        )
    return False


def _responses_input(messages: list[dict]) -> list[dict]:
    """将现有 OpenAI 投影转换成 Responses input items。"""
    items: list[dict] = []
    legacy_call_occurrences: dict[str, int] = {}
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "system":
            continue
        if role == "assistant" and message.get("tool_calls"):
            if message.get("content"):
                items.append({
                    "role": "assistant",
                    "content": _responses_content(message["content"]),
                })
            for call in message["tool_calls"]:
                function = call.get("function") or {}
                call_id = call.get("id") or call.get("call_id") or "tool-call"
                responses_item_id = call.get("responses_item_id")
                if not responses_item_id:
                    # Chat Completions 历史没有 Responses output item id。兼容服务
                    # 回放 function_call 时仍要求该字段；按 call_id 与重复序号生成
                    # 稳定 ID，不把工具参数或会话正文带入 ID，也不改写持久历史。
                    occurrence_key = str(call_id)
                    occurrence = legacy_call_occurrences.get(occurrence_key, 0)
                    legacy_call_occurrences[occurrence_key] = occurrence + 1
                    responses_item_id = "fc_legacy_" + digest(
                        {"call_id": occurrence_key, "occurrence": occurrence},
                        length=24,
                    )
                items.append({
                    "type": "function_call",
                    "id": responses_item_id,
                    "call_id": call_id,
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
            content = _responses_content(message.get("content"))
            if _responses_content_is_empty(content):
                # 丢弃空数组/空文本块，但保留图像等非文本输入块。
                continue
            items.append({"role": role, "content": content})
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


def _responses_output_text(response: Any) -> str:
    """优先提取 message 正文，避免兼容服务的聚合字段混入 reasoning。"""
    raw_output = getattr(response, "output", None)
    if raw_output is None and isinstance(response, dict):
        raw_output = response.get("output")
    if raw_output is None:
        text = getattr(response, "output_text", None)
        if text is None and isinstance(response, dict):
            text = response.get("output_text")
        return text if isinstance(text, str) else ""
    parts: list[str] = []
    for item in raw_output or ():
        item = item.model_dump() if hasattr(item, "model_dump") else item
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content") or ():
            content = content.model_dump() if hasattr(content, "model_dump") else content
            if (isinstance(content, dict)
                    and content.get("type") in {"output_text", "text"}
                    and isinstance(content.get("text"), str)):
                parts.append(content["text"])
    return "".join(parts)


async def complete_branch(
    system_text: str,
    history,
    user: str,
    ai: Any,
    settings,
    *,
    max_output_tokens: int | None,
    tools: list[dict] | None = None,
    json_mode: bool = False,
    usage_sink: list | None = None,
    read_timeout: float | None = None,
) -> str:
    """以完整历史执行独立 Responses 只读分支，不接入主 run 的状态。"""
    import httpx
    from agent import providers

    client = providers.build_openai_client(
        ai, httpx.Timeout(
            connect=10.0, read=read_timeout or 40.0, write=10.0, pool=5.0,
        ),
    )
    adapter = providers.adapter_for(ai)
    from agent.context.provider_conversation import ProviderConversation
    if isinstance(history, ProviderConversation):
        projection = history.with_messages(
            [*history.to_messages(), {"role": "user", "content": user}],
            dynamic_tail_size=1,
        )
    else:
        from agent.context.assembly import MessageArea
        from agent.context.history import render_canonical_area_snapshot
        area = MessageArea.from_canonical_messages(
            history or (),
            render_options={"api_format": adapter.protocol_format(ai)},
        )
        area.set_dynamic_tail([{"role": "user", "content": user}])
        projection = render_canonical_area_snapshot(
            area.snapshot(), source=area, options=area.render_options,
        )
    wire_history = projection.to_messages()
    base_instructions, snapshot_instructions, instructions = _responses_instruction_parts(
        wire_history, system_text,
    )
    branch_tools = list(tools or ())
    request = {
        "model": ai.model,
        "input": _responses_input(wire_history),
        "max_output_tokens": max_output_tokens,
        "tools": branch_tools,
        "store": bool(getattr(ai, "store", True)),
    }
    if instructions:
        request["instructions"] = instructions
    request.update(adapter.build_responses_reasoning_params(ai))
    if json_mode:
        response_format = adapter.build_structured_output(ai).get("response_format")
        if isinstance(response_format, dict):
            format_type = response_format.get("type")
            if format_type == "json_object":
                request["text"] = {"format": {"type": "json_object"}}
            elif format_type == "json_schema":
                schema = response_format.get("json_schema")
                if isinstance(schema, dict) and schema.get("name") and isinstance(schema.get("schema"), dict):
                    request["text"] = {"format": {
                        "type": "json_schema",
                        **schema,
                    }}

    cache_ctx = _ResponsesCtx(
        tools=branch_tools,
        max_output_tokens=max_output_tokens or 0,
        model=ai.model,
        instructions=instructions,
        adapter=adapter,
        ai=ai,
        tool_state_digest=_tool_state_digest(branch_tools),
        base_instructions=base_instructions,
        snapshot_instructions=snapshot_instructions,
        supports_prompt_cache_key=adapter.supports_responses_prompt_cache_key(ai),
    )
    prompt_cache_key = _responses_prompt_cache_key(cache_ctx)
    if prompt_cache_key:
        request["prompt_cache_key"] = prompt_cache_key

    response = await client.responses.create(**request)
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    from agent.usage import normalize_responses_usage, record_current_usage

    normalized_usage = normalize_responses_usage(usage)
    if usage_sink is not None:
        usage_sink.append(normalized_usage)
    await record_current_usage(settings, ai, normalized_usage)
    return _responses_output_text(response)


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
        provider_history = render_provider_history(messages, adapter)
        base_instructions, snapshot_instructions, instructions = _responses_instruction_parts(
            provider_history.to_messages(), system_text,
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

    def configure_reasoning_replay(self, ctx, *, enabled: bool) -> None:
        ctx.reasoning_replay_enabled = bool(enabled)
        if not enabled:
            ctx.reasoning_items = None

    async def run_round(self, client, ctx, messages, stream_round=None):
        # stream_round 仅 AnthropicDriver 使用；本驱动接收并忽略，保持统一调用签名。
        projection = render_provider_history(messages, ctx.adapter)
        full_rendered = projection.to_messages()
        request_input = _insert_responses_reasoning_items(
            _responses_input(full_rendered),
            ctx.reasoning_items if ctx.reasoning_replay_enabled else None,
        )
        if not request_input:
            raise ValueError("Responses 请求没有可发送的输入项")
        request = {
            "model": ctx.model,
            "instructions": ctx.instructions,
            "input": request_input,
            "max_output_tokens": ctx.max_output_tokens,
            "tools": ctx.tools,
            "stream": True,
        }
        request.update(ctx.adapter.build_responses_reasoning_params(ctx.ai))
        if ctx.reasoning_replay_enabled:
            replay_params = getattr(
                ctx.adapter, "build_responses_reasoning_replay_params", None,
            )
            if callable(replay_params):
                request.update(replay_params(ctx.ai))
        request["store"] = bool(getattr(ctx.ai, "store", True))
        # Responses 的自动前缀缓存需要稳定的路由 key 才能跨 run 复用；key
        # 只由实际固定前缀身份组成，不包含本轮用户消息或动态工具结果。
        prompt_cache_key = _responses_prompt_cache_key(ctx)
        if prompt_cache_key:
            request["prompt_cache_key"] = prompt_cache_key

        wire_request = {key: value for key, value in request.items() if value is not None}
        # create 阶段走统一重试节奏（app/core/retry.py）：529/429/瞬时 5xx 绝大多数
        # 落在 create；流式消费阶段的断流仍按原样抛出，避免重复执行同一轮请求。
        from app.core.errors import RetryableError
        from app.core.retry import LLM_RETRY

        started_at = time.monotonic()
        retries_done = 0
        while True:
            try:
                stream = await client.responses.create(**wire_request)
                break
            except Exception as exc:
                from agent.providers.errors import openai_transient_error, openai_error_kind
                if not openai_transient_error(exc):
                    _raise_if_responses_compatibility_error(exc)
                    raise
                if not LLM_RETRY.should_retry(retries_done, started_at):
                    raise RetryableError("llm.stream_exhausted", "LLM 调用重试后仍失败",
                                          cause=exc, attempt=retries_done) from exc
                retries_done += 1
                yield ("retry", {
                    "attempt": retries_done,
                    "max_retries": LLM_RETRY.max_retries,
                    "next_retry_in": LLM_RETRY.interval_seconds,
                    "error_kind": openai_error_kind(exc),
                })
                await LLM_RETRY.pause()
        content = ""
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
            payload = {"id": call_id, "type": "function", "function": {
                "name": name, "arguments": args_text,
            }}
            if item.get("id"):
                payload["responses_item_id"] = str(item["id"])
            tool_payload.append(payload)
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
                responses_item_id=(str(item["id"]) if item.get("id") else None),
            ))
        if ctx.reasoning_replay_enabled:
            # 先更新上下文再 yield；核心循环收到 done 后可能立即结束 generator。
            ctx.reasoning_items = _responses_reasoning_items(ordered)
        yield ("done", RoundResult(
            text=content, tool_calls=normalized, requires_tools=bool(normalized),
            usage_in=usage_in, usage_out=usage_out,
            cache_tokens=cache_read, cache_write_tokens=cache_write,
            raw=_ResponsesRaw(
                content=content, tool_calls_payload=tool_payload, output_items=ordered,
            ),
        ))

    def extract_provider_state(self, result: RoundResult, ctx=None) -> dict | None:
        raw = result.raw
        if not isinstance(raw, _ResponsesRaw):
            return None
        reasoning_items = _responses_reasoning_items(raw.output_items)
        return {
            "state_kind": "openai_responses_reasoning",
            "payload": {"reasoning_items": reasoning_items},
            "summary": {
                "state_block_count": len(reasoning_items),
                "reasoning_items_present": bool(reasoning_items),
            },
        }

    def restore_provider_state(self, ctx: _ResponsesCtx, payload: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        items = payload.get("reasoning_items")
        if not isinstance(items, list) or any(
            not isinstance(item, dict) or item.get("type") != "reasoning"
            or item.get("status") not in {None, "completed"}
            for item in items
        ):
            return False
        ctx.reasoning_items = copy.deepcopy(items) if ctx.reasoning_replay_enabled else None
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
        from agent.context.assembly.batch import request_only_batch
        return request_only_batch([
            self._asst(result.raw, result.text or assistant_fallback),
            {"role": "user", "content": next_content},
        ])

    def build_guard_followup(self, result, next_content):
        from agent.context.assembly.batch import request_only_batch
        return request_only_batch([
            self._asst(result.raw, result.text or "（…）"),
            {"role": "system", "content": next_content},
        ])

    def build_empty_retry(self, result):
        from agent.context.assembly.batch import request_only_batch
        return request_only_batch([{
            "role": "user", "content": "（把要回复用户的话直接说出来就好，别只在心里想。）",
        }])
