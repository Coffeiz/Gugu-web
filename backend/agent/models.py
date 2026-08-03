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
    chat_id: Optional[str] = None       # IM 群会话标识；网页/私聊为空
    platform_user_id: Optional[str] = None  # 当前 IM 发言人的平台身份标识
    platform_user_name: Optional[str] = None  # 当前 IM 发言人的平台显示名，仅用于称呼
    source: str = "web"           # "web" | "qqbot" | "openclaw"
    attachments: list = field(default_factory=list)   # 聊天附件 attach_id（仅 web）
    greeting: Optional[str] = None   # 新会话首条用户消息携带的「已显示默认问候」，落为本会话首条 assistant 消息（仅 web）
    origin: Optional[str] = None   # 发起请求的浏览器标签页 client-id（仅 web，来自 X-Client-Id）：
                                    # 透传给 events.publish，让本标签页跳过自己已经流式渲染过的回声
    quoted_text: Optional[str] = None   # IM 引用/回复的原消息文字（仅 IM）：喂给模型当上下文，
                                        # 但不拼进 message——message/ConversationMessage.content 只存
                                        # 用户自己打的话，quoted_text 单独存单独展示，别再把引用原文
                                        # 拼进用户消息正文（网页气泡是纯文本渲染，拼进去会把 markdown
                                        # 原文摊平显示得很难看，见 devlog 2026-07-10）。
    im_role: Optional[str] = None       # IM 身份：owner/member/unknown；网页为空
    allowed_tool_names: Optional[list[str]] = None  # None=沿用完整工具集；群成员使用白名单


@dataclass
class AgentResponse:
    """预留：非流式场景的统一响应结构（Phase 4 平台接入用）。"""
    text: str = ""
    session_id: Optional[int] = None
    tokens_in: int = 0
    tokens_out: int = 0
    files: list = field(default_factory=list)   # 咕咕要发的文件卡片（file_id/name/ext…），平台 adapter 据此发文件
    cancelled: bool = False                      # 用户中途「算了」→ 工具循环被取消，worker 据此不再补发回复
