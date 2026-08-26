"""Anthropic历史适配器入口。"""
from __future__ import annotations

from .context_adapter import ContextAdapter
from agent.context.canonical_tool_history import event_text


class AnthropicHistoryAdapter(ContextAdapter):
    """保留 canonical history，由 provider adapter 统一渲染 Anthropic wire block。"""

    def render_envelope(self, envelope):
        blocks = []
        for block in envelope.content_blocks:
            block_type = block.get("type")
            if block_type in {"tool_call", "tool_use"}:
                arguments = block.get("arguments", block.get("input", {}))
                if not isinstance(arguments, dict):
                    arguments = {}
                blocks.append({
                    "type": "tool_use", "id": block.get("id"),
                    "name": block.get("name"), "input": arguments,
                })
            elif block_type == "tool_result":
                tool_id = block.get("tool_call_id") or block.get("tool_use_id")
                if tool_id:
                    result = {"type": "tool_result", "tool_use_id": tool_id,
                              "content": block.get("content", "")}
                    if block.get("is_error"):
                        result["is_error"] = True
                    blocks.append(result)
            elif block_type == "text":
                if block.get("text"):
                    blocks.append({"type": "text", "text": str(block["text"])})
            elif block_type in {"tool-schema", "skill-schema", "tool-discovery", "knowledge-context", "stance-context", "time-context",
                                "quote", "attachment_ref", "transcript", "attachment_text",
                                "interaction_request", "interaction_result"}:
                text = event_text(block) if block_type.startswith("tool-") or block_type in {"knowledge-context", "stance-context", "time-context"} else str(block.get("text") or block.get("title") or block)
                if text:
                    blocks.append({"type": "text", "text": text})
        if envelope.quote:
            blocks.insert(0, {"type": "text", "text": str(envelope.quote.get("text") or "")})
        if envelope.attachments:
            blocks.append({"type": "text", "text": "[附件引用] " + ", ".join(str(item.get("attach_id")) for item in envelope.attachments)})
        role = "user" if envelope.role == "tool" else envelope.role
        return {"role": role, "content": blocks or [{"type": "text", "text": ""}]}
