"""站内全局搜索：一个或多个关键词跨项目/文件/文件夹/日程/客户/对话检索（按 user_id 隔离）。

简单子串匹配（ILIKE %关键词%），对中文也有效、无需建全文索引。各类型各取前 N 条，
分组返回，供顶栏全局搜索框下拉展示 + 点击跳转。对话同时搜会话标题与消息正文。

`run_global_search` 是查询核心，路由和 agent 工具（`agent/tools/global_search.py`）
共用——路由给下拉框用小 per_type，工具给模型用更大的 per_type，避免各写一套。
"""
import json

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.security import get_current_user
from app.search.query import keyword_condition, keyword_score, normalize_mode, normalize_queries
from app.models import (
    User, UserPreferences, Project, File, Folder, CalendarEvent, Client,
    ConversationSession, ConversationMessage, MindNode,
)
from app.utils.romaji import is_romaji_query, romaji_match
from app.core.config import get_settings
from app.models import KnowledgeIndexEntry
from agent.rag.persistent_store import search_persistent_index
from agent.rag.ts_sidecar import TsSidecarUnavailable

router = APIRouter(prefix="/search", tags=["search"])

PER_TYPE = 6          # 每个类型返回的最大条数（下拉框用）
MSG_PER_TYPE = 8      # 对话消息扫描条数（合并去重后仍受 per_type 限制）
SNIPPET_PAD = 24      # 消息片段命中词前后各取多少字
ROMAJI_SCAN = 200     # 拼音/罗马音搜索时每类最多扫描条数

ALL_TYPES = ["project", "file", "folder", "event", "client", "conversation", "note"]

# 所有参与全局搜索的文本字段统一在这里登记；新增字段只需补这一张表。
ROMAJI_FIELDS = {
    "project": ("name", "client", "current_stage"),
    "file": ("display_name", "ext"),
    "folder": ("name",),
    "event": ("title", "description", "client"),
    "client": ("name", "contact", "email", "phone", "notes"),
    "note": ("title", "content_plain"),
    "conversation": ("title",),
    "message": ("content",),
}


def _snippet(text: str, q: str) -> str:
    """从命中处截一小段，首尾加省略号，方便下拉里展示上下文。"""
    if not text:
        return ""
    low = text.lower()
    i = low.find(q.lower())
    if i < 0:
        return text[:60].strip()
    start = max(0, i - SNIPPET_PAD)
    end = min(len(text), i + len(q) + SNIPPET_PAD)
    seg = text[start:end].strip().replace("\n", " ")
    return ("…" if start > 0 else "") + seg + ("…" if end < len(text) else "")


def _snippet_for_queries(text: str, queries: list[str]) -> str:
    """从第一个实际命中的关键词截取片段。"""
    for query in queries:
        snippet = _snippet(text, query)
        if query.casefold() in (text or "").casefold():
            return snippet
    return _snippet(text, queries[0]) if queries else (text or "")[:60].strip()


def _romaji_matches_any(text: str, queries: list[str], language: str) -> bool:
    return any(romaji_match(text or "", query, language) for query in queries)


def _romaji_matches_object(obj, kind: str, queries: list[str], language: str) -> bool:
    """按统一字段注册表匹配对象，避免各搜索分支遗漏可搜索文本。"""
    return any(
        _romaji_matches_any(getattr(obj, field, ""), queries, language)
        for field in ROMAJI_FIELDS[kind]
    )


def _primary_rank(column, q: str):
    """名称精确/前缀命中优先于纯子串命中；只用标准 SQL，SQLite 测试也保持一致。"""
    normalized = q.lower()
    return case(
        (func.lower(column) == normalized, 0),
        (func.lower(column).like(f"{normalized}%"), 1),
        else_=2,
    )


async def _run_ilike_search(db: AsyncSession, user_id, q: str, *,
                            per_type: int = PER_TYPE, types: list[str] | None = None,
                            queries: list[str] | None = None, mode: str = "OR",
                            language: str = "zh-CN") -> dict:
    """跨类型多关键词搜索核心逻辑。`types` 不传则搜全部，传了只搜指定类型
    （值域见 ALL_TYPES：project/file/folder/event/client/conversation）。"""
    original_query = (q or "").strip()
    search_queries = normalize_queries(original_query, queries)
    mode = normalize_mode(mode)
    if not search_queries:
        return {"query": original_query, "queries": [], "mode": mode, "total": 0, "groups": []}
    wanted = set(types) if types else None
    uid = user_id
    q = search_queries[0]
    groups: list = []
    use_romaji = any(is_romaji_query(query) for query in search_queries)

    # ── 项目：名/客户/当前阶段 ──
    if wanted is None or "project" in wanted:
        rows = list((await db.execute(
            select(Project).where(
                Project.user_id == uid,
                keyword_condition([Project.name, Project.client, Project.current_stage], search_queries, mode),
            ).order_by(keyword_score([Project.name, Project.client, Project.current_stage], search_queries).desc(),
                       _primary_rank(Project.name, q), Project.updated_at.desc()).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {p.id for p in rows}
            scan = (await db.execute(
                select(Project).where(Project.user_id == uid)
                .order_by(Project.updated_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for p in scan:
                if p.id not in seen and _romaji_matches_object(p, "project", search_queries, language):
                    rows.append(p); seen.add(p.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            groups.append({"type": "project", "label": "项目", "items": [
                {"id": p.id, "title": p.name,
                 "subtitle": " · ".join(filter(None, [p.client, p.status]))}
                for p in rows
            ]})

    # ── 文件：文件名（排除回收站）──
    if wanted is None or "file" in wanted:
        rows = list((await db.execute(
            select(File).where(
                File.user_id == uid, File.deleted_at.is_(None),
                keyword_condition([File.display_name, File.ext], search_queries, mode),
            ).order_by(keyword_score([File.display_name, File.ext], search_queries).desc(),
                       _primary_rank(File.display_name, q), File.updated_at.desc()).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {f.id for f in rows}
            scan = (await db.execute(
                select(File).where(File.user_id == uid, File.deleted_at.is_(None))
                .order_by(File.updated_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for f in scan:
                if f.id not in seen and _romaji_matches_object(f, "file", search_queries, language):
                    rows.append(f); seen.add(f.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            _space = {"project": "项目", "mind": "思维", "asset": "素材", "personal": "个人"}
            groups.append({"type": "file", "label": "文件", "items": [
                {"id": f.id, "title": f"{f.display_name}.{f.ext}" if f.ext else f.display_name,
                 "subtitle": f"{_space.get(f.space, f.space)}空间 · {f.size}".strip(" ·")}
                for f in rows
            ]})

    # ── 文件夹：名 ──
    if wanted is None or "folder" in wanted:
        rows = list((await db.execute(
            select(Folder).where(Folder.user_id == uid,
                                 keyword_condition([Folder.name], search_queries, mode))
            .order_by(keyword_score([Folder.name], search_queries).desc(),
                      _primary_rank(Folder.name, q), Folder.created_at.desc()).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {fo.id for fo in rows}
            scan = (await db.execute(
                select(Folder).where(Folder.user_id == uid)
                .order_by(Folder.created_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for fo in scan:
                if fo.id not in seen and _romaji_matches_object(fo, "folder", search_queries, language):
                    rows.append(fo); seen.add(fo.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            groups.append({"type": "folder", "label": "文件夹", "items": [
                {"id": fo.id, "title": fo.name, "subtitle": "文件夹"} for fo in rows
            ]})

    # ── 日程/事件：标题/描述/客户 ──
    if wanted is None or "event" in wanted:
        rows = list((await db.execute(
            select(CalendarEvent).where(
                CalendarEvent.user_id == uid,
                keyword_condition([CalendarEvent.title, CalendarEvent.description, CalendarEvent.client],
                                  search_queries, mode),
            ).order_by(keyword_score([CalendarEvent.title, CalendarEvent.description, CalendarEvent.client],
                                      search_queries).desc(),
                       _primary_rank(CalendarEvent.title, q), CalendarEvent.date.desc()).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {e.id for e in rows}
            scan = (await db.execute(
                select(CalendarEvent).where(CalendarEvent.user_id == uid)
                .order_by(CalendarEvent.date.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for e in scan:
                if e.id not in seen and _romaji_matches_object(e, "event", search_queries, language):
                    rows.append(e); seen.add(e.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            groups.append({"type": "event", "label": "日程", "items": [
                {"id": e.id, "title": e.title, "date": e.date,
                 "subtitle": " · ".join(filter(None, [e.date, e.client]))}
                for e in rows
            ]})

    # ── 客户：名/联系人/邮箱/电话/备注 ──
    if wanted is None or "client" in wanted:
        rows = list((await db.execute(
            select(Client).where(
                Client.user_id == uid,
                keyword_condition([Client.name, Client.contact, Client.email, Client.phone, Client.notes],
                                  search_queries, mode),
            ).order_by(keyword_score([Client.name, Client.contact, Client.email, Client.phone, Client.notes],
                                      search_queries).desc(),
                       _primary_rank(Client.name, q), Client.created_at.desc()).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {c.id for c in rows}
            scan = (await db.execute(
                select(Client).where(Client.user_id == uid)
                .order_by(Client.created_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for c in scan:
                if c.id not in seen and _romaji_matches_object(c, "client", search_queries, language):
                    rows.append(c); seen.add(c.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            groups.append({"type": "client", "label": "客户", "items": [
                {"id": c.id, "title": c.name,
                 "subtitle": " · ".join(filter(None, [c.contact, c.email, c.phone]))}
                for c in rows
            ]})

    # ── 思维便签：标题 + 正文（便签短，正文可以直接搜，不像文件那样只能搜名）──
    #    只搜 kind='note'：ref 节点只是业务对象的引用代理，真身已经在上面各类里搜过了，
    #    再出一遍就是重复；软删的墓碑也不该出现在搜索里。
    if wanted is None or "note" in wanted:
        rows = list((await db.execute(
            select(MindNode).where(
                MindNode.user_id == uid,
                MindNode.kind == "note",
                MindNode.deleted_at.is_(None),
                keyword_condition([MindNode.title, MindNode.content_plain], search_queries, mode),
            ).order_by(
                keyword_score([MindNode.title, MindNode.content_plain], search_queries).desc(),
                case(
                    (func.lower(MindNode.title) == q.lower(), 0),
                    (func.lower(MindNode.title).like(f"{q.lower()}%"), 1),
                    (MindNode.title.ilike(f"%{q}%"), 2),
                    else_=3,  # 只在正文命中：保留，但排在标题命中之后
                ),
                MindNode.captured_at.desc(),
            ).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {n.id for n in rows}
            scan = (await db.execute(
                select(MindNode).where(
                    MindNode.user_id == uid, MindNode.kind == "note",
                    MindNode.deleted_at.is_(None),
                ).order_by(MindNode.captured_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for n in scan:
                # 便签正文通常较短；日记正文也应支持罗马音检索。
                if n.id not in seen and _romaji_matches_object(n, "note", search_queries, language):
                    rows.append(n); seen.add(n.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            groups.append({"type": "note", "label": "便签", "items": [
                {"id": n.id,
                 "title": n.title or _snippet_for_queries(n.content_plain, search_queries) or "无标题便签",
                 "subtitle": _snippet_for_queries(n.content_plain, search_queries),
                 # Agent 的 update_note 需要乐观锁版本；搜索结果必须能直接作为更新输入，
                 # 不能逼调用方猜 version 或先用失败请求探测版本。
                 "version": n.version}
                for n in rows
            ]})

    # ── 对话：会话标题 + 消息正文（合并去重，正文命中给片段）──
    if wanted is None or "conversation" in wanted:
        conv: dict = {}   # session_id → {id, title, subtitle}
        title_rows = (await db.execute(
            select(ConversationSession).where(
                ConversationSession.user_id == uid,
                keyword_condition([ConversationSession.title], search_queries, mode),
            ).order_by(keyword_score([ConversationSession.title], search_queries).desc(),
                       _primary_rank(ConversationSession.title, q), ConversationSession.updated_at.desc()).limit(per_type)
        )).scalars().all()
        for s in title_rows:
            conv[s.id] = {"id": s.id, "title": s.title, "subtitle": "对话"}

        msg_rows = (await db.execute(
            select(ConversationMessage, ConversationSession.title)
            .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
            .where(ConversationSession.user_id == uid,
                   keyword_condition([ConversationMessage.content], search_queries, mode))
            .order_by(
                keyword_score([ConversationMessage.content], search_queries).desc(),
                ConversationMessage.created_at.desc(),
            ).limit(MSG_PER_TYPE)
        )).all()
        for m, stitle in msg_rows:
            if m.session_id not in conv:
                conv[m.session_id] = {"id": m.session_id, "title": stitle,
                                      "subtitle": _snippet_for_queries(m.content, search_queries),
                                      "message_id": m.id}
            if len(conv) >= per_type:
                break

        if use_romaji and len(conv) < per_type:
            # 拼音/罗马音扫描对话标题
            sess_scan = (await db.execute(
                select(ConversationSession).where(ConversationSession.user_id == uid)
                .order_by(ConversationSession.updated_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for s in sess_scan:
                if s.id not in conv and _romaji_matches_object(s, "conversation", search_queries, language):
                    conv[s.id] = {"id": s.id, "title": s.title, "subtitle": "对话"}
                    if len(conv) >= per_type:
                        break

            if len(conv) < per_type:
                message_scan = (await db.execute(
                    select(ConversationMessage, ConversationSession.title)
                    .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
                    .where(ConversationSession.user_id == uid)
                    .order_by(ConversationMessage.created_at.desc()).limit(ROMAJI_SCAN)
                )).all()
                for message, session_title in message_scan:
                    if message.session_id not in conv and _romaji_matches_object(
                        message, "message", search_queries, language,
                    ):
                        conv[message.session_id] = {
                            "id": message.session_id, "title": session_title,
                            "subtitle": _snippet_for_queries(message.content, search_queries),
                            "message_id": message.id,
                        }
                        if len(conv) >= per_type:
                            break

        if conv:
            groups.append({"type": "conversation", "label": "对话",
                           "items": list(conv.values())[:per_type]})

    total = sum(len(g["items"]) for g in groups)
    return {"query": original_query or " ".join(search_queries),
            "queries": search_queries, "mode": mode, "total": total, "groups": groups}


INDEXED_SEARCH_TYPES = {"project", "file", "note"}
INDEXED_LABELS = {"project": "项目", "file": "文件", "note": "便签"}


async def _run_index_search(
    db: AsyncSession, user_id, q: str, *, per_type: int,
    types: list[str] | None, queries: list[str] | None, mode: str, language: str,
) -> dict:
    """使用持久化索引搜索已完成建索引的来源，其余来源交给原 ILIKE 查询。"""
    original_query = (q or "").strip()
    search_queries = normalize_queries(original_query, queries)
    normalized_mode = normalize_mode(mode)
    wanted = set(types) if types else set(ALL_TYPES)
    indexed_types = wanted & INDEXED_SEARCH_TYPES
    ilike_types = wanted - INDEXED_SEARCH_TYPES
    if not indexed_types:
        return await _run_ilike_search(
            db, user_id, q, per_type=per_type, types=types,
            queries=queries, mode=normalized_mode, language=language,
        )

    # 没有任何索引行的来源仍走 ILIKE，避免索引尚未重建时静默丢结果。
    indexed_rows = (await db.execute(
        select(KnowledgeIndexEntry.source_type).where(
            KnowledgeIndexEntry.owner_user_id == user_id,
            KnowledgeIndexEntry.source_type.in_(indexed_types),
            KnowledgeIndexEntry.deleted_at.is_(None),
        ).distinct()
    )).scalars().all()
    ready_types = indexed_types & set(indexed_rows)
    ilike_types |= indexed_types - ready_types
    groups_by_type: dict[str, dict] = {}
    if ready_types and search_queries:
        hits = []
        for source in sorted(ready_types):
            try:
                hits.extend(await search_persistent_index(
                    db, user_id, " ".join(search_queries),
                    source_types={source}, limit=max(per_type * 3, per_type),
                ))
            except TsSidecarUnavailable:
                # 词法 worker 未部署或临时不可用时，继续走同类型 ILIKE，避免全局搜索 500。
                ilike_types.add(source)
        # 一个业务对象可能有多个 chunk，只保留最高分 chunk，保持每类输出条数稳定。
        hit_ids: dict[str, list[str]] = {source: [] for source in ready_types}
        hit_docs: dict[tuple[str, str], object] = {}
        for hit in hits:
            source = hit.document.source_type
            source_id = hit.document.source_id
            key = (source, source_id)
            if source_id not in hit_ids.setdefault(source, []):
                hit_ids[source].append(source_id)
                hit_docs[key] = hit.document
            if len(hit_ids[source]) >= per_type:
                continue

        for source in ready_types:
            ids = hit_ids.get(source, [])[:per_type]
            if not ids:
                continue
            if source == "project":
                rows = (await db.execute(select(Project).where(
                    Project.user_id == user_id, Project.id.in_([int(i) for i in ids if str(i).isdigit()]),
                ))).scalars().all()
                by_id = {str(row.id): row for row in rows}
                items = [{"id": row.id, "title": row.name,
                          "subtitle": " · ".join(filter(None, [row.client, row.status]))}
                         for key in ids if (row := by_id.get(str(key)))]
            elif source == "file":
                rows = (await db.execute(select(File).where(
                    File.user_id == user_id, File.deleted_at.is_(None),
                    File.id.in_([int(i) for i in ids if str(i).isdigit()]),
                ))).scalars().all()
                by_id = {str(row.id): row for row in rows}
                space = {"project": "项目", "mind": "思维", "asset": "素材", "personal": "个人"}
                items = [{"id": row.id,
                          "title": f"{row.display_name}.{row.ext}" if row.ext else row.display_name,
                          "subtitle": f"{space.get(row.space, row.space)}空间 · {row.size}".strip(" ·")}
                         for key in ids if (row := by_id.get(str(key)))]
            else:
                rows = (await db.execute(select(MindNode).where(
                    MindNode.user_id == user_id, MindNode.kind == "note",
                    MindNode.deleted_at.is_(None),
                    MindNode.id.in_([int(i) for i in ids if str(i).isdigit()]),
                ))).scalars().all()
                by_id = {str(row.id): row for row in rows}
                items = [{"id": row.id,
                          "title": row.title or "无标题便签",
                          "subtitle": _snippet_for_queries(
                              hit_docs[(source, str(row.id))].content, search_queries),
                          "version": row.version}
                         for key in ids if (row := by_id.get(str(key)))]
            if items:
                groups_by_type[source] = {"type": source, "label": INDEXED_LABELS[source], "items": items}

    if ilike_types:
        ilike_result = await _run_ilike_search(
            db, user_id, q, per_type=per_type, types=sorted(ilike_types),
            queries=queries, mode=normalized_mode, language=language,
        )
        groups_by_type.update({group["type"]: group for group in ilike_result["groups"]})
    groups = [groups_by_type[source] for source in ALL_TYPES if source in groups_by_type]
    return {"query": original_query or " ".join(search_queries),
            "queries": search_queries, "mode": normalized_mode,
            "total": sum(len(group["items"]) for group in groups), "groups": groups}


async def run_global_search(db: AsyncSession, user_id, q: str, *,
                            per_type: int = PER_TYPE, types: list[str] | None = None,
                            queries: list[str] | None = None, mode: str = "OR",
                            language: str | None = None) -> dict:
    """统一全局搜索入口；Admin 可在索引与 ILIKE 之间热切换。"""
    search_queries = normalize_queries(q, queries)
    if language not in {"zh-CN", "ja-JP", "en-US"}:
        prefs = await db.execute(select(UserPreferences.data_json).where(UserPreferences.user_id == user_id))
        try:
            language = json.loads(prefs.scalar_one_or_none() or "{}").get("locale")
        except (TypeError, ValueError):
            language = None
    language = language if language in {"zh-CN", "ja-JP", "en-US"} else "zh-CN"
    # 持久化索引按原文检索，无法执行拼音/罗马音转换；这类查询必须走
    # ILIKE 扫描分支，才能覆盖 SudachiPy/romkan2 的候选读音。
    if any(is_romaji_query(query) for query in search_queries):
        return await _run_ilike_search(
            db, user_id, q, per_type=per_type, types=types,
            queries=queries, mode=mode, language=language,
        )
    if get_settings().search.global_search_backend == "ilike":
        return await _run_ilike_search(
            db, user_id, q, per_type=per_type, types=types, queries=queries, mode=mode, language=language,
        )
    return await _run_index_search(
        db, user_id, q, per_type=per_type, types=types, queries=queries, mode=mode, language=language,
    )


@router.get("")
async def search(
    q: str = "",
    queries: list[str] | None = Query(default=None),
    mode: str = "OR",
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await run_global_search(db, current_user.id, q, queries=queries, mode=mode)
