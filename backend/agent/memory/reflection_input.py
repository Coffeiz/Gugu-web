"""对话反思的输入边界。

反思属于 memory 领域；这里仅负责从一次请求的消息尾部提取允许写入长期记忆的
内容，不参与 LLM 调用或调度。
"""
from __future__ import annotations

from typing import Any

from agent.models import AgentRequest


def build_reflection_input(
    req: AgentRequest,
    messages: Any,
    initial_len: int,
    reply: str,
) -> tuple[str, str]:
    """为 owner 反思隔离群聊内容，只保留 owner 发言和私人工具结果。"""
    if not req.chat_id:
        return req.message, reply

    private_results: list[str] = []
    from agent.context.assembly.area import MessageArea, MessageSource

    if isinstance(messages, MessageArea):
        source_messages = (
            entry.canonical_message
            for entry in messages.entries
            if entry.source == MessageSource.TOOL_ROUND
        )
        for item in source_messages:
            blocks = item.get("content")
            for block in blocks if isinstance(blocks, list) else ():
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                content = block.get("content")
                if isinstance(content, list):
                    content = "\n".join(
                        str(part.get("text") or part.get("content") or "")
                        for part in content
                        if isinstance(part, dict)
                    )
                if content:
                    private_results.append(str(content))
    else:
        # 兼容仍传 provider 消息列表的内部调用方。
        for item in messages[initial_len:]:
            if item.get("role") != "tool":
                continue
            content = item.get("content")
            if isinstance(content, list):
                content = "\n".join(
                    str(part.get("text") or part.get("content") or "")
                    for part in content
                    if isinstance(part, dict)
                )
            if content:
                private_results.append(str(content))

    return req.message, "\n\n".join(private_results) or "（只分析当前 owner 发言，不分析群聊助手回复）"
