"""只搜索当前 QQ 群会话的短期上下文，不触碰用户其他对话。"""

from sqlalchemy import desc, select

from agent.imctx import get_im
from agent.memory.scoped_store import read_scope
from agent.memory.scopes import MemoryScope
from agent.tools.base import BaseSkill, Tool
from app.models import ConversationMessage, ConversationSession
from app.search.query import keyword_condition, normalize_mode, normalize_queries


def _resolve_speaker(members: dict, speaker: str) -> dict:
    """把 speaker（platform_user_id 或名字/别名/称呼）解析成 platform_user_id。

    四层匹配优先级，只有最低置信度那层（nicknames 模糊匹配）出现多个候选才触发澄清：
      ① speaker 本身就是 platform_user_id → 直接精确匹配；
      ② 精确匹配 name，唯一命中直接用；
      ③ 精确匹配 aliases，唯一命中直接用；
      ④ 只在 nicknames 里模糊/包含匹配到——置信度最低，多候选才返回候选列表。
    返回：
      {"platform_user_id": pid}          唯一命中
      {"ambiguous": True, "candidates": [...]}  第④层多候选（按 last_seen_at 倒序，最多 5 个）
      {"error": "没有找到叫 XX 的群成员"}  未命中
    """
    speaker = (speaker or "").strip()
    if not speaker:
        return {"error": "speaker 不能为空"}
    # ① 直接当 platform_user_id 精确匹配
    if speaker in members:
        return {"platform_user_id": speaker}
    # ② 精确匹配 name
    name_hits = [pid for pid, m in members.items() if (m.get("name") or "") == speaker]
    if len(name_hits) == 1:
        return {"platform_user_id": name_hits[0]}
    # ③ 精确匹配 aliases
    alias_hits = [pid for pid, m in members.items() if speaker in (m.get("aliases") or [])]
    if len(alias_hits) == 1:
        return {"platform_user_id": alias_hits[0]}
    # ④ nicknames 模糊/包含匹配（置信度最低，多候选才澄清）
    nick_hits = [
        (pid, m)
        for pid, m in members.items()
        if any(speaker in (nick or "") for nick in (m.get("nicknames") or []))
    ]
    if len(nick_hits) == 1:
        return {"platform_user_id": nick_hits[0][0]}
    if len(nick_hits) > 1:
        candidates = sorted(
            (
                {
                    "platform_user_id": pid,
                    "matched_by": "nicknames",
                    "matched_text": speaker,
                    "name": m.get("name") or "",
                    "last_seen_at": m.get("last_seen_at"),
                }
                for pid, m in nick_hits
            ),
            key=lambda c: c.get("last_seen_at") or 0,
            reverse=True,
        )[:5]
        return {"ambiguous": True, "candidates": candidates}
    return {"error": f"没有找到叫 {speaker} 的群成员"}


async def _group_context_search(db, user_id, args: dict):
    im = get_im() or {}
    # 缺 channel_id（bot_id）时查询会退化成 bot_id IS NULL，基本搜不到——明确报不可用，
    # 不给「可用但搜不到」的假信心（P2）。
    if (
        im.get("chat_type") != "group"
        or not im.get("chat_id")
        or not im.get("channel_id")
    ):
        return {"error": "当前不在群聊上下文中，不能使用群聊搜索"}
    keyword = (args.get("keyword") or "").strip()
    queries = args.get("queries") if isinstance(args.get("queries"), list) else None
    search_queries = normalize_queries(keyword, queries)
    mode = normalize_mode(args.get("mode"))
    limit = max(1, min(int(args.get("limit", 10) or 10), 30))
    speaker = (args.get("speaker") or "").strip()
    speaker_id = None
    if speaker:
        # 读取当前群 members.json，把 speaker 解析成 platform_user_id。
        scope = MemoryScope(user_id, "qq", im.get("channel_id"), "group", im["chat_id"])
        members_data = (await read_scope(scope)).get("members") or {}
        members = members_data.get("members") if isinstance(members_data, dict) else {}
        resolved = _resolve_speaker(members if isinstance(members, dict) else {}, speaker)
        if resolved.get("ambiguous"):
            return resolved
        if resolved.get("error"):
            return resolved
        speaker_id = resolved.get("platform_user_id")
    query = (
        select(ConversationMessage)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(
            ConversationSession.user_id == user_id,
            ConversationSession.source == "qq",
            ConversationSession.bot_id == im.get("channel_id"),
            ConversationSession.chat_id == im["chat_id"],
            ConversationMessage.content_json.is_(None),
        )
        # 同一批消息可能拥有相同时间戳，用自增 id 保证倒序取回后再翻转时稳定按发送顺序返回。
        .order_by(desc(ConversationMessage.created_at), desc(ConversationMessage.id))
        .limit(limit)
    )
    if speaker_id:
        query = query.where(ConversationMessage.platform_user_id == speaker_id)
    if search_queries:
        query = query.where(keyword_condition([ConversationMessage.content], search_queries, mode))
    rows = (await db.execute(query)).scalars().all()
    return {
        "keyword": keyword,
        "queries": search_queries,
        "mode": mode,
        "speaker": speaker,
        "speaker_id": speaker_id,
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
            description="只搜索当前 QQ 群最近保存的消息，支持一次传入多个关键词（默认 OR）；也可以按发言人查询（speaker 传群成员的名字/别名/群友称呼或 platform_user_id）。若返回 ambiguous=true，说明有多个成员匹配该称呼，需要向用户澄清后再查；不会读取其他群、私聊或网页历史对话。",
            input_schema={
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "兼容旧调用的单个关键词；优先使用 queries"},
                    "queries": {"type": "array", "items": {"type": "string"},
                                "description": "可选多个候选关键词，默认 OR，最多 8 个"},
                    "mode": {"type": "string", "enum": ["OR", "AND"],
                             "description": "关键词匹配模式，默认 OR"},
                    "speaker": {"type": "string",
                                "description": "按发言人过滤：传群成员的名字/别名/群友称呼或 platform_user_id；返回 ambiguous=true 时需向用户澄清"},
                    "limit": {"type": "integer", "description": "返回条数，默认 10，最多 30"},
                },
            },
            handler=_group_context_search,
        ),
    ]


GroupContextSkill().register()
