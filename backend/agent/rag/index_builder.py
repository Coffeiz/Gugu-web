"""把业务主数据投影为统一知识索引 chunk。"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

from sqlalchemy import select

from app.core.chat_attach import TEXT_EXTS
from app.services.storage import get_storage
from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.adapters.knowledge import KnowledgeAdapter
from agent.rag.adapters.projects import ProjectAdapter
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
    Project,
    ScheduledTask,
)


FILE_TEXT_MAX_BYTES = 1 * 1024 * 1024
FILE_DOCUMENT_LOAD_CONCURRENCY = 8
CONVERSATION_CONTEXT_MAX_CHARS = 600


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


def _conversation_context_line(row) -> str:
    content = str(row.content or "").strip()
    if row.role not in {"user", "assistant"} or not content:
        return ""
    return f"{row.role}：{content[:CONVERSATION_CONTEXT_MAX_CHARS]}"


def conversation_message_record(
    session, row, *, context_before: str = "", context_after: str = "",
) -> dict:
    return {
        "source_type": "conversation", "kind": "message", "id": str(row.id),
        "session_id": str(session.id),
        "title": session.title or "", "role": row.role, "content": row.content or "",
        "session_source": session.source or "",
        "session_updated_at": session.updated_at.isoformat() if session.updated_at else "",
        "context_before": context_before,
        "context_after": context_after,
        "version_parts": _version_parts(
            row.id, row.created_at, row.content, context_before, context_after,
        ),
        "updated_at": (row.sent_at or row.created_at).isoformat() if (row.sent_at or row.created_at) else None,
    }


async def build_single_source_record(
    db, owner_user_id: object, source_type: str, source_id: str,
) -> tuple[dict, Scope] | None:
    """单对象读取：只加载一个 file/project 的 canonical record（PRD-RAG-9 文档级增量）。

    主数据不存在/已删除/不可索引时返回 None（调用方按删除收敛）。knowledge
    走 KnowledgeAdapter.build_source_record_for（文件库存储，不需要 db）。
    """
    owner_scope = Scope(owner_user_id=str(owner_user_id), scope_type="owner")
    if source_type == "file":
        row = (await db.execute(select(File).where(
            File.user_id == owner_user_id,
            File.id == int(source_id),
            File.deleted_at.is_(None),
        ))).scalar_one_or_none()
        if row is None:
            return None
        semaphore = asyncio.Semaphore(1)
        return file_record(row, await _extract_file_text_bounded(row, semaphore)), owner_scope
    if source_type == "project":
        row = (await db.execute(select(Project).where(
            Project.user_id == owner_user_id,
            Project.id == int(source_id),
            Project.deleted_at.is_(None),
        ))).scalar_one_or_none()
        if row is None:
            return None
        from agent.rag.adapters.projects import _iso
        text = ProjectAdapter._project_text(row)
        if not text.strip():
            return None
        document_id = f"project:{row.id}"
        return ({
            "source_type": "project", "id": str(row.id),
            "source_id": str(row.id), "parent_id": document_id,
            "title": row.name or "未命名项目", "summary": text[:240],
            "content": text, "version_parts": [row.id, row.version or 1],
            "updated_at": _iso(row.updated_at),
            "metadata": {"project_id": str(row.id), "status": row.status or "pending"},
        }, owner_scope)
    raise ValueError(f"来源不支持单对象读取：{source_type}")


async def build_source_records(db, owner_user_id: object, source_type: str) -> list[tuple[dict, Scope]] | None:
    """构建一个来源的统一 source record（各记录携带自己的 Scope）；无 record 管线的来源返回 None。"""
    owner_scope = Scope(owner_user_id=str(owner_user_id), scope_type="owner")
    if source_type == "memory":
        return await MemoryAdapter(owner_user_id).build_source_records(scope=owner_scope)
    if source_type == "knowledge":
        return await KnowledgeAdapter(owner_user_id).build_source_records()
    if source_type == "project":
        return await ProjectAdapter(owner_user_id, db=db).build_source_records(scope=owner_scope)
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
            CalendarEvent.deleted_at.is_(None),
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
            eligible_messages = [
                row for row in messages_by_session.get(session.id, ())
                if row.id > (session.baseline_message_id or 0)
                and row.role in {"user", "assistant"}
                and (row.content or "").strip()
            ]
            for index, row in enumerate(eligible_messages):
                before = _conversation_context_line(eligible_messages[index - 1]) if index else ""
                after = _conversation_context_line(eligible_messages[index + 1]) if index + 1 < len(eligible_messages) else ""
                records.append((conversation_message_record(
                    session, row, context_before=before, context_after=after,
                ), session_scope))
        return records
    raise ValueError(f"不支持的知识索引来源：{source_type}")


async def records_to_write_documents(
    owner_user_id: object,
    source_type: str,
    records: list[tuple[dict, Scope]],
    *,
    settings=None,
) -> list[IndexDocument]:
    """把授权 source record 经 TS canonical projection 转为持久化文档。"""
    from app.core.config import get_settings

    settings = settings or get_settings()
    import time

    from agent.rag.index_cache import index_dir_for_owner
    from agent.rag.ts_sidecar import get_lexical_client, scope_to_wire, wire_document_to_persistent

    started = time.monotonic()
    client = await get_lexical_client(
        owner_user_id,
        command=settings.search.ts_sidecar_command,
        index_dir=index_dir_for_owner(owner_user_id),
    )
    payload = [{**record, "scope": scope_to_wire(scope)} for record, scope in records]
    wire_documents = await client.adapt_records(source_type, payload)
    documents = [wire_document_to_persistent(raw, owner_user_id) for raw in wire_documents]
    logging.getLogger("agent.rag.index_builder").info(
        "RAG 写库投影 engine=ts source=%s records=%s chunks=%s elapsed_ms=%s",
        source_type, len(records), len(documents), int((time.monotonic() - started) * 1000),
    )
    return documents


async def build_source_documents(db, owner_user_id: object, source_type: str) -> list[IndexDocument]:
    """兼容旧调用方：读取 canonical source record 后统一交给 TS 投影。"""
    records = await build_source_records(db, owner_user_id, source_type)
    if records is None:
        raise RuntimeError(f"来源未提供 canonical source record：{source_type}")
    return await records_to_write_documents(owner_user_id, source_type, records)


INDEX_SOURCE_TYPES = (
    "memory", "knowledge", "project", "file", "note", "canvas", "calendar", "scheduled_task", "conversation",
)


async def rebuild_knowledge_index(db, owner_user_id: object, source_types=None) -> dict[str, int]:
    """重建 owner 的统一索引，返回各来源 chunk 数量。"""
    selected = tuple(source_types or INDEX_SOURCE_TYPES)
    counts: dict[str, int] = {}
    for source_type in selected:
        records = await build_source_records(db, owner_user_id, source_type)
        if records is None:
            raise RuntimeError(f"来源未提供 canonical source record：{source_type}")
        documents = await records_to_write_documents(owner_user_id, source_type, records)
        counts[source_type] = await replace_source_documents(db, owner_user_id, source_type, documents)
    await db.commit()
    return counts


__all__ = [
    "INDEX_SOURCE_TYPES",
    "build_source_documents",
    "build_source_records",
    "records_to_write_documents",
    "rebuild_knowledge_index",
]
