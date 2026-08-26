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
    from agent.knowledge.models import KnowledgeEntry, KnowledgeScope
    from agent.knowledge.store import KnowledgeStore, source_from_input

    title = str(args.get("title") or "").strip()
    content = str(args.get("content") or "").strip()
    if not title or not content:
        return {"error": "需要提供 title 和 content"}
    source_type = str(args.get("source_type") or "user").strip().lower()
    confidence = str(args.get("confidence") or "confirmed").strip().lower()
    if confidence not in {"confirmed", "probable", "unverified"}:
        return {"error": "confidence 只能是 confirmed、probable 或 unverified"}
    try:
        source = source_from_input(
            source_type, str(args.get("source_ref") or ""),
            str(args.get("source_label") or ""),
        )
    except ValueError as exc:
        return {"error": str(exc)}
    entry = KnowledgeEntry.create(
        title=title, content=content, topic=str(args.get("topic") or ""),
        scope=KnowledgeScope(type="owner", owner_user_id=str(user_id)),
        source=source, confidence=confidence,  # type: ignore[arg-type]
    )
    try:
        saved = await KnowledgeStore(user_id).save(entry)
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
        "version": saved.version, "source_type": saved.source.type,
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
            description=(
                "保存用户明确要求长期保留的事实、规则或资料摘要。"
                "默认写入 owner 知识库，不把普通聊天自动保存为知识。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "知识条目标题"},
                    "content": {"type": "string", "description": "经过整理的知识正文"},
                    "topic": {"type": "string", "description": "主题，可选"},
                    "source_type": {"type": "string", "enum": ["user", "file", "web", "derived", "conversation"], "description": "来源类型，默认 user"},
                    "source_ref": {"type": "string", "description": "来源引用，可选"},
                    "source_label": {"type": "string", "description": "来源名称，可选"},
                    "confidence": {"type": "string", "enum": ["confirmed", "probable", "unverified"], "description": "可信度，默认 confirmed"},
                },
                "required": ["title", "content"],
            },
            handler=_save_knowledge,
            mutates=True,
        ),
        Tool(
            name="remember", label="记住",
            description="记录用户的稳定信息或做事方式；默认写入 profile，行为模式写入 pattern，并自动去重。",
            input_schema={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "要记住的一句话稳定画像或偏好"},
                    "target": {"type": "string", "enum": ["profile", "pattern"],
                               "description": "写入目标；默认 profile，行事/决策模式用 pattern"},
                    "type": {"type": "string", "enum": sorted(store.PROFILE_TYPES),
                             "description": "target=profile 时的画像类型，默认 note"},
                    "importance": {"type": "integer", "minimum": 1, "maximum": 5,
                                   "description": "target=pattern 时的重要度 1-5，默认 3"},
                },
                "required": ["text"],
            },
            handler=_remember,
            mutates=True,
        ),
        Tool(
            name="delete_knowledge", label="删除知识",
            description=(
                "删除一条已保存的知识条目并停止检索。必须先不带 confirm 请求确认，"
                "再携带确认凭证执行；历史版本不会被物理覆盖。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "knowledge_id": {"type": "string", "description": "知识条目 ID"},
                    "confirm": {"type": "boolean", "description": "仅用于携带确认凭证后的二次调用"},
                    "confirm_token": {"type": "string", "description": "确认请求返回的短时凭证"},
                },
                "required": ["knowledge_id"],
            },
            handler=_delete_knowledge,
            destructive=True,
            mutates=True,
        ),
        Tool(
            name="search_memory", label="搜索记忆",
            description="搜索用户的历史记忆、事件和对话背景；source=knowledge 用于已保存的事实与规则。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "要检索的关键词或短语"},
                    "scope": {"type": "string", "enum": ["auto", "current_group", "all_my_groups", "private_memory"], "description": "记忆范围，默认 auto；群聊可指定当前群或本人可见的其他群"},
                    "source": {"type": "string", "enum": ["all", "knowledge", "profile", "pattern", "daily", "memory"], "description": "记忆或知识来源，默认 all"},
                    "strategy": {"type": "string", "enum": ["auto", "bm25", "embedding"], "description": "检索策略，默认 auto；向量不可用时使用 TypeScript lexical worker"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 10, "description": "返回数量，默认 5，最多 10"},
                },
                "required": ["query"],
            },
            handler=_search_memory,
        ),
    ]


MemorySkill().register()
