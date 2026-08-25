"""把持久化的会话历史转换成 provider 可接受的消息结构。"""
from __future__ import annotations

import json
from typing import Iterable

from .tokens import content_text
from .canonical_tool_history import ToolCall, ToolResult, event_text
from .canonical_context import HistoryEnvelope, normalize_history_message
from .provider_history import strip_thinking_blocks

_SUMMARY_HEADER = "## 早前对话摘要（供参考，非最新消息）"


def build_canonical_history_envelopes(history: Iterable, *, source: str | None = None) -> list[HistoryEnvelope]:
    """从 ORM/平台历史恢复 provider-neutral envelope，不改变原始消息。"""
    return [normalize_history_message(message, source=source) for message in history]


def _summary_content(message) -> str:
    """将持久化 baseline 摘要恢复为普通历史 user 消息。"""
    text = (getattr(message, "content", "") or "").strip()
    return f"\n\n{_SUMMARY_HEADER}\n{text}"


def _tool_label(tool_name: str) -> str:
    """读取工具注册表中的用户可见名称，历史恢复时与实时 SSE 保持一致。"""
    try:
        from agent.tools import registry
        tool = registry.get(tool_name)
        return str(tool.label if tool else tool_name)
    except Exception:
        # 历史数据可能包含已移除的旧工具；名称仍比丢失整条时间线更有用。
        return tool_name


def _display_tool_call(block: dict) -> tuple[str, object]:
    """把持久化的工具调用转换成聊天 UI 使用的业务工具名和参数。

    固定 Adapter 模式下，canonical history 必须保留外层 ``call_tool``，
    这样 provider 之间可以继续复用同一套历史协议；真实业务工具名在
    ``arguments.name`` 中。这里仅在恢复 UI 工具气泡时解包，不能改写
    canonical history 本身。
    """
    tool_name = str(block.get("name") or "unknown_tool")
    tool_input = block.get("arguments", block.get("input", {}))
    adapter_input = tool_input
    if isinstance(adapter_input, str):
        try:
            parsed = json.loads(adapter_input)
        except (TypeError, json.JSONDecodeError):
            parsed = None
        if isinstance(parsed, dict):
            adapter_input = parsed
    if tool_name == "call_tool" and isinstance(adapter_input, dict):
        target_name = str(adapter_input.get("name") or "").strip()
        target_arguments = adapter_input.get("arguments")
        if target_name:
            return target_name, target_arguments if isinstance(target_arguments, dict) else {}
    return tool_name, tool_input


def _display_tool_result_name(block: dict) -> str:
    """兼容旧记录里结果块携带 Adapter 工具名的情况。"""
    tool_name = str(block.get("tool_name") or "").strip()
    if tool_name == "call_tool":
        result_input = block.get("input")
        if isinstance(result_input, dict):
            target_name = str(result_input.get("name") or "").strip()
            if target_name:
                return target_name
    return tool_name


def build_chat_tool_events(messages: Iterable) -> list[dict]:
    """把持久化的 canonical tool turn 聚合成聊天 UI 的工具气泡。"""
    # 不假设数据库中的块顺序永远是 call -> result。旧数据、跨 provider
    # 持久化或事务边界都可能让 result 先被扫描到；先收集调用，再合并结果，
    # 避免先创建「工具调用」占位事件后丢失真实工具名。
    events: dict[str, dict] = {}
    pending_results: list[tuple[str, dict, object]] = []
    for message in messages:
        content_json = getattr(message, "content_json", None)
        for index, block in enumerate(_blocks(content_json)):
            block_type = block.get("type")
            if block_type in ("tool_call", "tool_use"):
                call_id = str(block.get("id") or f"message-{message.id}-{index}")
                tool_name, tool_input = _display_tool_call(block)
                events[call_id] = {
                    "id": f"tool:{call_id}",
                    "toolCallId": call_id,
                    "timelineOrder": message.id,
                    "toolName": tool_name,
                    "toolLabel": _tool_label(tool_name),
                    "toolInput": tool_input,
                    "toolStatus": "running",
                    "createdAt": message.created_at,
                }
            elif block_type == "tool_result":
                call_id = str(block.get("tool_call_id") or block.get("tool_use_id") or "")
                if not call_id:
                    continue
                pending_results.append((call_id, block, message))

    for call_id, block, message in pending_results:
        event = events.get(call_id)
        if event is None:
            # 兼容历史中只保存结果块的异常记录；若结果带有 tool_name，
            # 仍可恢复具体名称，否则才退化为通用文案。
            tool_name = _display_tool_result_name(block) or "工具调用"
            event = events.setdefault(call_id, {
                "id": f"tool:{call_id}",
                "toolCallId": call_id,
                "timelineOrder": message.id,
                "toolName": tool_name,
                "toolLabel": _tool_label(tool_name) if tool_name != "工具调用" else "工具调用",
                "toolStatus": "running",
                "createdAt": message.created_at,
            })
        event["toolResult"] = block.get("content", "")
        event["toolStatus"] = "error" if _tool_result_is_error(block) else "success"
        # 工具调用和结果可能跨过消息分页窗口。以结果所在消息作为时间线位置，
        # 这样恢复当前窗口时仍能保留前面已经配对的工具名称和输入。
        event["timelineOrder"] = message.id
        event["updatedAt"] = message.created_at
        event["toolDurationMs"] = max(
            0, int((message.created_at - event["createdAt"]).total_seconds() * 1000)
        )
    return sorted(events.values(), key=lambda item: (item["createdAt"], item["id"]))


def _blocks(value) -> list[dict]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _tool_result_is_error(block: dict) -> bool:
    """识别 canonical/tool wire 中的失败结果，兼容旧数据未保存 is_error 的情况。"""
    if "is_error" in block:
        return bool(block["is_error"])
    content = block.get("content", "")
    values = content if isinstance(content, list) else [content]
    for value in values:
        if isinstance(value, dict) and value.get("error"):
            return True
        if isinstance(value, str):
            try:
                payload = json.loads(value)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict) and payload.get("error"):
                return True
    return False


def _openai_tool_call(block: dict) -> dict:
    arguments = block.get("arguments", block.get("input", {}))
    if not isinstance(arguments, str):
        arguments = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
    return {
        "id": str(block.get("id") or block.get("tool_use_id") or "tool-call"),
        "type": "function",
        "function": {
            "name": str(block.get("name") or "unknown_tool"),
            "arguments": arguments,
        },
    }


def _canonical_block(block: dict) -> dict | None:
    """把 Anthropic/OpenAI 工具块归一为 provider-neutral 结构。"""
    block_type = block.get("type")
    if block_type in ("tool_use", "tool_call"):
        return ToolCall.from_block(block).to_block()
    if block_type == "tool_result":
        return ToolResult.from_block(block).to_block()
    if block_type in ("tool-schema", "skill-schema", "tool-discovery", "knowledge-context"):
        return dict(block)
    return None


def canonicalize_tool_messages(messages: Iterable[dict]) -> list[dict]:
    """提取工具往返并保存成与 provider 无关的历史消息。"""
    result: list[dict] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        canonical: list[dict] = []
        if role == "assistant" and message.get("tool_calls"):
            if isinstance(content, str) and content:
                canonical.append({"type": "text", "text": content})
            for call in message["tool_calls"]:
                function = call.get("function") or {}
                normalized = _canonical_block({
                    "type": "tool_call", "id": call.get("id"),
                    "name": function.get("name"),
                    "arguments": function.get("arguments", "{}"),
                })
                if normalized is not None:
                    canonical.append(normalized)
        elif role == "tool":
            canonical.append(ToolResult(
                tool_call_id=str(message.get("tool_call_id") or ""),
                content=content,
                is_error=_tool_result_is_error(message),
            ).to_block())
        else:
            for block in _blocks(content):
                normalized = _canonical_block(block)
                if normalized is not None:
                    canonical.append(normalized)
                elif role == "assistant" and block.get("type") == "text" and block.get("text"):
                    canonical.append({"type": "text", "text": str(block["text"])})
        if canonical and any(
            block.get("type") in ("tool_call", "tool_result", "tool-schema", "skill-schema", "tool-discovery", "knowledge-context")
            for block in canonical
        ):
            result.append({"role": role, "content": canonical})
    return result


def _anthropic_history_blocks(content_json, *, strip_thinking: bool = False) -> list[dict]:
    converted = []
    for block in _blocks(content_json):
        if strip_thinking and block.get("type") in {"thinking", "reasoning_content"}:
            continue
        block_type = block.get("type")
        if block_type in ("tool_call", "tool_use"):
            arguments = block.get("arguments", block.get("input", {}))
            # 早期 canonical history 可能把 OpenAI 的 function.arguments
            # 以 JSON 字符串持久化；Anthropic/MiniMax 的 tool_use.input
            # 必须是对象，不能把这段字符串原样发回去。
            if isinstance(arguments, str):
                try:
                    parsed = json.loads(arguments)
                except (TypeError, json.JSONDecodeError):
                    parsed = {}
                arguments = parsed if isinstance(parsed, dict) else {}
            elif not isinstance(arguments, dict):
                arguments = {}
            converted.append({
                "type": "tool_use", "id": block.get("id"),
                "name": block.get("name"), "input": arguments,
            })
        elif block_type == "tool_result":
            tool_use_id = block.get("tool_call_id") or block.get("tool_use_id")
            # 没有调用 id 的异常结果无法交给 Anthropic 配对，直接丢弃，避免
            # 发送 tool_use_id=null 触发 BadRequestError。
            if not tool_use_id:
                continue
            result = {
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": block.get("content", ""),
            }
            if "is_error" in block:
                result["is_error"] = block["is_error"]
            converted.append(result)
        elif block_type in ("tool-schema", "skill-schema", "tool-discovery", "knowledge-context"):
            converted.append({"type": "text", "text": event_text(block)})
        else:
            converted.append(block)
    return converted


def _openai_history_message(message, request, *, strip_thinking: bool = False) -> list[dict]:
    content_json = getattr(message, "content_json", None)
    if content_json is None:
        from agent.im.context_loader import format_history_content

        return [{"role": message.role, "content": format_history_content(message, request)}]

    from app.core.chat_attach import strip_vision_for_history
    content_json = strip_vision_for_history(content_json)
    blocks = _blocks(content_json)
    if strip_thinking:
        blocks = [block for block in blocks if block.get("type") not in {"thinking", "reasoning_content"}]
    if not blocks:
        return [{"role": message.role, "content": content_text(content_json)}]

    text_parts: list[str] = []
    tool_calls: list[dict] = []
    tool_results: list[dict] = []
    for block in blocks:
        block_type = block.get("type")
        if block_type in ("tool_use", "tool_call"):
            tool_calls.append(_openai_tool_call(block))
        elif block_type == "tool_result":
            tool_results.append({
                "role": "tool",
                "tool_call_id": str(block.get("tool_call_id") or block.get("tool_use_id") or ""),
                "content": content_text(block.get("content", "")),
            })
        elif block_type in ("tool-schema", "skill-schema", "tool-discovery", "knowledge-context"):
            rendered = event_text(block)
            if rendered:
                text_parts.append(rendered)

        elif block_type == "text":
            if block.get("text"):
                text_parts.append(str(block["text"]))
        else:
            rendered = content_text(block)
            if rendered:
                text_parts.append(rendered)

    if message.role == "user" and not tool_results:
        from agent.im.context_loader import quoted_context_prefix

        quote_prefix = quoted_context_prefix(getattr(message, "quoted_text", None))
        if quote_prefix:
            text_parts.insert(0, quote_prefix)

    from agent.im.context_loader import format_attachment_refs
    attachment_refs = format_attachment_refs(message)
    if attachment_refs:
        text_parts.append(attachment_refs)

    result: list[dict] = []
    if message.role == "assistant" or tool_calls:
        assistant = {"role": "assistant", "content": "\n".join(text_parts) or None}
        if tool_calls:
            assistant["tool_calls"] = tool_calls
        result.append(assistant)
    elif text_parts:
        result.append({"role": message.role, "content": "\n".join(text_parts)})

    result.extend(tool_results)
    return result or [{"role": message.role, "content": content_text(content_json)}]


def build_history_parts(history: Iterable, request, *, use_anthropic: bool,
                        user_tz=None, strip_thinking: bool = False) -> list[dict]:
    """统一构建 history；一条持久化消息可能展开为多个 OpenAI tool 消息。

    用户消息的时间 reminder 要等完整 turn（assistant/tool 结果）组装完再追加。
    RAG 知识块由调用方放在当前用户消息之后的稳定 conversation 区域；这里只负责
    从持久化 history 还原同样的顺序，避免动态尾部与下一轮 history 边界不一致。
    """
    from .session_snapshot import message_time_reminder

    parts: list[dict] = []
    pending_timestamp = None
    for message in history:
        if getattr(message, "role", None) == "summary":
            # summary 是唯一 baseline 的历史起点，不应作为 provider 不认识的
            # role=summary 发送，也不应被放入动态 reminder 尾部。
            parts.append({"role": "user", "content": _summary_content(message)})
            continue
        content_json = getattr(message, "content_json", None)
        blocks = _blocks(content_json)
        is_tool_message = any(block.get("type") == "tool_result" for block in blocks)
        # canonical event 是上一条真实用户 turn 的附属上下文，不是新用户发言。
        # 如果把它们当成 user，会在每个 schema/RAG block 前重复插入 sent_at，
        # 让跨 run 的消息边界与上一轮请求不一致，直接打断 provider cache 前缀。
        is_canonical_event = any(block.get("type") in (
            "knowledge-context", "tool-schema", "skill-schema", "tool-discovery"
        ) for block in blocks)
        is_user_message = (
            getattr(message, "role", None) == "user"
            and not is_tool_message
            and not is_canonical_event
        )

        # 新的真实 user 消息意味着上一个 turn 已经结束；时间 reminder 放在上一个
        # turn 的最后一个 assistant/tool 消息之后，而不是紧贴旧 user 插入。
        if is_user_message and pending_timestamp is not None:
            parts.append(pending_timestamp)
            pending_timestamp = None

        if use_anthropic:
            if content_json is not None:
                from agent.im.context_loader import format_attachment_refs
                from app.core.chat_attach import strip_vision_for_history
                content_json = strip_vision_for_history(content_json)
                attachment_refs = format_attachment_refs(message)
                blocks = _blocks(content_json)
                if any(block.get("type") in (
                    "tool_call", "tool_result", "tool-schema", "skill-schema", "tool-discovery", "knowledge-context"
                ) for block in blocks):
                    content = _anthropic_history_blocks(content_json, strip_thinking=strip_thinking)
                else:
                    content = list(content_json) if isinstance(content_json, list) else content_json
                    if strip_thinking:
                        content = strip_thinking_blocks(content)
                if message.role == "user" and not any(
                    block.get("type") == "tool_result" for block in blocks
                ):
                    from agent.im.context_loader import quoted_context_prefix

                    quote_prefix = quoted_context_prefix(getattr(message, "quoted_text", None))
                    if quote_prefix:
                        if isinstance(content, list):
                            content = [{"type": "text", "text": quote_prefix}, *content]
                        elif isinstance(content, str):
                            content = quote_prefix + content
                if attachment_refs and isinstance(content, list):
                    content = [*content, {"type": "text", "text": attachment_refs}]
                role = "user" if message.role == "tool" else message.role
                parts.append({"role": role, "content": content})
            else:
                from agent.im.context_loader import format_history_content

                parts.append({"role": message.role, "content": format_history_content(message, request)})
        else:
            parts.extend(_openai_history_message(message, request, strip_thinking=strip_thinking))

        if is_user_message:
            timestamp = message_time_reminder(getattr(message, "sent_at", None), user_tz)
            if timestamp:
                pending_timestamp = timestamp

    if pending_timestamp is not None:
        parts.append(pending_timestamp)
    return parts
