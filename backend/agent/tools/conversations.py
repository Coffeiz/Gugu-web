"""对话历史技能：让咕咕能搜 / 读用户**过去的对话**（其他 session）。

严格多用户隔离——只查 `ConversationSession.user_id == 当前用户`，绝不跨用户。
当前对话的历史已在上下文里，这里解决"翻看以前那次聊的"。
"""
from __future__ import annotations

import json

from app.services.conversations import get_session, list_messages, list_recent_sessions

from app.search.query import normalize_mode, normalize_queries
from agent.tools.base import BaseSkill, Tool


def _fmt(dt) -> str:
    return dt.strftime("%Y-%m-%d %H:%M") if dt else ""


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
    for item in recall.get("results", []):
        session_id = int(item.get("source_id") or 0)
        if not session_id or session_id in seen:
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
            description_short='搜索历史对话；关键字段 query/limit',
            description="搜索用户过去的其他对话；可按关键词查找，不传关键词则列最近对话。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词；所有搜索工具统一使用此字段"},
                    "keyword": {"type": "string", "description": "兼容旧调用的别名；新调用请使用 query"},
                    "queries": {"type": "array", "items": {"type": "string"},
                                "description": "可选多个候选关键词，默认 OR，最多 8 个"},
                    "mode": {"type": "string", "enum": ["OR", "AND"],
                             "description": "关键词匹配模式，默认 OR"},
                    "limit": {"type": "integer", "description": "返回条数，默认 6，最多 20"},
                },
            },
            handler=_search_conversations,
        ),
        Tool(
            name="read_conversation", label="读历史对话",
            description_short='读取历史对话；关键字段 session_id',
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
        Tool(
            name="bind_web_session", label="绑定网页会话",
            description_short='绑定网页会话；关键字段 session_id',
            description="仅 owner 私聊可用：把当前 IM 私聊绑定到一个属于自己的 Web 对话，之后 IM 会继续该对话。先用 search_conversations 找到 session_id；群聊不能绑定。",
            input_schema={
                "type": "object",
                "properties": {
                    "session_id": {"type": "integer", "description": "要继续的 Web 对话 id"},
                },
                "required": ["session_id"],
            },
            handler=_bind_web_session,
            mutates=True,
        ),
    ]


ConversationsSkill().register()
