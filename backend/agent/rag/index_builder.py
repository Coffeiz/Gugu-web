"""把业务主数据投影为统一知识索引 chunk。"""
from __future__ import annotations

import asyncio
from collections import defaultdict

from sqlalchemy import select

from app.core.chat_attach import TEXT_EXTS
from app.services.storage import get_storage
from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.adapters.knowledge import KnowledgeAdapter
from agent.rag.adapters.projects import ProjectAdapter
from agent.rag.chunking import split_text, text_version
from agent.rag.models import IndexDocument, Scope
from agent.rag.persistent_store import replace_source_documents
from app.models import (
    CalendarEvent,
    ConversationMessage,
    ConversationSession,
    File,
    MindCanvasItem,
    MindMap,
    MindNode,
    MindRelation,
    ScheduledTask,
)


FILE_TEXT_MAX_BYTES = 1 * 1024 * 1024
FILE_DOCUMENT_LOAD_CONCURRENCY = 8


async def _extract_file_text(row: File) -> str:
    """只抽取受支持的小型文本文件；失败时保留元数据索引，不伪造正文。"""
    if (row.ext or "").lower() not in TEXT_EXTS:
        return ""
    if row.size_bytes and row.size_bytes > FILE_TEXT_MAX_BYTES:
        return ""
    try:
        info = await get_storage().stat(row.storage_key)
        if info is not None and info.size > FILE_TEXT_MAX_BYTES:
            return ""
        raw = await get_storage().get(row.storage_key)
        return raw.decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


async def _extract_file_text_bounded(row: File, semaphore: asyncio.Semaphore) -> str:
    async with semaphore:
        return await _extract_file_text(row)


def _scope(owner_user_id: object, session=None) -> Scope:
    if session is not None and session.chat_type == "group" and session.chat_id:
        return Scope(
            owner_user_id=str(owner_user_id),
            platform=session.source or "",
            bot_id=session.bot_id or "",
            group_id=session.chat_id,
            scope_type="group",
            scope_id=session.chat_id,
        )
    return Scope(owner_user_id=str(owner_user_id), scope_type="owner")


def _iso_or_none(value) -> str | None:
    return value.isoformat() if value is not None else None


def _version_parts(*parts) -> list[str]:
    """版本输入字段统一序列化为字符串（datetime 用 isoformat），与 TS 适配器逐位对齐。"""
    return [part.isoformat() if hasattr(part, "isoformat") else str(part or "") for part in parts]


def file_record(row, body: str) -> dict:
    return {
        "source_type": "file", "id": str(row.id), "title": row.display_name,
        "ext": row.ext or "", "mime_type": row.mime_type or "",
        "project_id": str(row.project_id or ""), "folder_id": str(row.folder_id or ""),
        "space": row.space or "", "stage_name": row.stage_name or "",
        "content": body or "",
        "version_parts": _version_parts(row.id, row.version, row.updated_at),
        "updated_at": _iso_or_none(row.updated_at),
    }


def note_record(row) -> dict:
    return {
        "source_type": "note", "id": str(row.id), "title": row.title or "",
        "content_plain": row.content_plain or "", "content_md": row.content_md or "",
        "kind": row.kind,
        "version_parts": _version_parts(row.id, row.version, row.indexed_hash or ""),
        "updated_at": _iso_or_none(row.updated_at),
    }


def canvas_record(item, canvas, node, *, relation_summary: str, group_path: str) -> dict:
    return {
        "source_type": "canvas", "id": str(item.id),
        "canvas_id": str(canvas.id), "canvas_title": canvas.title or "",
        "node_id": str(node.id), "node_title": node.title or "",
        "node_type": node.kind,
        "content": node.content_plain or node.content_md or "",
        "group_path": group_path, "relation_summary": relation_summary,
        "project_id": str(canvas.project_id or ""),
        "version_parts": _version_parts(item.id, item.updated_at, node.version),
        "updated_at": _iso_or_none(item.updated_at),
    }


def calendar_record(row) -> dict:
    return {
        "source_type": "calendar", "id": str(row.id), "title": row.title,
        "date": row.date, "time": row.time or "", "description": row.description or "",
        "project_id": str(row.project_id or ""),
        "version_parts": _version_parts(row.id, row.version, row.date, row.description or ""),
    }


def scheduled_task_record(row) -> dict:
    return {
        "source_type": "scheduled_task", "id": str(row.id), "name": row.name,
        "cron": row.cron, "enabled": bool(row.enabled), "payload": row.payload or "",
        "version_parts": _version_parts(row.id, row.updated_at, row.cron, row.payload or ""),
    }


def conversation_summary_record(session) -> dict:
    return {
        "source_type": "conversation", "kind": "summary", "id": f"{session.id}:summary",
        "session_id": str(session.id),
        "title": session.title or "", "summary": session.summary or "",
        "session_source": session.source or "",
        "session_updated_at": session.updated_at.isoformat() if session.updated_at else "",
        "version_parts": _version_parts(session.id, session.updated_at, session.summary),
        "updated_at": _iso_or_none(session.updated_at),
    }


def conversation_message_record(session, row) -> dict:
    return {
        "source_type": "conversation", "kind": "message", "id": str(row.id),
        "session_id": str(session.id),
        "title": session.title or "", "role": row.role, "content": row.content or "",
        "session_source": session.source or "",
        "session_updated_at": session.updated_at.isoformat() if session.updated_at else "",
        "version_parts": _version_parts(row.id, row.created_at, row.content),
        "updated_at": (row.sent_at or row.created_at).isoformat() if (row.sent_at or row.created_at) else None,
    }


def record_text(record: dict) -> str:
    """来源记录 → 检索全文；与 TS 适配器的文本组装逐字段对齐。"""
    source_type = record["source_type"]
    if source_type == "file":
        return "\n".join(filter(None, [
            f"文件：{record['title']}",
            f"类型：{record['ext']}" if record["ext"] else "",
            f"空间：{record['space']}" if record["space"] else "",
            f"阶段：{record['stage_name']}" if record["stage_name"] else "",
            record["content"],
        ]))
    if source_type == "note":
        return "\n".join(filter(None, [record["title"] or "", record["content_plain"] or record["content_md"] or ""]))
    if source_type == "canvas":
        return "\n".join(filter(None, [
            f"画布：{record['canvas_title'] or '未命名画布'}",
            f"节点：{record['node_title'] or '未命名节点'}",
            f"类型：{record['node_type']}",
            f"分组：{record['group_path']}" if record["group_path"] else "",
            f"关系：{record['relation_summary']}" if record["relation_summary"] else "",
            record["content"],
        ]))
    if source_type == "calendar":
        return "\n".join(filter(None, [
            f"活动：{record['title']}", f"日期：{record['date']}",
            f"时间：{record['time'] or '全天'}", record["description"] or "",
        ]))
    if source_type == "scheduled_task":
        return f"定时任务：{record['name']}\n计划：{record['cron']}\n状态：{'启用' if record['enabled'] else '停用'}\n{record['payload']}"
    if source_type == "conversation":
        if record["kind"] == "summary":
            return f"会话摘要：{record['summary']}"
        return f"{record['role']}：{record['content']}"
    raise ValueError(f"不支持的知识索引来源：{source_type}")


def record_metadata(record: dict) -> dict:
    source_type = record["source_type"]
    if source_type == "file":
        return {
            "file_id": record["id"], "mime_type": record["mime_type"],
            "project_id": record["project_id"], "folder_id": record["folder_id"],
            "space": record["space"],
        }
    if source_type == "note":
        return {"node_id": record["id"], "kind": record["kind"]}
    if source_type == "canvas":
        return {
            "canvas_id": record["canvas_id"], "node_id": record["node_id"],
            "node_type": record["node_type"], "group_path": record["group_path"],
            "project_id": record["project_id"], "relation_summary": record["relation_summary"],
        }
    if source_type == "calendar":
        return {"event_id": record["id"], "project_id": record["project_id"]}
    if source_type == "scheduled_task":
        return {"task_id": record["id"], "enabled": record["enabled"]}
    metadata = {
        "session_id": record["session_id"],
        "kind": record["kind"],
        "session_source": record["session_source"],
        "session_updated_at": record["session_updated_at"],
    }
    if record["kind"] == "message":
        metadata["message_id"] = record["id"]
        metadata["role"] = record["role"]
    return metadata


def record_title(record: dict) -> str:
    source_type = record["source_type"]
    if source_type == "note":
        return record["title"] or "便签"
    if source_type == "canvas":
        return f"{record['canvas_title'] or '未命名画布'} · {record['node_title'] or '未命名节点'}"
    if source_type == "scheduled_task":
        return record["name"]
    return record["title"]


def record_documents(owner_user_id, record: dict, scope: Scope) -> list[IndexDocument]:
    """来源记录 → 索引 chunk；与 TS ``build_documents`` 输出逐字段等价（有等价测试锁定）。"""
    text = record_text(record).strip()
    pieces = split_text(text, max_chars=1400)
    if not pieces:
        return []
    document_id = f"{record['source_type']}:{record['id']}"
    version = text_version(text, *record["version_parts"])
    return [IndexDocument(
        document_id=document_id,
        parent_document_id=document_id,
        source_type=record["source_type"],
        source_id=record["id"],
        scope=scope,
        title=record_title(record) or "未命名",
        summary=text[:240],
        content=piece,
        version=version,
        chunk_index=index,
        chunk_count=len(pieces),
        updated_at=record.get("updated_at"),
        metadata=record_metadata(record),
    ) for index, piece in enumerate(pieces)]


async def build_source_records(db, owner_user_id: object, source_type: str) -> list[tuple[dict, Scope]] | None:
    """构建一个来源的统一 source record（各记录携带自己的 Scope）；无 record 管线的来源返回 None。"""
    owner_scope = Scope(owner_user_id=str(owner_user_id), scope_type="owner")
    if source_type == "file":
        rows = (await db.execute(select(File).where(
            File.user_id == owner_user_id, File.deleted_at.is_(None),
        ).order_by(File.updated_at.desc(), File.id.desc()))).scalars().all()
        semaphore = asyncio.Semaphore(FILE_DOCUMENT_LOAD_CONCURRENCY)
        bodies = await asyncio.gather(*(
            _extract_file_text_bounded(row, semaphore) for row in rows
        ))
        return [(file_record(row, body), owner_scope) for row, body in zip(rows, bodies, strict=True)]
    if source_type == "note":
        rows = (await db.execute(select(MindNode).where(
            MindNode.user_id == owner_user_id,
            MindNode.deleted_at.is_(None),
            MindNode.kind.in_(["note", "suggestion"]),
        ).order_by(MindNode.updated_at.desc(), MindNode.id.desc()))).scalars().all()
        return [(note_record(row), owner_scope) for row in rows]
    if source_type == "canvas":
        rows = (await db.execute(
            select(MindCanvasItem, MindMap, MindNode)
            .join(MindMap, MindMap.id == MindCanvasItem.canvas_id)
            .join(MindNode, MindNode.id == MindCanvasItem.node_id)
            .where(
                MindCanvasItem.user_id == owner_user_id,
                MindMap.user_id == owner_user_id,
                MindNode.user_id == owner_user_id,
                MindNode.deleted_at.is_(None),
            )
            .order_by(MindCanvasItem.updated_at.desc(), MindCanvasItem.id.desc())
        )).all()
        relation_rows = (await db.execute(select(MindRelation).where(
            MindRelation.user_id == owner_user_id,
        ))).scalars().all()
        all_owned_nodes = (await db.execute(select(MindNode).where(
            MindNode.user_id == owner_user_id,
            MindNode.deleted_at.is_(None),
        ))).scalars().all()
        node_titles = {node.id: node.title or "未命名节点" for node in all_owned_nodes}
        relation_by_node: dict[int, list[str]] = {}
        for relation in relation_rows:
            left = node_titles.get(relation.src_node_id)
            right = node_titles.get(relation.dst_node_id)
            if left and right:
                relation_by_node.setdefault(relation.src_node_id, []).append(f"{left} → {right}")
                relation_by_node.setdefault(relation.dst_node_id, []).append(f"{left} ← {right}")
        records = []
        for item, canvas, node in rows:
            relation_summary = "；".join(relation_by_node.get(node.id, [])[:8])
            group_path = ""
            try:
                import json
                view = json.loads(item.data_json or "{}")
                group_path = str(view.get("group_path") or view.get("groupPath") or "")
            except (TypeError, ValueError):
                group_path = ""
            records.append((canvas_record(
                item, canvas, node, relation_summary=relation_summary, group_path=group_path,
            ), owner_scope))
        return records
    if source_type == "calendar":
        rows = (await db.execute(select(CalendarEvent).where(
            CalendarEvent.user_id == owner_user_id,
        ).order_by(CalendarEvent.created_at.desc(), CalendarEvent.id.desc()))).scalars().all()
        return [(calendar_record(row), owner_scope) for row in rows]
    if source_type == "scheduled_task":
        rows = (await db.execute(select(ScheduledTask).where(
            ScheduledTask.user_id == owner_user_id,
        ).order_by(ScheduledTask.updated_at.desc(), ScheduledTask.id.desc()))).scalars().all()
        return [(scheduled_task_record(row), owner_scope) for row in rows]
    if source_type == "conversation":
        sessions = (await db.execute(select(ConversationSession).where(
            ConversationSession.user_id == owner_user_id,
        ).order_by(ConversationSession.updated_at.desc(), ConversationSession.id.desc()))).scalars().all()
        messages_by_session: defaultdict[int, list[ConversationMessage]] = defaultdict(list)
        if sessions:
            session_ids = [session.id for session in sessions]
            message_rows = (await db.execute(
                select(ConversationMessage)
                .where(ConversationMessage.session_id.in_(session_ids))
                .order_by(ConversationMessage.session_id.asc(), ConversationMessage.id.asc())
            )).scalars().all()
            for row in message_rows:
                messages_by_session[row.session_id].append(row)
        records = []
        for session in sessions:
            session_scope = _scope(owner_user_id, session)
            if (session.summary or "").strip():
                records.append((conversation_summary_record(session), session_scope))
            for row in messages_by_session.get(session.id, ()):
                if row.id <= (session.baseline_message_id or 0):
                    continue
                if row.role not in {"user", "assistant"} or not (row.content or "").strip():
                    continue
                records.append((conversation_message_record(session, row), session_scope))
        return records
    if source_type in {"memory", "knowledge", "project"}:
        return None
    raise ValueError(f"不支持的知识索引来源：{source_type}")


def documents_from_records(owner_user_id: object, records: list[tuple[dict, Scope]]) -> list[IndexDocument]:
    """record 管线 → 索引 chunk；与 TS ``adapt`` op 输出逐字段等价（有等价测试锁定）。"""
    documents: list[IndexDocument] = []
    for record, scope in records:
        documents.extend(record_documents(owner_user_id, record, scope))
    return documents


async def build_source_documents(db, owner_user_id: object, source_type: str) -> list[IndexDocument]:
    """构建一个来源，查询仅限 owner；不在日志中输出正文。"""
    owner_scope = Scope(owner_user_id=str(owner_user_id), scope_type="owner")
    if source_type == "memory":
        return await MemoryAdapter(owner_user_id).build_documents(scope=owner_scope)
    if source_type == "knowledge":
        return await KnowledgeAdapter(owner_user_id).build_index_documents()
    if source_type == "project":
        return await ProjectAdapter(owner_user_id, db=db).build_documents(scope=owner_scope)
    records = await build_source_records(db, owner_user_id, source_type)
    if records is None:
        raise ValueError(f"不支持的知识索引来源：{source_type}")
    return documents_from_records(owner_user_id, records)


INDEX_SOURCE_TYPES = (
    "memory", "knowledge", "project", "file", "note", "canvas", "calendar", "scheduled_task", "conversation",
)


async def rebuild_knowledge_index(db, owner_user_id: object, source_types=None) -> dict[str, int]:
    """重建 owner 的统一索引，返回各来源 chunk 数量；影子比对开启时记录投影诊断。"""
    selected = tuple(source_types or INDEX_SOURCE_TYPES)
    counts: dict[str, int] = {}
    for source_type in selected:
        records = await build_source_records(db, owner_user_id, source_type)
        if records is None:
            documents = await build_source_documents(db, owner_user_id, source_type)
        else:
            documents = documents_from_records(owner_user_id, records)
        counts[source_type] = await replace_source_documents(db, owner_user_id, source_type, documents)
        if records is not None:
            from agent.rag.write_shadow import shadow_compare_build

            await shadow_compare_build(owner_user_id, source_type, records, documents)
    await db.commit()
    return counts


__all__ = [
    "INDEX_SOURCE_TYPES",
    "build_source_documents",
    "build_source_records",
    "documents_from_records",
    "rebuild_knowledge_index",
]
