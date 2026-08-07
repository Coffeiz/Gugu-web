"""只搜索当前 QQ 群会话的短期上下文，不触碰用户其他对话。"""

from sqlalchemy import desc, select

from agent.imctx import get_im
from agent.memory.scoped_store import read_scope
from agent.memory.scopes import MemoryScope
from agent.tools.base import BaseSkill, Tool
from app.models import ConversationMessage, ConversationSession
from app.search.query import keyword_condition, normalize_mode, normalize_queries


async def _live_speaker_index(db, user_id, platform: str, bot_id, chat_id) -> list[tuple]:
    """实时读当前群所有历史 (platform_user_id, platform_user_name, created_at)。

    不经 members.json——这里要的是"跟 Web 会话列表一样实时"的 id/曾用名信息，
    不能被反思任务的更新节奏拖慢（见 PRD-IM-8 Phase 2.5）。表本身受
    MESSAGE_RETENTION_LIMIT（500~600 条）限制，全量查一遍成本很低。
    """
    rows = (await db.execute(
        select(
            ConversationMessage.platform_user_id,
            ConversationMessage.platform_user_name,
            ConversationMessage.created_at,
        )
        .join(ConversationSession, ConversationSession.id == ConversationMessage.session_id)
        .where(
            ConversationSession.user_id == user_id,
            ConversationSession.source == platform,
            ConversationSession.bot_id == bot_id,
            ConversationSession.chat_type == "group",
            ConversationSession.chat_id == chat_id,
            ConversationMessage.role == "user",
            ConversationMessage.platform_user_id.is_not(None),
        )
    )).all()
    return rows


async def _resolve_speaker(db, user_id, platform: str, bot_id, chat_id, speaker: str, load_members) -> dict:
    """把 speaker（platform_user_id 或名字/曾用名/群友称呼）解析成 platform_user_id。

    四层匹配优先级，只有③④层（都读 members.json）出现多个候选才触发澄清；①②直接
    查消息表，实时、不受反思任务节奏影响：
      ① speaker 本身就是 platform_user_id → 直接精确匹配；
      ② 实时查询：speaker 跟该群里某个 platform_user_id **保留窗口内**用过的任意一个
         platform_user_name（当前显示名或曾用名都算）互为包含关系（谁包含谁都算，
         天然覆盖精确相等）——群里喊人常用全名的一部分（"小北"称呼"moon_小北"），
         只做精确匹配会漏掉这种最常见的场景，唯一命中直接用；
      ③ ②层查不到才读 members.json 的 aliases（曾用名）——改名很久之后，旧名字对应
         的消息已经被 500~600 条保留窗口裁掉，②层的实时查询看不到了，但反思任务沉淀
         下来的 aliases 还记得，专门补这个"退出窗口"的缺口，同样用互为包含匹配；
      ④ ③层也查不到才读 nicknames（群友称呼）——这层信息只能来自 LLM 提炼，无法
         实时化，是最后一道防线（load_members 是个 async 回调，避免大多数命中①②
         的调用也白读一次 members.json 文件，③④ 共用同一次加载）。
    返回：
      {"platform_user_id": pid}          唯一命中
      {"ambiguous": True, "candidates": [...]}  多候选（按 last_seen_at 倒序，最多 5 个）
      {"error": "没有找到叫 XX 的群成员"}  未命中
    """
    speaker = (speaker or "").strip()
    if not speaker:
        return {"error": "speaker 不能为空"}

    rows = await _live_speaker_index(db, user_id, platform, bot_id, chat_id)
    live_ids: set = set()
    name_to_pids: dict[str, set] = {}
    last_seen: dict[str, float] = {}
    for pid, name, created_at in rows:
        if not pid:
            continue
        live_ids.add(pid)
        if name:
            name_to_pids.setdefault(name, set()).add(pid)
        ts = created_at.timestamp() if created_at else None
        if ts is not None and ts > last_seen.get(pid, 0):
            last_seen[pid] = ts

    # ① speaker 本身就是 platform_user_id
    if speaker in live_ids:
        return {"platform_user_id": speaker}
    # ② 实时按名字/曾用名互为包含匹配（精确相等是包含关系的特例，天然覆盖）
    name_hits: dict[str, str] = {}   # pid → 命中时对应的那个 platform_user_name
    for name, pids in name_to_pids.items():
        if speaker in name or name in speaker:
            for pid in pids:
                name_hits.setdefault(pid, name)
    if len(name_hits) == 1:
        return {"platform_user_id": next(iter(name_hits))}
    if len(name_hits) > 1:
        candidates = sorted(
            (
                {
                    "platform_user_id": pid,
                    "matched_by": "name",
                    "matched_text": speaker,
                    "name": matched_name,
                    "last_seen_at": last_seen.get(pid),
                }
                for pid, matched_name in name_hits.items()
            ),
            key=lambda c: c.get("last_seen_at") or 0,
            reverse=True,
        )[:5]
        return {"ambiguous": True, "candidates": candidates}

    # 前两层都未命中，才读 members.json——一次性加载，下面 ③④ 两层共用同一份数据。
    members = await load_members()

    # ③ members.json 的 aliases（曾用名）：②层的实时查询只能看到"保留窗口内"的历史消息，
    # 老名字对应的消息一旦被 500~600 条的窗口裁剪掉，②层就再也找不到；aliases 是反思任务
    # 沉淀下来的持久记录，专门补这个缺口——改名很久之后，用旧名字依然要能找到人。
    # 用跟②层一样的互为包含匹配，标准保持一致。
    def _hits_by(field: str) -> dict[str, str]:
        found: dict[str, str] = {}
        for pid, m in members.items():
            for value in (m.get(field) or []):
                if value and (speaker in value or value in speaker):
                    found.setdefault(pid, value)
                    break
        return found

    def _ambiguous(hits: dict[str, str], matched_by: str) -> dict:
        candidates = sorted(
            (
                {
                    "platform_user_id": pid,
                    "matched_by": matched_by,
                    "matched_text": speaker,
                    "name": members.get(pid, {}).get("name") or "",
                    "last_seen_at": members.get(pid, {}).get("last_seen_at"),
                }
                for pid in hits
            ),
            key=lambda c: c.get("last_seen_at") or 0,
            reverse=True,
        )[:5]
        return {"ambiguous": True, "candidates": candidates}

    alias_hits = _hits_by("aliases")
    if len(alias_hits) == 1:
        return {"platform_user_id": next(iter(alias_hits))}
    if len(alias_hits) > 1:
        return _ambiguous(alias_hits, "aliases")

    # ④ members.json 的 nicknames（群友称呼，只能来自 LLM 提炼，全 PRD 最后一道防线）。
    nick_hits = _hits_by("nicknames")
    if len(nick_hits) == 1:
        return {"platform_user_id": next(iter(nick_hits))}
    if len(nick_hits) > 1:
        return _ambiguous(nick_hits, "nicknames")
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
        async def _load_members() -> dict:
            # 只有 _resolve_speaker 第③④层（aliases/nicknames）才会调用，①②命中时不产生这次文件读。
            scope = MemoryScope(user_id, "qq", im.get("channel_id"), "group", im["chat_id"])
            members_data = (await read_scope(scope)).get("members") or {}
            members = members_data.get("members") if isinstance(members_data, dict) else {}
            return members if isinstance(members, dict) else {}

        resolved = await _resolve_speaker(
            db, user_id, "qq", im.get("channel_id"), im["chat_id"], speaker, _load_members,
        )
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
