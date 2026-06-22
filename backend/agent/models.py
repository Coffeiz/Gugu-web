"""Agent 统一数据结构。

各 adapter 负责把平台格式转换为 AgentRequest，core / 编排层只认这个结构。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class AgentRequest:
    message: str
    user_id: object               # UUID
    user_name: str
    session_id: Optional[int] = None
    source: str = "web"           # "web" | "qqbot" | "openclaw"


@dataclass
class AgentResponse:
    """预留：非流式场景的统一响应结构（Phase 4 平台接入用）。"""
    text: str = ""
    session_id: Optional[int] = None
    tokens_in: int = 0
    tokens_out: int = 0
