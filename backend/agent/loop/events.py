"""Agent Loop 结构化运行事件与 SSE 编码桥接（PRD-LLM-25 LLM25-005）。

职责边界（§3.1）：本模块生成结构化事件并统一编码为 SSE 行；不读数据库、
不执行工具。SSE 编解码的底层实现继续复用 `agent.interactions.stream_events`，
不另建第二套编码。
"""
from __future__ import annotations

import json


def artifact_sse(artifact: dict) -> str:
    """把工具产物转成一条 SSE 事件行；链接按钮走专用事件，其余按文件卡片。"""
    if isinstance(artifact, dict) and artifact.get("kind") == "link_buttons":
        return f"data: {json.dumps({'type': 'link_buttons', 'link_buttons': artifact}, ensure_ascii=False)}\n\n"
    return f"data: {json.dumps({'type': 'file', 'file': artifact}, ensure_ascii=False)}\n\n"


class EventSequencer:
    """run 级事件序号器：给兼容 SSE 事件补上可追踪身份（run_id + 单调 seq）。

    取代 `_run_loop` 内 `nonlocal event_seq` 的闭包计数；不写入用户正文或
    工具参数日志（与原实现同一约束）。
    """

    def __init__(self, run_id: str, start: int = 0):
        self.run_id = run_id
        self.seq = start

    def next_event(self, event_type: str, **payload) -> str:
        """编码一条带 run_id/seq 的事件；返回完整 SSE 行。"""
        self.seq += 1
        from agent.interactions.stream_events import encode_event
        return encode_event(
            event_type,
            run_id=self.run_id,
            seq=self.seq,
            **payload,
        )
