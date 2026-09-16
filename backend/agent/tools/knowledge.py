"""知识技能：knowledge 条目的保存、更新、删除与直读。

读取边界（PRD-KNOWLEDGE-2）：read_knowledge 直读 KnowledgeStore，不经过
BM25 索引——写入即可读，强一致。search_memory 只负责记忆（profile/pattern/
daily/memory），不再承担知识检索；索引仅服务被动召回。
"""
from agent.knowledge.store import KnowledgeStore
from agent.tools.base import BaseSkill, Tool

_LIST_DEFAULT_LIMIT = 50
_LIST_MAX_LIMIT = 200


def _entry_summary(entry) -> dict:
    return {
        "knowledge_id": entry.id,
        "title": entry.title,
        "topic": entry.topic,
        "description": entry.description,
        "keywords": list(entry.keywords),
        "confidence": entry.confidence,
        "source_type": entry.source.type,
        "scope_type": entry.scope.type,
        "updated_at": entry.updated_at,
    }


async def _read_knowledge(db, user_id, args: dict):
    store = KnowledgeStore(user_id)
    entry_id = str(args.get("knowledge_id") or "").strip()
    if entry_id:
        entry = await store.get(entry_id)
        if entry is None:
            return {"error": "知识条目不存在或已停用；省略 knowledge_id 可列举现有条目"}
        payload = _entry_summary(entry)
        payload.update({"content": entry.content, "version": entry.version})
        return {"success": True, "entry": payload}

    scope_type = str(args.get("scope") or "").strip().lower()
    keyword = str(args.get("keyword") or "").strip().lower()
    try:
        limit = int(args.get("limit", _LIST_DEFAULT_LIMIT) or _LIST_DEFAULT_LIMIT)
    except (TypeError, ValueError):
        return {"error": f"limit 必须是 1 到 {_LIST_MAX_LIMIT} 的整数"}
    if not 1 <= limit <= _LIST_MAX_LIMIT:
        return {"error": f"limit 必须是 1 到 {_LIST_MAX_LIMIT} 的整数"}

    entries = await store.list()
    if scope_type:
        entries = [item for item in entries if item.scope.type == scope_type]
    if keyword:
        def _matches(item) -> bool:
            haystack = " ".join([
                item.title, item.content, item.topic, item.description,
                " ".join(item.keywords),
            ]).lower()
            return keyword in haystack
        entries = [item for item in entries if _matches(item)]

    total = len(entries)
    entries = entries[:limit]
    result = {
        "success": True,
        "total": total,
        "returned": len(entries),
        "entries": [_entry_summary(item) for item in entries],
    }
    if total > len(entries):
        result["note"] = f"共 {total} 条，仅返回最新 {len(entries)} 条；可用 keyword 缩小范围或调大 limit（上限 {_LIST_MAX_LIMIT}）"
    if not entries:
        result["note"] = "没有匹配的知识条目；keyword 过滤是对标题、正文、主题、描述与关键词的包含匹配"
    return result


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
        return {"error": "需要提供 knowledge_id；先用 read_knowledge 查询获取"}
    store = KnowledgeStore(user_id)
    entries = await store.list(active_only=True)
    old = next((item for item in entries if item.id == entry_id), None)
    if old is None:
        return {"error": "知识条目不存在或已删除；先用 read_knowledge 查询获取有效的 knowledge_id"}
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


class KnowledgeSkill(BaseSkill):
    name = "knowledge"
    tools = [
        Tool(
            name="read_knowledge", label="读取知识",
            description_short='直读知识条目：按 id 精确读，或列举/过滤全部知识。',
            description=(
                "直接读取已保存的知识条目，写入即可读，没有索引延迟。"
                "传 knowledge_id 时返回单条完整正文；省略时为列举模式，返回全部启用条目的清单"
                "（标题、描述、关键词、id 等，不含正文），可用 scope 按 scope 类型过滤、"
                "keyword 对标题/正文/主题/描述/关键词做包含匹配、limit 控制条数——这就是知识搜索入口。"
                "需要查某条知识的完整内容、确认刚保存的知识、或查找旧知识时都用本工具："
                "省略 knowledge_id 的列举模式本身就是全量搜索（keyword 对标题/正文/主题/描述/关键词"
                "做包含匹配，写入即可读、覆盖全部条目），不依赖检索索引、没有延迟。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "knowledge_id": {"type": "string"},
                    "scope": {"type": "string", "description": "按条目 scope 类型过滤，如 owner"},
                    "keyword": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": _LIST_MAX_LIMIT},
                },
            },
            repeat_safe=True,
            handler=_read_knowledge,
        ),
        Tool(
            name="save_knowledge", label="保存知识",
            description_short='保存可复用知识；支持来源类型、关键词和置信度。',
            description=(
                "保存一条已经整理好的、可长期复用的事实、规则或资料摘要。"
                "仅在用户明确要求保存，或已确认需要保留工具结果时使用；"
                "普通聊天不要自动保存。正文必须自包含并填写真实来源。"
                "可能与已有知识同主题时，先 read_knowledge(keyword=...) 查重：已有条目改用 update_knowledge 合并，"
                "save_knowledge 对同主题条目是整段替换，直接保存会覆盖旧正文。"
                "keywords 填未来检索时可能出现的稳定别名、工具名或专有名词，最多10个，"
                "单个不超过40字符，必须能从标题、主题或正文直接支持；不要把关键词当成额外事实。"
                "description 用一句触发式描述说明未来什么情况下需要这条知识，"
                "不超过150字符，帮助日后判断这条知识和当前任务是否相关；"
                "省略时只能靠标题和主题判断。"
                "保存成功后 read_knowledge 立即可读到该条目，无需重复验证；"
                "检索索引异步更新，只影响被动召回，不影响直读。"
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
                "knowledge_id 必须来自 read_knowledge 的真实结果。"
                "content 省略时保留原正文，只调整标题、主题、关键词或描述等字段；"
                "提供 content 时必须是合并旧内容后的完整正文，不要只写新增或修改的部分。"
                "title、topic、keywords、description 省略时保留原值，keywords 需要调整时给出完整新列表"
                "（最多10个，非字符串元素自动转为字符串）；description 提供时用一句触发式描述"
                "说明何时需要这条知识（不超过150字符）。"
                "内容与关键词都没有变化时不产生新版本。"
                "更新成功后 read_knowledge 立即可读到新内容；检索索引异步更新，只影响被动召回。"
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
    ]


KnowledgeSkill().register()
