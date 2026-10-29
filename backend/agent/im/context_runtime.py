"""IM 请求的上下文投影。

这里放平台身份、群记忆、引用和跨会话续接等 IM 特化逻辑。模型循环只消费已经
构造好的上下文，不需要知道这些平台细节。
"""
from __future__ import annotations

from sqlalchemy import desc, func, select

from app.core.tz import now_utc
from agent.im.session import session_scope_filters
from agent.models import AgentRequest


def snapshot_im_memory(snapshot_context: str, im_memory: dict, req: AgentRequest, *, restricted: bool) -> tuple[str, dict]:
    """统一把有权限的 IM 记忆写入 snapshot，并返回 snapshot 保存形状。"""
    from agent.im.context_loader import format_group_memory, format_platform_user_memory

    group_memory = (im_memory or {}).get("group") or {}
    group_block = format_group_memory({"group": group_memory})
    if group_block:
        snapshot_context = f"{snapshot_context}\n\n---\n\n{group_block}"

    private_member_memory = {}
    if not req.chat_id and restricted:
        private_member_memory = (im_memory or {}).get("platform_user") or {}
        member_block = format_platform_user_memory({"platform_user": private_member_memory})
        if member_block:
            snapshot_context = f"{snapshot_context}\n\n---\n\n{member_block}"

    snapshot_memory = {"group": group_memory} if req.chat_id else {
        "platform_user": private_member_memory,
    }
    return snapshot_context, snapshot_memory


def proactive_lead_for(req: AgentRequest, history: list) -> str:
    """主动消息前导只属于群聊，避免私聊重复注入历史首条 assistant。"""
    if not req.chat_id:
        return ""
    nonsumm = [item for item in history if getattr(item, "role", None) != "summary"]
    return nonsumm[0].content if nonsumm and nonsumm[0].role == "assistant" else ""


_CONTINUE_CUES = (
    "继续", "刚刚", "刚才", "刚说", "刚聊", "上次", "上回", "之前", "接着", "那个事", "那件事", "没续上",
)


def with_quoted_context(message: str, quoted_text: str | None) -> str:
    """只在喂给模型时包装引用原文，展示和持久化仍使用独立 quoted_text 字段。"""
    from agent.im.context_loader import format_quoted_context

    return format_quoted_context(message, quoted_text)


async def continuity_bridge(
    db,
    user_id,
    current_session_id,
    user_msg: str,
    source: str,
    chat_id: str | None,
    bot_id: str | None = None,
    platform_user_id: str | None = None,
) -> str:
    """为 IM 新会话提供最近会话指针和必要的尾部上下文。"""
    from app.models import ConversationMessage, ConversationSession

    query = select(ConversationSession).where(
        ConversationSession.user_id == user_id,
        ConversationSession.id != current_session_id,
        *session_scope_filters(ConversationSession, source, chat_id, bot_id, platform_user_id),
    )
    previous = (
        await db.execute(
            query.order_by(desc(ConversationSession.updated_at)).limit(1)
        )
    ).scalars().first()
    if not previous or not previous.updated_at:
        return ""
    age_hours = (now_utc() - previous.updated_at).total_seconds() / 3600
    if age_hours > 48:
        return ""
    when = (
        f"约 {int(age_hours)} 小时前"
        if age_hours >= 1
        else f"约 {max(1, int(age_hours * 60))} 分钟前"
    )
    title = (previous.title or "").strip() or "（无标题）"
    gist = (previous.summary or "").strip()
    gist_text = f"——{gist}" if gist else ""
    block = (
        "\n\n---\n\n## 最近一条对话（用户可能想接着聊）\n"
        f"上一条对话 #{previous.id}《{title}》{gist_text}，{when}结束。**用户若说「继续 / 刚刚 / 上次 / 之前那次」，"
        f"多半指的是它**——用 `read_conversation({previous.id})` 把它翻出来再接，别空着答、也别拿别的话题顶上。"
    )
    if any(cue in (user_msg or "") for cue in _CONTINUE_CUES):
        rows = (
            await db.execute(
                select(ConversationMessage)
                .where(
                    ConversationMessage.session_id == previous.id,
                    ConversationMessage.content_json.is_(None),
                )
                # 与 provider 历史同一套顺序口径（sent_at=该消息被处理的时间，
                # 缺失时回落 created_at），否则这里读出的先后会和模型看到的历史对不上。
                .order_by(
                    desc(ConversationMessage.conversation_seq),
                )
                .limit(8)
            )
        ).scalars().all()
        rows = [message for message in reversed(rows) if message.content]
        if rows:
            tail = "\n".join(
                f"- {'用户' if message.role == 'user' else '咕咕'}：{(message.content or '')[:200]}"
                for message in rows
            )
            block += "\n\n这句像是要接着上一条聊，下面是那条对话的最近几轮，**直接据此接上**：\n" + tail
    return block
