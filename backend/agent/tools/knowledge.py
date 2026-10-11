"""知识技能：knowledge 条目的保存、更新、删除与检索。

read_knowledge 的关键词查询走统一 Knowledge BM25 索引；按 knowledge_id 精确读取仍直读
KnowledgeStore。索引异步更新，刚保存或更新的知识可能稍后才出现在关键词检索中。
"""
from datetime import datetime, timezone

from agent.knowledge.store import KnowledgeStore
from agent.tools.base import BaseSkill, Tool
from app.core.tz import ctx_tz

_SEARCH_DEFAULT_LIMIT = 5
_SEARCH_MAX_LIMIT = 25


def _entry_summary(entry) -> dict:
    def local_iso(timestamp: float) -> str:
        return datetime.fromtimestamp(timestamp, timezone.utc).astimezone(ctx_tz()).isoformat(
            timespec="seconds"
        )

    return {
        "knowledge_id": entry.id,
        "title": entry.title,
        "topic": entry.topic,
        "description": entry.description,
        "keywords": list(entry.keywords),
        "confidence": entry.confidence,
        "source_type": entry.source.type,
        "scope_type": entry.scope.type,
        "created_at": local_iso(entry.created_at),
        "updated_at": local_iso(entry.updated_at),
    }


async def _read_knowledge(db, user_id, args: dict):
    store = KnowledgeStore(user_id)
    entry_id = str(args.get("knowledge_id") or "").strip()
    if entry_id:
        entry = await store.get(entry_id)
        if entry is None:
            return {"error": "知识条目不存在或已停用；可用 keyword 进行 BM25 搜索"}
        payload = _entry_summary(entry)
        payload.update({"content": entry.content, "version": entry.version})
        return {"success": True, "entry": payload}

    scope_type = str(args.get("scope") or "").strip().lower()
    keyword = str(args.get("keyword") or "").strip()
    if not keyword:
        return {"error": "请提供 keyword 进行 BM25 检索，或提供 knowledge_id 精确读取完整条目"}
    try:
        limit = int(args.get("limit", _SEARCH_DEFAULT_LIMIT) or _SEARCH_DEFAULT_LIMIT)
    except (TypeError, ValueError):
        return {"error": f"limit 必须是 1 到 {_SEARCH_MAX_LIMIT} 的整数"}
    if not 1 <= limit <= _SEARCH_MAX_LIMIT:
        return {"error": f"limit 必须是 1 到 {_SEARCH_MAX_LIMIT} 的整数"}

    from agent.rag.models import Scope
    from agent.rag.service import search_knowledge

    recall = await search_knowledge(
        user_id,
        keyword,
        scope=Scope(owner_user_id=str(user_id), scope_type=scope_type or "owner"),
        source="knowledge",
        strategy="bm25",
        limit=limit,
        mode="tool",
        db=db,
    )
    # BM25 可返回同一条知识的多个命中片段。合并到一个条目，避免重复占用上下文，
    # 同时保留 knowledge_id 供后续精确读取、更新或删除使用。
    grouped: dict[str, dict] = {}
    for hit in recall.get("results", []):
        entry_id = str(hit.get("source_id") or "")
        if not entry_id:
            continue
        content = str(hit.get("text") or "")
        existing = grouped.get(entry_id)
        if existing is not None:
            if content and content not in existing["content"]:
                existing["content"] = f'{existing["content"]}\n\n{content}'.strip()
            continue
        grouped[entry_id] = {
            "knowledge_id": entry_id,
            "title": hit.get("title", ""),
            "topic": hit.get("topic", ""),
            "description": hit.get("description", ""),
            "keywords": hit.get("keywords", ""),
            "confidence": hit.get("confidence", ""),
            "source_type": hit.get("source_type", ""),
            "source_ref": hit.get("source_ref", ""),
            "source_label": hit.get("source_label", ""),
            "content": content,
            "score": hit.get("score"),
            "updated_at": hit.get("updated_at"),
            "version": hit.get("version", ""),
        }
    entries = list(grouped.values())
    result = {
        "success": True,
        "query": keyword,
        "strategy": "bm25",
        "returned": len(entries),
        "has_more": bool(recall.get("has_more")),
        "entries": entries,
    }
    if not entries:
        result["note"] = "BM25 索引中没有命中；刚保存或更新的知识可能尚未完成索引同步"
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
        purpose=confirm.ACTION,
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
            description_short='BM25 搜索知识；传 knowledge_id 可精确读取完整条目。',
            description=(
                "搜索已保存的知识条目。传 keyword 时使用 BM25 检索知识索引，支持关键词或自然语言问题；"
                "返回相关片段、知识元数据和 knowledge_id。多个片段会合并到同一条知识结果。"
                "索引异步更新，刚保存或更新的内容可能稍后才搜到；保存/更新回执中的 id 可用于立即按 knowledge_id 精确直读。"
                "可用 scope 按条目 scope 类型过滤，limit 控制结果条数。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "knowledge_id": {"type": "string"},
                    "scope": {"type": "string", "description": "按条目 scope 类型过滤，如 owner"},
                    "keyword": {"type": "string", "description": "BM25 查询词或自然语言问题；与 knowledge_id 二选一"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": _SEARCH_MAX_LIMIT},
                },
            },
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
                "keywords 用于辅助检索，最多10个；可传字符串数组，也兼容逗号、分号或换行分隔的字符串。"
                "关键词应是未来检索时可能出现的稳定别名、工具名或专有名词，"
                "单个不超过40字符，必须能从标题、主题或正文直接支持；不要把关键词当成额外事实。"
                "description 用一句触发式描述说明未来什么情况下需要这条知识，"
                "不超过150字符，帮助日后判断这条知识和当前任务是否相关；"
                "省略时只能靠标题和主题判断。"
                "保存回执表示条目已持久化；BM25 索引异步更新，刚保存的内容可能稍后才可通过 keyword 搜到。"
                "需要立即核对时，用回执中的 id 调 read_knowledge(knowledge_id=...) 精确直读。"
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
                "title、topic、keywords、description 省略时保留原值；keywords 需要调整时给出完整列表"
                "（可传字符串数组，也兼容逗号、分号或换行分隔的字符串）"
                "（最多10个，非字符串元素自动转为字符串）；description 提供时用一句触发式描述"
                "说明何时需要这条知识（不超过150字符）。"
                "内容与关键词都没有变化时不产生新版本。"
                "更新成功后可通过 knowledge_id 立即直读新内容；BM25 搜索索引异步更新，搜索结果可能短暂滞后。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "knowledge_id": {"type": "string"},
                    "content": {
                        "type": "string",
                        "maxLength": 3000,
                        "description": (
                            "可省略以保留原正文；需要更新时传合并后的完整正文，必须是单个普通字符串，"
                            "不要传对象、数组或 token/$text 分块包装。"
                        ),
                    },
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
