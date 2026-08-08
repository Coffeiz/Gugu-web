"""只搜索当前 QQ 群会话的短期上下文，不触碰用户其他对话。"""

from sqlalchemy import desc, select

from agent.imctx import get_im
from agent.memory.scoped_store import read_scope_json
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

    匹配按「强度」分两级，强度内部再按来源排优先级；这跟早期"按来源分层、层内不分
    强度"的设计不同——code review 发现旧设计有个静默查错人的洞：②层（实时名字）只要
    唯一命中就直接 return，根本不会往下看 members.json 里是否有更强的精确 alias/nickname
    匹配。真实场景：A 的曾用名精确等于"小北"，B 的当前群昵称是"小北哥"；用户问"小北说了
    什么"，"小北" in "小北哥" 是模糊命中且唯一，旧代码直接把这次查询判给 B，A 的精确
    alias 根本没机会参与判断——不是 ambiguous（好歹会问用户），而是更危险的静默查错人。

    ① speaker 本身就是 platform_user_id → 直接精确匹配，最高优先级——这一层同时检查
       "实时消息表里的 pid"和"members.json 里持久记录的 pid"两个来源（见下），不只
       查实时表；
    ② 精确匹配（相等）——同时看实时名字（当前群昵称，查消息表，不受反思节奏影响）+
       members.json 的 aliases（曾用名）+ nicknames（群友称呼），三个来源合并判断：
       唯一命中直接用，多个精确命中（同一个词被多个人精确用过）才算 ambiguous；
    ③ ②层没有任何精确命中，才退回模糊匹配（互为包含，"小北"能命中"moon_小北"）——
       同样合并实时名字 + aliases + nicknames 三个来源一起判断唯一性/ambiguous。
    除①外都需要 members.json（load_members 是 async 回调，①的实时表命中时不需要
    调用，但①里对 members.json 的 pid 精确匹配仍需要读一次；②③ 共用同一份数据，
    不会因为多层判断而多读文件）。
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

    # ① speaker 本身就是 platform_user_id——先查实时表（最快，不用读文件）。
    if speaker in live_ids:
        return {"platform_user_id": speaker}

    # ②③ 都可能需要 aliases/nicknames，且精确匹配必须先于模糊匹配判断，所以无条件
    # 加载一次（唯一的例外是①在实时表里已经命中、提前 return 掉的情况）。
    members = await load_members()

    # ①（续）：speaker 是沉默成员的 platform_user_id——这个人的消息已经被保留窗口
    # 裁掉，live_ids 里查不到了，但 _merge_members()（PRD-IM-8 Phase 2.9）明确保证
    # 沉默成员会继续留在 members.json 里，不会被删除。如果这里不补一次 exact key
    # 查找，就会出现"members.json 明明保留了这个人，但直接传他的 platform_user_id
    # 反而返回'没有找到'"的矛盾——违反本函数开头"①最高优先级"的契约（code review
    # 复审发现）。
    if speaker in members:
        return {"platform_user_id": speaker}

    def _field_matches(field: str, *, exact: bool) -> dict[str, str]:
        found: dict[str, str] = {}
        for pid, m in members.items():
            for value in (m.get(field) or []):
                if not value:
                    continue
                hit = (value == speaker) if exact else (speaker in value or value in speaker)
                if hit:
                    found.setdefault(pid, value)
                    break
        return found

    def _candidate_last_seen(pid: str) -> float:
        # members.json 的 last_seen_at 由反思任务全量聚合得出，比这里临时查出的实时
        # last_seen 更权威（多个候选可能在同一批种子消息里时间戳完全相同，全靠实时
        # last_seen 排不出稳定顺序）；优先用它，只有 members 里没有这个人时才退回实时值。
        return (members.get(pid, {}).get("last_seen_at")) or last_seen.get(pid) or 0

    def _ambiguous(hits: dict[str, str], matched_by: dict[str, str]) -> dict:
        candidates = sorted(
            (
                {
                    "platform_user_id": pid,
                    "matched_by": matched_by.get(pid, "name"),
                    "matched_text": hits.get(pid, speaker),
                    "name": members.get(pid, {}).get("name")
                        or (hits.get(pid) if matched_by.get(pid) == "name" else "") or "",
                    "last_seen_at": _candidate_last_seen(pid) or None,
                }
                for pid in hits
            ),
            key=lambda c: c.get("last_seen_at") or 0,
            reverse=True,
        )[:5]
        return {"ambiguous": True, "candidates": candidates}

    # ── ② 精确匹配：实时名字 + aliases + nicknames 三个来源合并，谁先出现在 dict
    # 里谁的 matched_by 生效，仅用于候选展示，不影响是否命中/ambiguous 的判断。
    exact_hits: dict[str, str] = {}
    exact_by: dict[str, str] = {}
    for pid in name_to_pids.get(speaker, set()):
        exact_hits.setdefault(pid, speaker)
        exact_by.setdefault(pid, "name")
    for pid, value in _field_matches("aliases", exact=True).items():
        exact_hits.setdefault(pid, value)
        exact_by.setdefault(pid, "aliases")
    for pid, value in _field_matches("nicknames", exact=True).items():
        exact_hits.setdefault(pid, value)
        exact_by.setdefault(pid, "nicknames")
    if len(exact_hits) == 1:
        return {"platform_user_id": next(iter(exact_hits))}
    if len(exact_hits) > 1:
        return _ambiguous(exact_hits, exact_by)

    # ── ③ 精确匹配全都没有命中，才退回模糊包含匹配，同样三个来源合并判断。
    fuzzy_hits: dict[str, str] = {}
    fuzzy_by: dict[str, str] = {}
    for name, pids in name_to_pids.items():
        if speaker in name or name in speaker:
            for pid in pids:
                fuzzy_hits.setdefault(pid, name)
                fuzzy_by.setdefault(pid, "name")
    for pid, value in _field_matches("aliases", exact=False).items():
        fuzzy_hits.setdefault(pid, value)
        fuzzy_by.setdefault(pid, "aliases")
    for pid, value in _field_matches("nicknames", exact=False).items():
        fuzzy_hits.setdefault(pid, value)
        fuzzy_by.setdefault(pid, "nicknames")
    if len(fuzzy_hits) == 1:
        return {"platform_user_id": next(iter(fuzzy_hits))}
    if len(fuzzy_hits) > 1:
        return _ambiguous(fuzzy_hits, fuzzy_by)
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
            # speaker 不是 platform_user_id 精确命中时都会调用一次（供精确/模糊两级匹配共用），
            # 已经进了热路径——用 read_scope_json 只读 members.json 一个文件，不要为了这一个
            # 文件把 profile/summary/daily/memory 全部读一遍（code review 复审发现：Phase 2.9
            # 之后 read_scope() 在这条路径上白白多打好几次存储请求，OSS 后端尤其明显）。
            scope = MemoryScope(user_id, "qq", im.get("channel_id"), "group", im["chat_id"])
            members_data = await read_scope_json(scope, "members.json")
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
