"""对话历史技能：让咕咕能搜 / 读用户**过去的对话**（其他 session）。

严格多用户隔离——只查 `ConversationSession.user_id == 当前用户`，绝不跨用户。
当前对话的历史已在上下文里，这里解决"翻看以前那次聊的"。
"""
from __future__ import annotations

import json

from sqlalchemy import select

from app.models import ConversationMessage, ConversationSession
from app.services.conversations import get_session, list_messages, list_recent_sessions

from app.search.query import normalize_mode, normalize_queries
from agent.tools.base import BaseSkill, Tool


def _fmt(dt) -> str:
    return dt.strftime("%Y-%m-%d %H:%M") if dt else ""


def _positive_int(value: object) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


async def _resolve_conversation_session_id(db, user_id, item: dict) -> int | None:
    """把 RAG 结果解析为已归属当前用户的会话 ID。

    新协议显式返回 ``session_id``。旧持久化索引的 ``source_id`` 可能是命中
    消息 ID，且 ``message_id`` 已随结果返回，因此这里做一次兼容回查；不能把
    消息 ID 直接交给 ``read_conversation``，也不能在无法定位时猜正文。
    """
    session_id = _positive_int(item.get("session_id"))
    if session_id:
        session = await get_session(db, user_id, session_id)
        return session.id if session else None

    message_id = _positive_int(item.get("message_id"))
    source_id = _positive_int(item.get("source_id"))
    if message_id is None and source_id:
        # 兼容早期内存检索结果：source_id 当时就是 session ID。
        session = await get_session(db, user_id, source_id)
        if session:
            return session.id
        # 兼容旧持久化索引：source_id 是 message ID。
        message_id = source_id
    if message_id is None:
        return None

    return (await db.execute(
        select(ConversationMessage.session_id)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(
            ConversationMessage.id == message_id,
            ConversationSession.user_id == user_id,
        )
    )).scalar_one_or_none()


async def _search_conversations(db, user_id, args: dict):
    keyword = (args.get("query") or args.get("keyword") or "").strip()
    queries = args.get("queries") if isinstance(args.get("queries"), list) else None
    search_queries = normalize_queries(keyword, queries)
    mode = normalize_mode(args.get("mode"))
    limit = max(1, min(int(args.get("limit", 6) or 6), 20))

    # 无关键词 → 列最近的对话（标题 + 时间）
    if not search_queries:
        rows = await list_recent_sessions(db, user_id, limit)
        return {"recent": [
            {"session_id": s.id, "title": s.title, "summary": s.summary or "",
             "source": s.source, "updated_at": _fmt(s.updated_at)}
            for s in rows
        ]}

    seen: dict[int, dict] = {}
    # 有关键词 → 统一走 RAG service；工具仍只返回 session 摘要和匹配片段，
    # 完整消息继续由 read_conversation 读取。
    from agent.rag.service import search_conversations
    recall = await search_conversations(
        db, user_id, " ".join(search_queries), queries=search_queries,
        match_mode=mode, limit=limit * 4,
    )
    unresolved = False
    for item in recall.get("results", []):
        session_id = await _resolve_conversation_session_id(db, user_id, item)
        if not session_id:
            unresolved = True
            continue
        if session_id in seen:
            continue
        seen[session_id] = {
            "session_id": session_id,
            "title": item.get("title") or "未命名对话",
            "summary": item.get("summary") or "",
            "source": item.get("session_source") or "web",
            "updated_at": _fmt_from_iso(item.get("session_updated_at")),
            "match": {
                "role": ("你" if item.get("role") == "user" else "咕咕"),
                "snippet": str(item.get("text") or "")[:140],
            },
        }
        if len(seen) >= limit:
            break

    if not seen and unresolved:
        return {
            "matches": [],
            "error": "找到历史消息片段，但无法定位所属会话，不能安全读取正文；请重试历史对话搜索。",
        }
    if not seen:
        return {"matches": [], "hint": f"没找到提到「{' / '.join(search_queries)}」的过去对话"}
    return {"matches": list(seen.values()),
            "note": "用 read_conversation(session_id) 看某条对话的完整内容"}


def _fmt_from_iso(value) -> str:
    if not value:
        return ""
    try:
        from datetime import datetime
        return _fmt(datetime.fromisoformat(str(value)))
    except (TypeError, ValueError):
        return ""


async def _read_conversation(db, user_id, args: dict):
    sid = args.get("session_id")
    if not sid:
        return json.dumps({"error": "需提供 session_id（先用 search_conversations 找）"}, ensure_ascii=False)
    sess = await get_session(db, user_id, int(sid))
    if not sess:
        return json.dumps({"error": "对话不存在或不属于你"}, ensure_ascii=False)

    limit = max(1, min(int(args.get("limit", 40) or 40), 100))
    # 取该 session 的「最近」N 条（DESC + limit），再翻回正序展示——
    # 别用 ASC+limit（那会返回最旧 N 条，「继续刚刚的话题」恰恰要的是最近聊的）。
    msgs = await list_messages(db, sess.id, limit)
    msgs = list(reversed(msgs))   # 翻回时间正序，便于按顺序阅读
    return {
        "session_id": sess.id, "title": sess.title, "source": sess.source,
        "messages": [
            {"role": ("你" if m.role == "user" else "咕咕"), "content": (m.content or "")[:1200]}
            for m in msgs if m.content
        ],
    }


async def _bind_web_session(db, user_id, args: dict):
    """把当前 owner 私聊绑定到一个已确认属于自己的 Web session。"""
    from agent.im import imctx
    from agent.im.owner_session import bind_session

    context = imctx.get_im()
    if not context or context.get("im_role") != "owner":
        return {"error": "只有绑定账号的私聊可以绑定网页会话"}
    if context.get("chat_type") == "group":
        return {"error": "群聊不绑定网页会话，请在私聊中操作"}
    session_id = args.get("session_id")
    if not session_id:
        return {"error": "需要提供 session_id"}
    ok = await bind_session(
        db,
        user_id,
        context.get("platform") or "",
        context.get("puid") or "",
        int(session_id),
    )
    if not ok:
        return {"error": "网页会话不存在、不属于你，或不是 Web 会话"}
    return {"bound": True, "session_id": int(session_id), "message": "已绑定，之后可以在这里继续这段网页对话"}


class ConversationsSkill(BaseSkill):
    name = "conversations"
    tools = [
        Tool(
            name="search_conversations", label="搜历史对话",
            description_short='搜索历史对话；省略关键词时列出最近对话。',
            description="搜索用户过去的其他对话；可按关键词查找，不传关键词则列最近对话。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "keyword": {"type": "string"},
                    "queries": {"type": "array", "items": {"type": "string"}},
                    "mode": {"type": "string", "enum": ["OR", "AND"]},
                    "limit": {"type": "integer"},
                },
                "oneOf": [
                    {"required": ["query"], "not": {"anyOf": [{"required": ["keyword"]}, {"required": ["queries"]}]}},
                    {"required": ["keyword"], "not": {"anyOf": [{"required": ["query"]}, {"required": ["queries"]}]}},
                    {"required": ["queries"], "not": {"anyOf": [{"required": ["query"]}, {"required": ["keyword"]}]}},
                    {"not": {"anyOf": [{"required": ["query"]}, {"required": ["keyword"]}, {"required": ["queries"]}]}},
                ],
            },
            handler=_search_conversations,
        ),
        Tool(
            name="read_conversation", label="读历史对话",
            description_short='读取历史对话。',
            description="读某条历史对话的完整消息（先用 search_conversations 拿到 session_id）。用于把过去那次聊的细节翻出来。",
            input_schema={
                "type": "object",
                "properties": {
                    "session_id": {"type": "integer"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                "required": ["session_id"],
            },
            handler=_read_conversation,
        ),
        Tool(
            name="bind_web_session", label="绑定网页会话",
            description_short='绑定网页会话。',
            description="仅 owner 私聊可用：把当前 IM 私聊绑定到一个属于自己的 Web 对话，之后 IM 会继续该对话。先用 search_conversations 找到 session_id；群聊不能绑定。",
            input_schema={
                "type": "object",
                "properties": {
                    "session_id": {"type": "integer"},
                },
                "required": ["session_id"],
            },
            handler=_bind_web_session,
            mutates=True,
        ),
    ]


ConversationsSkill().register()
