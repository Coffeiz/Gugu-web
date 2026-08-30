"""Agent 统一数据结构。

各 adapter 负责把平台格式转换为 AgentRequest，core / 编排层只认这个结构。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from agent.im.actor import ActorContext


@dataclass
class AgentRequest:
    message: str
    user_id: object               # UUID
    user_name: str
    session_id: Optional[int] = None
    chat_id: Optional[str] = None       # IM 群会话标识；网页/私聊为空
    platform_bot_id: Optional[str] = None  # 当前 IM Bot/频道标识（ConversationSession 的作用域）
    platform_user_id: Optional[str] = None  # 当前 IM 发言人的平台身份标识
    platform_user_name: Optional[str] = None  # 当前 IM 发言人的平台显示名，仅用于称呼
    platform_bot_user_id: Optional[str] = None  # 当前 IM Bot 的平台身份标识，用于 mention 展示
    source: str = "web"           # "web" | "qq" | "openclaw"
    attachments: list = field(default_factory=list)   # 聊天附件 attach_id（仅 web）
    greeting: Optional[str] = None   # 新会话首条用户消息携带的「已显示默认问候」，落为本会话首条 assistant 消息（仅 web）
    locale: Optional[str] = None     # 网页当前界面语言；优先于数据库偏好，避免浏览器语言与 Agent 语言分离
    origin: Optional[str] = None   # 发起请求的浏览器标签页 client-id（仅 web，来自 X-Client-Id）：
                                    # 透传给 events.publish，让本标签页跳过自己已经流式渲染过的回声
    quoted_text: Optional[str] = None   # IM 引用/回复的原消息文字（仅 IM）：喂给模型当上下文，
                                        # 但不拼进 message——message/ConversationMessage.content 只存
                                        # 用户自己打的话，quoted_text 单独存单独展示，别再把引用原文
                                        # 拼进用户消息正文（网页气泡是纯文本渲染，拼进去会把 markdown
                                        # 原文摊平显示得很难看，见 devlog 2026-07-10）。
    im_role: Optional[str] = None       # IM 身份：owner/member/unknown；网页为空
    allowed_tool_names: Optional[list[str]] = None  # None=沿用完整工具集；群成员使用白名单
    actor_context: Optional[ActorContext] = None    # IM 统一身份快照；Web 为空
    im_message_format: Optional[str] = None         # QQ 文本出站格式策略
    im_group_memory_enabled: bool = True            # IM 群公开记忆是否读取/沉淀
    im_member_memory_enabled: bool = True           # IM 群成员记忆是否读取/沉淀
    interaction_prompt_id: Optional[int] = None     # Web 恢复 ask_user 的 pending Run
    interaction_token: Optional[str] = None         # 仅由交互恢复入口消费，不进入模型上下文
    interaction_event_id: Optional[str] = None


@dataclass
class AgentResponse:
    """预留：非流式场景的统一响应结构（Phase 4 平台接入用）。"""
    text: str = ""
    # 本次 run 中各个有正文 round 的独立文本。`text` 保持兼容语义（最后一轮正文），
    # IM 展示层使用此字段逐条发送，避免把多个 round 合并成一条消息。
    round_texts: list[str] = field(default_factory=list)
    session_id: Optional[int] = None
    tokens_in: int = 0
    tokens_out: int = 0
    cache_read: int = 0
    cache_write: int = 0
    files: list = field(default_factory=list)   # 咕咕要发的文件卡片（file_id/name/ext…），平台 adapter 据此发文件
    cancelled: bool = False                      # 用户中途「算了」→ 工具循环被取消，worker 据此不再补发回复
    used_tools: bool = False                     # 本轮是否实际经过工具调用，供 IM 记忆触发策略使用
    interactions: list = field(default_factory=list)  # 可选交互提示；由平台 adapter 决定是否展示
    tool_events: list = field(default_factory=list)  # 本轮工具状态事件；不直接作为用户正文展示
    compaction_applied: bool = False                 # 本轮是否发生上下文压缩或确定性兜底
