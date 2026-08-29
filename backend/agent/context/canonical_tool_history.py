"""工具声明与调用的 provider-neutral 历史格式。

Canonical event 只存在于内部历史；发送给 Provider 前由 adapter 渲染成普通文本，
不会伪装成 ``tool_result``，也不会把某一家 Provider 的 wire format 持久化为长期契约。
"""
from __future__ import annotations

import hashlib
import inspect
import json
import copy
from dataclasses import asdict, dataclass
from typing import Any


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def schema_digest(schema: dict) -> str:
    return hashlib.sha256(_canonical_json(schema).encode("utf-8")).hexdigest()[:16]


def implementation_digest(tool) -> str:
    """按处理函数源码生成实现指纹，区分 Schema 不变但行为已更新的工具。"""
    handler = getattr(tool, "handler", None)
    try:
        source = inspect.getsource(handler)
    except (OSError, TypeError):
        source = ""
    identity = "|".join((
        str(getattr(handler, "__module__", "")),
        str(getattr(handler, "__qualname__", "")),
        source,
    ))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]


_CANONICAL_EVENT_TYPES = frozenset({
    "tool_call", "tool_result", "tool-schema", "skill-schema", "tool-discovery",
    "knowledge-context", "stance-context", "time-context", "runtime-context",
})

_PROVIDER_TEXT_EVENT_TYPES = frozenset({
    "tool-schema", "skill-schema", "tool-discovery", "knowledge-context",
    "stance-context", "time-context", "runtime-context",
})


def _tool_result_is_error(block: dict[str, Any]) -> bool:
    """从 provider-neutral 结果中判断失败，不读取或记录结果正文。"""
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


@dataclass
class ToolCall:
    """Provider-neutral 的工具调用。

    ``input`` 统一采用 Anthropic 侧更直观的命名；写入 canonical history 时
    转成稳定的 ``arguments`` 字段，provider adapter 再负责渲染成各自格式。
    """

    id: str
    name: str
    input: Any

    @property
    def arguments(self) -> Any:
        """兼容 OpenAI 语义的只读别名，避免调用方重复转换字段。"""
        return self.input

    @classmethod
    def from_block(cls, block: dict[str, Any]) -> "ToolCall":
        value = block.get("arguments", block.get("input", {}))
        return cls(
            id=str(block.get("id") or block.get("tool_call_id") or block.get("tool_use_id") or "tool-call"),
            name=str(block.get("name") or "unknown_tool"),
            input=value if isinstance(value, (dict, list, str)) else {},
        )

    def to_block(self) -> dict[str, Any]:
        return {
            "type": "tool_call",
            "id": self.id,
            "name": self.name,
            "arguments": self.input,
        }


@dataclass
class ToolResult:
    """Provider-neutral 的工具结果，保留错误状态供 adapter 和 UI 判断。"""

    tool_call_id: str
    content: Any
    is_error: bool = False
    tool_name: str | None = None

    @classmethod
    def from_block(cls, block: dict[str, Any]) -> "ToolResult":
        return cls(
            tool_call_id=str(block.get("tool_call_id") or block.get("tool_use_id") or ""),
            content=block.get("content", ""),
            is_error=_tool_result_is_error(block),
            tool_name=str(block["tool_name"]) if block.get("tool_name") else None,
        )

    def to_block(self) -> dict[str, Any]:
        block: dict[str, Any] = {
            "type": "tool_result",
            "tool_call_id": self.tool_call_id,
            "content": self.content,
        }
        if self.is_error:
            block["is_error"] = True
        if self.tool_name:
            block["tool_name"] = self.tool_name
        return block


def canonical_event_stats(messages: list[dict]) -> dict[str, Any]:
    """汇总 canonical history 的脱敏统计，不返回工具参数或正文。"""
    by_type: dict[str, int] = {}
    digests: set[str] = set()
    count = 0
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        blocks = content if isinstance(content, list) else []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            event_type = str(block.get("type") or "")
            if event_type not in _CANONICAL_EVENT_TYPES:
                continue
            count += 1
            by_type[event_type] = by_type.get(event_type, 0) + 1
            digest = str(block.get("schema_digest") or "")
            if digest:
                digests.add(digest)
    return {
        "count": count,
        "by_type": dict(sorted(by_type.items())),
        "schema_digests": sorted(digests),
    }


def canonical_tool_round(result: Any, dispatched: list[tuple[Any, Any]]) -> list[dict]:
    """从统一的 round 结果直接构造 canonical 工具批次。

    这里刻意不接收 Provider wire message。Provider 的 assistant/tool 消息可能
    使用不同 role、字段名和图片包装；如果先拼 wire 再反向归一化，容易把
    Provider 形状误当成历史事实，也会让 batch 包装在跨 provider 时漂移。
    """
    assistant_blocks: list[dict] = []
    text = str(getattr(result, "text", "") or "")
    if text:
        assistant_blocks.append({"type": "text", "text": text})
    for call in getattr(result, "tool_calls", ()) or ():
        if not getattr(call, "id", None) or not getattr(call, "name", None):
            continue
        assistant_blocks.append(ToolCall(
            id=str(call.id),
            name=str(call.name),
            input=getattr(call, "input", getattr(call, "arguments", {})),
        ).to_block())

    canonical: list[dict] = []
    if assistant_blocks:
        canonical.append({"role": "assistant", "content": assistant_blocks})

    result_blocks: list[dict] = []
    for call, value in dispatched:
        result_blocks.append(ToolResult(
            tool_call_id=str(getattr(call, "id", "")),
            content=value,
            is_error=_tool_result_is_error({"content": value}),
            tool_name=str(getattr(call, "name", "")) or None,
        ).to_block())
    if result_blocks:
        canonical.append({"role": "user", "content": result_blocks})
    return canonical


@dataclass(frozen=True)
class ToolSchemaEvent:
    tool_name: str
    schema_version: int
    schema_digest: str
    schema: dict
    implementation_digest: str = ""
    event_type: str = "tool-schema"

    def to_block(self) -> dict:
        return {"type": self.event_type, **asdict(self)}


@dataclass(frozen=True)
class SkillSchemaEvent:
    skill_name: str
    tool_names: tuple[str, ...]
    event_type: str = "skill-schema"

    def to_block(self) -> dict:
        return {"type": self.event_type, **asdict(self)}


@dataclass(frozen=True)
class ToolDiscoveryEvent:
    tool_names: tuple[str, ...]
    event_type: str = "tool-discovery"

    def to_block(self) -> dict:
        return {"type": self.event_type, **asdict(self)}


def tool_schema_event(tool) -> ToolSchemaEvent:
    schema = {
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.input_schema,
    }
    return ToolSchemaEvent(
        tool_name=tool.name,
        schema_version=int(getattr(tool, "schema_version", 1) or 1),
        schema_digest=schema_digest(schema),
        schema=schema,
        implementation_digest=implementation_digest(tool),
    )


def append_event(messages: list[dict], event) -> None:
    """追加一个可重放的 canonical event；相同版本/digest 不重复追加。"""
    block = event.to_block()
    key = (
        block.get("type"), block.get("tool_name"), block.get("schema_digest"),
        block.get("implementation_digest"), block.get("skill_name"),
    )
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        blocks = content if isinstance(content, list) else []
        for existing in blocks:
            if not isinstance(existing, dict):
                continue
            existing_key = (
                existing.get("type"), existing.get("tool_name"),
                existing.get("schema_digest"), existing.get("implementation_digest"),
                existing.get("skill_name"),
            )
            if existing_key == key:
                return
    messages.append({"role": "user", "content": [block]})


def event_text(block: dict) -> str:
    """把 canonical event 渲染成模型可读、但不依赖 Provider schema 的文本。"""
    kind = block.get("type")
    if kind == "tool-schema":
        schema = block.get("schema") or {}
        return (
            "[canonical tool-schema]\n"
            f"工具名：{block.get('tool_name', '')}\n"
            f"版本：{block.get('schema_version', 1)}\n"
            f"Schema：{_canonical_json(schema)}"
        )
    if kind == "skill-schema":
        names = ", ".join(str(item) for item in block.get("tool_names") or ())
        return f"[canonical skill-schema]\n技能：{block.get('skill_name', '')}\n关联工具：{names}"
    if kind == "tool-discovery":
        names = ", ".join(str(item) for item in block.get("tool_names") or ())
        return f"[canonical tool-discovery]\n可用工具：{names}"
    if kind in {"knowledge-context", "stance-context", "time-context", "runtime-context"}:
        return str(block.get("text") or "")
    return ""


def render_events_for_provider(messages: list[dict]) -> list[dict]:
    """复制并原位渲染 canonical blocks，同时保留 PromptMessages 的边界元数据。

    canonical event 必须在原 block 位置转换成 provider text。不能先摘出再统一
    append 到 content 尾部，否则 ``[time-context, user text]`` 会被翻成
    ``[user text, time-context]``，下一 run 从持久化 history 恢复后前缀立刻失配。
    dynamic tail 也是 provider boundary 的一部分：只随本次请求渲染并保持在末尾，
    但绝不混进 conversation/canonical history。
    """
    conversation_count = len(getattr(messages, "conversation", messages))
    is_prompt_messages = hasattr(messages, "fixed_prefix_size")
    rendered: list[dict] = []
    for message in messages:
        clone = dict(message)
        content = clone.get("content")
        if isinstance(content, list):
            rendered_content: list[Any] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") in _PROVIDER_TEXT_EVENT_TYPES:
                    text = event_text(block)
                    if text:
                        rendered_content.append({"type": "text", "text": text})
                else:
                    rendered_content.append(block)
            clone["content"] = rendered_content
        rendered.append(clone)

    if not is_prompt_messages:
        return rendered

    # 延迟导入避免 assembly 与 canonical history 之间形成模块级循环依赖。
    from agent.context.assembly import PromptMessages

    result = PromptMessages(
        rendered[:conversation_count],
        fixed_prefix_size=getattr(messages, "fixed_prefix_size", 0),
    )
    # conversation 之后的内容只可能是 provider-only dynamic tail。原位渲染后
    # 重新挂回 PromptMessages，后续 cache helper 才能继续把断点限制在稳定前缀。
    if len(rendered) > conversation_count:
        result.set_dynamic_tail(rendered[conversation_count:])
    canonical_context = getattr(messages, "canonical_context", None)
    if canonical_context is not None:
        result.canonical_context = canonical_context
    result._canonical_batches = list(getattr(messages, "_canonical_batches", ()))
    result._canonical_batch_digests = list(
        getattr(messages, "_canonical_batch_digests", ())
    )
    result._canonical_batch_metadata = copy.deepcopy(list(
        getattr(messages, "_canonical_batch_metadata", ())
    ))
    remember_anchor = getattr(result, "remember_cache_anchor", None)
    if remember_anchor is not None:
        for index in getattr(messages, "cache_anchor_indices", ()):
            remember_anchor(index)
    return result
