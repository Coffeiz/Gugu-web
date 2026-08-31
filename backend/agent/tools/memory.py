"""记忆技能：让咕咕能主动记住用户的画像或行事模式。

入口统一负责把用户输入路由到 profile/pattern，并交给 store 的规范化与去重管线，
避免工具直接拼出过时的 JSON 结构。
"""
import json

from agent.memory import store
from agent.rag.service import search_memory
from agent.tools.base import BaseSkill, Tool


async def _remember(db, user_id, args: dict):
    text = (args.get("text") or "").strip()
    if not text:
        return json.dumps({"error": "需要提供要记住的内容 text"})

    target = str(args.get("target") or "profile").strip().lower()
    if target not in {"profile", "pattern"}:
        return {"error": "target 只能是 profile 或 pattern"}

    if target == "profile":
        item_type = str(args.get("type") or "note").strip().lower()
        if item_type not in store.PROFILE_TYPES:
            return {"error": "profile type 不合法"}
        profile = await store.read_profile_list(user_id)
        profile = store.apply_profile_ops(profile, [{"type": item_type, "text": text}], [])
        await store.write_profile_list(user_id, profile)
    else:
        try:
            importance = int(args.get("importance", 3) or 3)
        except (TypeError, ValueError):
            return {"error": "pattern importance 必须是 1 到 5 的整数"}
        if not 1 <= importance <= 5:
            return {"error": "pattern importance 必须是 1 到 5 的整数"}
        patterns = await store.read_pattern_list(user_id)
        patterns = store.apply_pattern_ops(
            patterns,
            [{"text": text, "kind": "observed", "importance": importance}],
            [],
        )
        await store.write_pattern_list(user_id, patterns)
        await store.sync_pattern_vecs(user_id, patterns)

    from agent import events
    events.publish(events.types.MemoryUpdated(user_id=user_id, added=1, removed=0, source="remember"))
    return {"success": True, "target": target, "remembered": text}


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
        return {"error": "limit 必须是 1 到 10 的整数"}
    if not 1 <= limit <= 10:
        return {"error": "limit 必须是 1 到 10 的整数"}
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
    try:
        values = normalize_capture(
            args.get("title", ""), args.get("content", ""),
            topic=args.get("topic", ""), source_type=args.get("source_type", "user"),
            source_ref=args.get("source_ref", ""), source_label=args.get("source_label", ""),
            confidence=args.get("confidence", "confirmed"),
            capture_mode=args.get("capture_mode", "explicit"),
        )
    except ValueError as exc:
        return {"error": str(exc)}
    try:
        saved = await save_capture(user_id, values)
    except ValueError as exc:
        return {"error": str(exc)}
    try:
        from agent.rag.adapters.knowledge import KnowledgeAdapter
        from agent.memory import embedding
        from agent.rag.models import Scope
        from agent.rag.vector_cache import sync_knowledge_index_vectors

        if embedding.is_enabled():
            vector_scope = Scope(
                owner_user_id=str(user_id), scope_type="owner",
            )
            documents = await KnowledgeAdapter(user_id).build_documents(scope=vector_scope)
            await sync_knowledge_index_vectors(user_id, documents)
    except Exception:
        # 向量是可重建缓存，保存主数据成功后不因缓存不可用而失败。
        pass
    return {
        "success": True, "id": saved.id, "title": saved.title,
        "source_type": saved.source.type,
        "confidence": saved.confidence,
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
    )
    if blocked:
        return blocked
    deleted = await store.delete(entry_id)
    if deleted:
        from agent.rag.index_cache import get_index_cache
        get_index_cache().invalidate(user_id, "knowledge")
    return {"success": deleted, "knowledge_id": entry_id}


class MemorySkill(BaseSkill):
    name = "memory"
    tools = [
        Tool(
            name="save_knowledge", label="保存知识",
            description_short='保存可复用知识；支持来源类型和置信度。',
            description=(
                "保存一条已经整理好的、可长期复用的事实、规则或资料摘要。"
                "仅在用户明确要求保存，或已确认需要保留工具结果时使用；"
                "普通聊天不要自动保存。正文必须自包含并填写真实来源。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "content": {"type": "string"},
                    "topic": {"type": "string"},
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
            name="remember", label="记住",
            description_short='记住用户信息或行为模式；省略目标时保存为用户画像。',
            description="记录用户的稳定信息或做事方式；默认写入 profile，行为模式写入 pattern，并自动去重。",
            input_schema={
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "target": {"type": "string", "enum": ["profile", "pattern"]},
                    "type": {"type": "string", "enum": sorted(store.PROFILE_TYPES)},
                    "importance": {"type": "integer", "minimum": 1, "maximum": 5},
                },
                "required": ["text"],
            },
            handler=_remember,
            mutates=True,
        ),
        Tool(
            name="delete_knowledge", label="删除知识",
            description_short='删除已保存知识。',
            description=(
                "删除一条已保存的知识条目并停止检索。必须先不带 confirm 请求确认，"
                "再携带确认凭证执行；历史版本不会被物理覆盖。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "knowledge_id": {"type": "string"},
                    "confirm": {"type": "boolean"},
                    "confirm_token": {"type": "string"},
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
            description="搜索用户的历史记忆、事件和对话背景；source=knowledge 用于已保存的事实与规则。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "scope": {"type": "string", "enum": ["auto", "current_group", "all_my_groups", "private_memory"]},
                    "source": {"type": "string", "enum": ["all", "knowledge", "profile", "pattern", "daily", "memory"]},
                    "strategy": {"type": "string", "enum": ["auto", "bm25", "embedding"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 10},
                },
                "required": ["query"],
            },
            handler=_search_memory,
        ),
    ]


MemorySkill().register()
