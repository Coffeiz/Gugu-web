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
    if source not in {"all", "knowledge", "profile", "pattern", "daily", "memory"}:
        return {"error": "source 只能是 all、knowledge、profile、pattern、daily 或 memory"}
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


async def _save_knowledge(db, user_id, args: dict):
    from agent.knowledge.capture import normalize_capture, save_capture
    keywords = args.get("keywords")
    try:
        values = normalize_capture(
            args.get("title", ""), args.get("content", ""),
            topic=args.get("topic", ""), source_type=args.get("source_type", "user"),
            source_ref=args.get("source_ref", ""), source_label=args.get("source_label", ""),
            confidence=args.get("confidence", "confirmed"),
            capture_mode=args.get("capture_mode", "explicit"),
            keywords=[item for item in keywords if isinstance(item, str)] if isinstance(keywords, list) else [],
            description=args.get("description", ""),
        )
    except ValueError as exc:
        return {"error": str(exc)}
    try:
        saved = await save_capture(user_id, values)
    except ValueError as exc:
        return {"error": str(exc)}
    from agent.events import bus, types
    bus.publish(types.RagIndexUpdated(
        user_id=user_id, source_type="knowledge", source_id=saved.id, operation="upsert",
    ))
    return {
        "success": True, "id": saved.id, "title": saved.title,
        "source_type": saved.source.type,
        "confidence": saved.confidence,
        "index_status": "queued",
    }


async def _update_knowledge(db, user_id, args: dict):
    from agent.knowledge.capture import build_entry, normalize_capture
    from agent.knowledge.store import KnowledgeStore

    entry_id = str(args.get("knowledge_id") or "").strip()
    if not entry_id:
        return {"error": "需要提供 knowledge_id；先用 search_memory 查询获取"}
    store = KnowledgeStore(user_id)
    entries = await store.list(active_only=True)
    old = next((item for item in entries if item.id == entry_id), None)
    if old is None:
        return {"error": "知识条目不存在或已删除；先用 search_memory 查询获取有效的 knowledge_id"}
    # content 省略 = 部分更新（只调标题/主题/关键词/描述等元数据），正文保持不变
    content = str(args.get("content") or "").strip() or old.content
    description = str(args.get("description") or "").strip() or old.description
    keywords = args.get("keywords")
    confidence = str(args.get("confidence") or old.confidence or "probable").strip().lower()
    if confidence not in {"confirmed", "probable", "unverified"}:
        confidence = "probable"
    try:
        values = normalize_capture(
            args.get("title") or old.title, content,
            topic=args.get("topic") or old.topic,
            source_type=old.source.type, source_ref=old.source.ref, source_label=old.source.label,
            confidence=confidence, capture_mode="explicit",
            description=description,
            keywords=(
                # 容忍模型混入数字等标量（如 2026），统一转字符串；复杂结构丢弃
                [str(item).strip() for item in keywords
                 if isinstance(item, (str, int, float)) and str(item).strip()]
                if isinstance(keywords, list) else list(old.keywords)
            ),
        )
    except ValueError as exc:
        return {"error": str(exc)}
    entry = build_entry(user_id, values)
    entry.id = entry_id
    saved = await store.save(entry)
    from agent.events import bus, types
    bus.publish(types.RagIndexUpdated(
        user_id=user_id, source_type="knowledge", source_id=saved.id, operation="upsert",
    ))
    return {
        "success": True, "id": saved.id, "version": saved.version,
        "title": saved.title, "keywords": saved.keywords,
        "unchanged": saved.version == old.version,
        "previous": {"version": old.version, "content": old.content[:300]},
        "index_status": "queued",
    }


async def _delete_knowledge(db, user_id, args: dict):
    from agent.knowledge.store import KnowledgeStore
    from agent.security import confirm

    entry_id = str(args.get("knowledge_id") or "").strip()
    if not entry_id:
        return {"error": "需要提供 knowledge_id"}
    store = KnowledgeStore(user_id)
    entries = await store.list(active_only=True)
    entry = next((item for item in entries if item.id == entry_id), None)
    if entry is None:
        return {"error": "知识条目不存在"}
    blocked = confirm.needs_confirmation(
        args, f"将删除知识条目「{entry.title}」，保留历史但停止检索", user_id,
        identity=f"delete_knowledge:knowledge_id={entry_id}",
    )
    if blocked:
        return blocked
    deleted = await store.delete(entry_id)
    if deleted:
        from agent.events import bus, types
        bus.publish(types.RagIndexUpdated(
            user_id=user_id, source_type="knowledge", source_id=entry_id, operation="delete",
        ))
    return {"success": deleted, "knowledge_id": entry_id}


class MemorySkill(BaseSkill):
    name = "memory"
    tools = [
    Tool(
        name="save_knowledge", label="保存知识",
        description_short='保存可复用知识；支持来源类型、关键词和置信度。',
        description=(
            "保存一条已经整理好的、可长期复用的事实、规则或资料摘要。"
            "仅在用户明确要求保存，或已确认需要保留工具结果时使用；"
            "普通聊天不要自动保存。正文必须自包含并填写真实来源。"
            "可能与已有知识同主题时，先 search_memory 查重：已有条目改用 update_knowledge 合并，"
            "save_knowledge 对同主题条目是整段替换，直接保存会覆盖旧正文。"
            "keywords 填未来检索时可能出现的稳定别名、工具名或专有名词，最多10个，"
            "单个不超过40字符，必须能从标题、主题或正文直接支持；不要把关键词当成额外事实。"
            "description 用一句触发式描述说明未来什么情况下需要这条知识，"
            "不超过150字符，帮助日后判断这条知识和当前任务是否相关；"
            "省略时只能靠标题和主题判断。"
            "成功后会立即返回 knowledge_id 和 index_status=queued，但检索索引异步更新；不要为了验证而在同一轮连续重复搜索。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "content": {"type": "string", "maxLength": 3000},
                "topic": {"type": "string"},
                "keywords": {"type": "array", "items": {"type": "string"}},
                "description": {"type": "string", "maxLength": 150},
                "source_type": {"type": "string", "enum": ["user", "file", "web", "derived", "conversation"]},
                "source_ref": {"type": "string"},
                "source_label": {"type": "string"},
                "confidence": {"type": "string", "enum": ["confirmed", "probable", "unverified"]},
                "capture_mode": {"type": "string", "enum": ["explicit", "tool_result", "automatic"]},
            },
            "required": ["title", "content"],
        },
        handler=_save_knowledge,
        mutates=True,
    ),
    Tool(
        name="update_knowledge", label="更新知识",
        description_short='修正、刷新或合并一条已保存知识。',
        description=(
            "更新一条已存在的知识条目：修正记录错误、刷新过时内容或合并补充信息。"
            "knowledge_id 必须来自 search_memory 的真实结果。"
            "content 省略时保留原正文，只调整标题、主题、关键词或描述等字段；"
            "提供 content 时必须是合并旧内容后的完整正文，不要只写新增或修改的部分。"
            "title、topic、keywords、description 省略时保留原值，keywords 需要调整时给出完整新列表"
            "（最多10个，非字符串元素自动转为字符串）；description 提供时用一句触发式描述"
            "说明何时需要这条知识（不超过150字符）。"
            "内容与关键词都没有变化时不产生新版本。"
            "成功后检索索引异步更新；不要为了验证而在同一轮连续重复搜索。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "knowledge_id": {"type": "string"},
                "content": {"type": "string", "maxLength": 3000},
                "title": {"type": "string"},
                "topic": {"type": "string"},
                "keywords": {"type": "array", "items": {"type": "string"}},
                "description": {"type": "string", "maxLength": 150},
                "confidence": {"type": "string", "enum": ["confirmed", "probable", "unverified"]},
            },
            "required": ["knowledge_id"],
        },
        handler=_update_knowledge,
        mutates=True,
    ),
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
            name="delete_knowledge", label="删除知识",
            description_short='删除已保存知识。',
            description=(
                "删除一条已保存的知识条目并停止检索。首次调用会返回确认请求，"
                "用户在界面确认后由服务端继续执行本次删除，无需再次调用；"
                "历史版本不会被物理覆盖。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "knowledge_id": {"type": "string"},
                },
                "required": ["knowledge_id"],
            },
            handler=_delete_knowledge,
            destructive=True,
            mutates=True,
        ),
        Tool(
            name="search_memory", label="搜索记忆",
            description_short='搜索历史记忆；可按 scope/source/strategy 筛选，省略筛选项用默认值',
            description=(
                "搜索用户的历史记忆、事件和对话背景；source=knowledge 用于已保存的事实与规则。"
                "Knowledge 刚保存后索引可能尚未更新；若 save_knowledge 已成功，不要立即重复相同查询，"
                "以保存回执为准，确需复查时下一轮再搜索一次。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "scope": {"type": "string", "enum": ["auto", "current_group", "all_my_groups", "private_memory"]},
                    "source": {"type": "string", "enum": ["all", "knowledge", "profile", "pattern", "daily", "memory"]},
                    "strategy": {"type": "string", "enum": ["auto", "bm25", "embedding"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_ACTIVE_RESULTS},
                },
                "required": ["query"],
            },
            repeat_safe=True,
            handler=_search_memory,
        ),
    ]


MemorySkill().register()
