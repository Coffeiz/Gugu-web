"""OpenAI-compatible历史适配器入口。"""
from __future__ import annotations

from .context_adapter import ContextAdapter
from agent.context.canonical_tool_history import event_text


class OpenAIHistoryAdapter(ContextAdapter):
    """保留 canonical history，由 provider adapter 统一渲染 OpenAI wire block。"""

    def render_envelope(self, envelope):
        text_parts = []
        tool_calls = []
        tool_results = []
        for block in envelope.content_blocks:
            block_type = block.get("type")
            if block_type in {"tool_call", "tool_use"}:
                arguments = block.get("arguments", block.get("input", {}))
                if not isinstance(arguments, str):
                    import json
                    arguments = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
                tool_calls.append({
                    "id": str(block.get("id") or "tool-call"),
                    "type": "function",
                    "function": {"name": str(block.get("name") or "unknown_tool"), "arguments": arguments},
                })
            elif block_type == "tool_result":
                tool_results.append({
                    "role": "tool",
                    "tool_call_id": str(block.get("tool_call_id") or block.get("tool_use_id") or ""),
                    "content": str(block.get("content") or ""),
                })
            elif block_type == "text":
                if block.get("text"):
                    text_parts.append(str(block["text"]))
            elif block_type in {"quote", "attachment_ref", "transcript", "attachment_text",
                                "tool-schema", "skill-schema", "tool-discovery", "knowledge-context",
                                "interaction_request", "interaction_result"}:
                text_parts.append(event_text(block) if block_type.startswith("tool-") or block_type == "knowledge-context" else str(block.get("text") or block.get("title") or block))
        if envelope.quote:
            text_parts.insert(0, str(envelope.quote.get("text") or ""))
        if envelope.attachments:
            text_parts.append("[附件引用] " + ", ".join(str(item.get("attach_id")) for item in envelope.attachments))
        if envelope.role == "tool":
            return tool_results[0] if tool_results else {"role": "tool", "content": ""}
        result = {"role": envelope.role, "content": "\n".join(item for item in text_parts if item)}
        if tool_calls:
            result["tool_calls"] = tool_calls
        return result
