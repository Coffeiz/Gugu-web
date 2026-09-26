"""记忆技能：让咕咕能主动记住用户的画像或行事模式。

入口统一负责把用户输入路由到 profile/pattern，并交给 store 的规范化与去重管线，
避免工具直接拼出过时的 JSON 结构。
"""
from agent.memory import store
from agent.rag.service import MAX_ACTIVE_RESULTS, search_memory
from agent.tools.base import BaseSkill, Tool


def _diff_added_removed(before: list[dict], after: list[dict]) -> tuple[int, int]:
    """按 store 相同的相似匹配口径统计本轮真实增删。

    列表长度差分无法区分「删一条 + 加一条」的替换（净长度为 0），必须逐条对账：
    旧条目在新列表里找不到相似对应 → 被删除；新条目在旧列表里无相似来源 → 新增。
    """
    removed = sum(
        1 for item in before
        if not any(store._pattern_similar(item.get("text", ""), kept.get("text", "")) for kept in after)
    )
    added = sum(
        1 for item in after
        if not any(store._pattern_similar(item.get("text", ""), old.get("text", "")) for old in before)
    )
    return added, removed


async def _remember(db, user_id, args: dict):
    text = (args.get("text") or "").strip()
    raw_remove = args.get("remove")
    if isinstance(raw_remove, str):
        remove_items = [raw_remove.strip()] if raw_remove.strip() else []
    elif isinstance(raw_remove, list):
        remove_items = [str(item).strip() for item in raw_remove if str(item or "").strip()]
    else:
        remove_items = []
    if not text and not remove_items:
        return {"error": "需要提供要记住的内容 text，或要忘记的条目列表 remove"}

    target = str(args.get("target") or "profile").strip().lower()
    if target not in {"profile", "pattern"}:
        return {"error": "target 只能是 profile 或 pattern"}

    if target == "profile":
        profile = await store.read_profile_list(user_id)
        before_items = list(profile)
        ops_add = []
        if text:
            item_type = str(args.get("type") or "note").strip().lower()
            if item_type not in store.PROFILE_TYPES:
                return {"error": "profile type 不合法"}
            ops_add = [{"type": item_type, "text": text}]
        profile = store.apply_profile_ops(profile, ops_add, remove_items)
        await store.write_profile_list(user_id, profile)
    else:
        patterns = await store.read_pattern_list(user_id)
        before_items = list(patterns)
        ops_add = []
        if text:
            try:
                importance = int(args.get("importance", 3) or 3)
            except (TypeError, ValueError):
                return {"error": "pattern importance 必须是 1 到 5 的整数"}
            if not 1 <= importance <= 5:
                return {"error": "pattern importance 必须是 1 到 5 的整数"}
            ops_add = [{"text": text, "kind": "observed", "importance": importance}]
        patterns = store.apply_pattern_ops(patterns, ops_add, remove_items)
        await store.write_pattern_list(user_id, patterns)
        await store.sync_pattern_vecs(user_id, patterns)

    after_items = profile if target == "profile" else patterns
    added, removed = _diff_added_removed(before_items, after_items)
    from agent import events
    events.publish(events.types.MemoryUpdated(
        user_id=user_id, added=added, removed=removed, source="remember",
    ))
    result = {"success": True, "target": target, "added": added, "removed": removed}
    if text:
        result["remembered"] = text
    return result


async def _search_memory(db, user_id, args: dict):
    query = str(args.get("query") or "").strip()
    source = str(args.get("source") or "all").strip().lower()
    scope = str(args.get("scope") or "auto").strip().lower()
    strategy = str(args.get("strategy") or "auto").strip().lower()
    if source == "knowledge":
        # 知识域已独立（PRD-KNOWLEDGE-2）：精确读取走 read_knowledge 直读工具
        return {"error": "知识检索已独立：用 read_knowledge 直读或列举知识条目；search_memory 只搜记忆（profile/pattern/daily/memory）"}
    if source not in {"all", "profile", "pattern", "daily", "memory"}:
        return {"error": "source 只能是 all、profile、pattern、daily 或 memory（知识用 read_knowledge）"}
    if strategy not in {"auto", "bm25", "embedding"}:
        return {"error": "strategy 只能是 auto、bm25 或 embedding"}
    try:
        limit = int(args.get("limit", 5) or 5)
    except (TypeError, ValueError):
        return {"error": f"limit 必须是 1 到 {MAX_ACTIVE_RESULTS} 的整数"}
    if not 1 <= limit <= MAX_ACTIVE_RESULTS:
        return {"error": f"limit 必须是 1 到 {MAX_ACTIVE_RESULTS} 的整数"}
    try:
        from agent.im import imctx
        return await search_memory(
            user_id, query, scope=scope, source=source, strategy=strategy,
            limit=limit, db=db, im_context=imctx.get_im(),
        )
    except (ValueError, PermissionError) as exc:
        return {"error": str(exc)}


class MemorySkill(BaseSkill):
    name = "memory"
    tools = [
    Tool(
        name="remember", label="记住",
        description_short='记住或忘记用户信息、行为模式；省略目标时写画像。',
        description=(
            "记录用户的稳定信息或做事方式；默认写入 profile，行为模式写入 pattern，并自动去重。"
            "remove 传要忘记条目的原文或接近原文的文本数组，按相似匹配从 target 对应列表删除，"
            "用于用户要求忘记、撤销或更正某条画像/行为模式；text 与 remove 至少提供一个，可同轮使用（先删后记）。"
            "不确定要删除条目的原文时，先用 search_memory(source=profile 或 pattern) 查询。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "target": {"type": "string", "enum": ["profile", "pattern"]},
                "type": {"type": "string", "enum": sorted(store.PROFILE_TYPES)},
                "importance": {"type": "integer", "minimum": 1, "maximum": 5},
                "remove": {"type": "array", "items": {"type": "string"}},
            },
        },
        handler=_remember,
        mutates=True,
    ),
    Tool(
        name="search_memory", label="搜索记忆",
        description_short='搜索历史记忆；可按 scope/source/strategy 筛选，省略筛选项用默认值',
        description=(
            "搜索用户的历史记忆、事件和对话背景，只覆盖 profile/pattern/daily/memory。"
            "不含知识条目：已保存的事实与规则用 read_knowledge 直读或列举。"
            "记忆检索走索引，刚保存的内容可能有短暂延迟；以保存回执为准，确需复查时下一轮再搜。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "scope": {"type": "string", "enum": ["auto", "current_group", "all_my_groups", "private_memory"]},
                "source": {"type": "string", "enum": ["all", "profile", "pattern", "daily", "memory"]},
                "strategy": {"type": "string", "enum": ["auto", "bm25", "embedding"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_ACTIVE_RESULTS},
            },
            "required": ["query"],
        },
        handler=_search_memory,
    ),
    ]


MemorySkill().register()
