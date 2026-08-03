"""只搜索当前 QQ 群会话的短期上下文，不触碰用户其他对话。"""

from sqlalchemy import desc, select

from agent.imctx import get_im
from agent.tools.base import BaseSkill, Tool
from app.models import ConversationMessage, ConversationSession


async def _group_context_search(db, user_id, args: dict):
    im = get_im() or {}
    if im.get("chat_type") != "group" or not im.get("chat_id"):
        return {"error": "当前不在群聊上下文中，不能使用群聊搜索"}
    keyword = (args.get("keyword") or "").strip()
    limit = max(1, min(int(args.get("limit", 10) or 10), 30))
    query = (
        select(ConversationMessage)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(
            ConversationSession.user_id == user_id,
            ConversationSession.source == "qqbot",
            ConversationSession.chat_id == im["chat_id"],
            ConversationMessage.content_json.is_(None),
        )
        .order_by(desc(ConversationMessage.created_at))
        .limit(limit)
    )
    if keyword:
        query = query.where(ConversationMessage.content.ilike(f"%{keyword}%"))
    rows = (await db.execute(query)).scalars().all()
    return {
        "keyword": keyword,
        "messages": [
            {
                "role": "用户" if row.role == "user" else "咕咕",
                "content": (row.content or "")[:1000],
                **({
                    "platform_user_id": row.platform_user_id,
                    "platform_user_name": row.platform_user_name,
                } if row.role == "user" else {}),
            }
            for row in reversed(rows)
            if row.content
        ],
    }


class GroupContextSkill(BaseSkill):
    name = "group_context"
    tools = [
        Tool(
            name="group_context_search",
            label="搜当前群上下文",
            description="只搜索当前 QQ 群最近保存的消息，不会读取其他群、私聊或网页历史对话。",
            input_schema={
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "可选关键词；不填则返回当前群最近消息"},
                    "limit": {"type": "integer", "description": "返回条数，默认 10，最多 30"},
                },
            },
            handler=_group_context_search,
        ),
    ]


GroupContextSkill().register()
