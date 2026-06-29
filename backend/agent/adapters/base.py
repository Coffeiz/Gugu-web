"""Adapter 接口。

receive：平台消息 → AgentRequest；send：响应 → 平台格式。
Web (SSE) adapter 直接产出 SSE 字符串流，故 send 由具体 adapter 自定义。
"""
from __future__ import annotations

from agent.models import AgentRequest


class BaseAdapter:
    source: str = "base"

    def receive(self, *args, **kwargs) -> AgentRequest:
        raise NotImplementedError
