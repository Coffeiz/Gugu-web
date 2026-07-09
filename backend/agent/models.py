"""Agent 统一数据结构。

各 adapter 负责把平台格式转换为 AgentRequest，core / 编排层只认这个结构。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class AgentRequest:
    message: str
    user_id: object               # UUID
    user_name: str
    session_id: Optional[int] = None
    source: str = "web"           # "web" | "qqbot" | "openclaw"
    attachments: list = field(default_factory=list)   # 聊天附件 attach_id（仅 web）
    greeting: Optional[str] = None   # 新会话首条用户消息携带的「已显示默认问候」，落为本会话首条 assistant 消息（仅 web）
    quoted_text: Optional[str] = None   # IM 引用/回复的原消息文字（仅 IM）：喂给模型当上下文，
                                        # 但不拼进 message——message/ConversationMessage.content 只存
                                        # 用户自己打的话，quoted_text 单独存单独展示，别再把引用原文
                                        # 拼进用户消息正文（网页气泡是纯文本渲染，拼进去会把 markdown
                                        # 原文摊平显示得很难看，见 devlog 2026-07-10）。


@dataclass
class AgentResponse:
    """预留：非流式场景的统一响应结构（Phase 4 平台接入用）。"""
    text: str = ""
    session_id: Optional[int] = None
    tokens_in: int = 0
    tokens_out: int = 0
    files: list = field(default_factory=list)   # 咕咕要发的文件卡片（file_id/name/ext…），平台 adapter 据此发文件
    cancelled: bool = False                      # 用户中途「算了」→ 工具循环被取消，worker 据此不再补发回复
