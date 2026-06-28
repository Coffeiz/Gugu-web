"""对话历史技能：让咕咕能搜 / 读用户**过去的对话**（其他 session）。

严格多用户隔离——只查 `ConversationSession.user_id == 当前用户`，绝不跨用户。
当前对话的历史已在上下文里，这里解决"翻看以前那次聊的"。
"""
from __future__ import annotations

import json

from sqlalchemy import select, desc, or_

from app.models import ConversationMessage, ConversationSession
from agent.tools.base import BaseSkill, Tool


def _fmt(dt) -> str:
    return dt.strftime("%Y-%m-%d %H:%M") if dt else ""


async def _search_conversations(db, user_id, args: dict):
    keyword = (args.get("keyword") or "").strip()
    limit = max(1, min(int(args.get("limit", 6) or 6), 20))

    # 无关键词 → 列最近的对话（标题 + 时间）
    if not keyword:
        rows = (await db.execute(
            select(ConversationSession)
            .where(ConversationSession.user_id == user_id)
            .order_by(desc(ConversationSession.updated_at))
            .limit(limit)
        )).scalars().all()
        return {"recent": [
            {"session_id": s.id, "title": s.title, "summary": s.summary or "",
             "source": s.source, "updated_at": _fmt(s.updated_at)}
            for s in rows
        ]}

    # 有关键词 → 搜消息正文 + 标题，按 session 聚合，每条给匹配片段
    like = f"%{keyword}%"
    rows = (await db.execute(
        select(ConversationMessage, ConversationSession)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(
            ConversationSession.user_id == user_id,
            ConversationMessage.content_json.is_(None),   # 跳过工具中间消息
            or_(ConversationMessage.content.ilike(like),
                ConversationSession.title.ilike(like),
                ConversationSession.summary.ilike(like)),
        )
        .order_by(desc(ConversationMessage.created_at))
        .limit(limit * 4)
    )).all()

    seen: dict[int, dict] = {}
    for msg, sess in rows:
        if sess.id in seen:
            continue
        snippet = (msg.content or "")[:140]
        seen[sess.id] = {
            "session_id": sess.id, "title": sess.title, "summary": sess.summary or "",
            "source": sess.source, "updated_at": _fmt(sess.updated_at),
            "match": {"role": ("你" if msg.role == "user" else "咕咕"), "snippet": snippet},
        }
        if len(seen) >= limit:
            break

    if not seen:
        return {"matches": [], "hint": f"没找到提到「{keyword}」的过去对话"}
    return {"matches": list(seen.values()),
            "note": "用 read_conversation(session_id) 看某条对话的完整内容"}


async def _read_conversation(db, user_id, args: dict):
    sid = args.get("session_id")
    if not sid:
        return json.dumps({"error": "需提供 session_id（先用 search_conversations 找）"}, ensure_ascii=False)
    sess = await db.get(ConversationSession, int(sid))
    if not sess or str(sess.user_id) != str(user_id):
        return json.dumps({"error": "对话不存在或不属于你"}, ensure_ascii=False)

    limit = max(1, min(int(args.get("limit", 40) or 40), 100))
    # 取该 session 的「最近」N 条（DESC + limit），再翻回正序展示——
    # 别用 ASC+limit（那会返回最旧 N 条，「继续刚刚的话题」恰恰要的是最近聊的）。
    msgs = (await db.execute(
        select(ConversationMessage)
        .where(
            ConversationMessage.session_id == sess.id,
            ConversationMessage.content_json.is_(None),
        )
        .order_by(desc(ConversationMessage.created_at))
        .limit(limit)
    )).scalars().all()
    msgs = list(reversed(msgs))   # 翻回时间正序，便于按顺序阅读
    return {
        "session_id": sess.id, "title": sess.title, "source": sess.source,
        "messages": [
            {"role": ("你" if m.role == "user" else "咕咕"), "content": (m.content or "")[:1200]}
            for m in msgs if m.content
        ],
    }


class ConversationsSkill(BaseSkill):
    name = "conversations"
    tools = [
        Tool(
            name="search_conversations", label="搜历史对话",
            description="搜用户**过去的对话**（其他 session）。当用户提到「上次/之前那次聊的」「我们以前说过的 X」等，用它按关键词找。不传 keyword 则列最近对话。只搜当前用户自己的，安全。",
            input_schema={
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "关键词（搜消息正文+标题）；不填=列最近对话"},
                    "limit": {"type": "integer", "description": "返回条数，默认 6，最多 20"},
                },
            },
            handler=_search_conversations,
        ),
        Tool(
            name="read_conversation", label="读历史对话",
            description="读某条历史对话的完整消息（先用 search_conversations 拿到 session_id）。用于把过去那次聊的细节翻出来。",
            input_schema={
                "type": "object",
                "properties": {
                    "session_id": {"type": "integer", "description": "对话 id"},
                    "limit": {"type": "integer", "description": "最多读几条消息，默认 40，最多 100"},
                },
                "required": ["session_id"],
            },
            handler=_read_conversation,
        ),
    ]


ConversationsSkill().register()
