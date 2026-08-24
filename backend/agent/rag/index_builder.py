"""把业务主数据投影为统一知识索引 chunk。"""
from __future__ import annotations

from sqlalchemy import select

from agent.rag.adapters.memory import MemoryAdapter
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
    ScheduledTask,
)


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


def _documents(
    *,
    owner_user_id: object,
    source_type: str,
    source_id: str,
    title: str,
    text: str,
    scope: Scope,
    version_parts: tuple[object, ...],
    updated_at: str | None = None,
    metadata: dict | None = None,
    max_chars: int = 1400,
) -> list[IndexDocument]:
    text = (text or "").strip()
    pieces = split_text(text, max_chars=max_chars)
    if not pieces:
        return []
    document_id = f"{source_type}:{source_id}"
    version = text_version(text, *version_parts)
    return [IndexDocument(
        document_id=document_id,
        parent_document_id=document_id,
        source_type=source_type,
        source_id=source_id,
        scope=scope,
        title=title or "未命名",
        summary=text[:240],
        content=piece,
        version=version,
        chunk_index=index,
        chunk_count=len(pieces),
        updated_at=updated_at,
        metadata=metadata or {},
    ) for index, piece in enumerate(pieces)]


async def build_source_documents(db, owner_user_id: object, source_type: str) -> list[IndexDocument]:
    """构建一个来源，查询仅限 owner；不在日志中输出正文。"""
    owner_scope = Scope(owner_user_id=str(owner_user_id), scope_type="owner")
    if source_type == "memory":
        return await MemoryAdapter(owner_user_id).build_documents(scope=owner_scope)
    if source_type == "project":
        return await ProjectAdapter(owner_user_id, db=db).build_documents(scope=owner_scope)
    if source_type == "file":
        rows = (await db.execute(select(File).where(
            File.user_id == owner_user_id, File.deleted_at.is_(None),
        ).order_by(File.updated_at.desc(), File.id.desc()))).scalars().all()
        documents = []
        for row in rows:
            text = "\n".join(filter(None, [
                f"文件：{row.display_name}",
                f"类型：{row.ext}" if row.ext else "",
                f"空间：{row.space}" if row.space else "",
                f"阶段：{row.stage_name}" if row.stage_name else "",
            ]))
            documents.extend(_documents(
                owner_user_id=owner_user_id, source_type="file", source_id=str(row.id),
                title=row.display_name, text=text, scope=owner_scope,
                version_parts=(row.id, row.version, row.updated_at),
                updated_at=row.updated_at.isoformat() if row.updated_at else None,
                metadata={"file_id": str(row.id), "mime_type": row.mime_type or ""},
            ))
        return documents
    if source_type == "note":
        rows = (await db.execute(select(MindNode).where(
            MindNode.user_id == owner_user_id,
            MindNode.deleted_at.is_(None),
            MindNode.kind.in_(["note", "suggestion"]),
        ).order_by(MindNode.updated_at.desc(), MindNode.id.desc()))).scalars().all()
        documents = []
        for row in rows:
            text = "\n".join(filter(None, [row.title or "", row.content_plain or row.content_md or ""]))
            documents.extend(_documents(
                owner_user_id=owner_user_id, source_type="note", source_id=str(row.id),
                title=row.title or "便签", text=text, scope=owner_scope,
                version_parts=(row.id, row.version, row.indexed_hash or ""),
                updated_at=row.updated_at.isoformat() if row.updated_at else None,
                metadata={"node_id": str(row.id), "kind": row.kind},
            ))
        return documents
    if source_type == "canvas":
        rows = (await db.execute(
            select(MindCanvasItem, MindMap, MindNode)
            .join(MindMap, MindMap.id == MindCanvasItem.canvas_id)
            .join(MindNode, MindNode.id == MindCanvasItem.node_id)
            .where(
                MindCanvasItem.user_id == owner_user_id,
                MindNode.deleted_at.is_(None),
            )
            .order_by(MindCanvasItem.updated_at.desc(), MindCanvasItem.id.desc())
        )).all()
        documents = []
        for item, canvas, node in rows:
            text = "\n".join(filter(None, [
                f"画布：{canvas.title or '未命名画布'}",
                f"节点：{node.title or '未命名节点'}",
                node.content_plain or node.content_md or "",
            ]))
            documents.extend(_documents(
                owner_user_id=owner_user_id, source_type="canvas", source_id=str(item.id),
                title=f"{canvas.title or '未命名画布'} · {node.title or '未命名节点'}",
                text=text, scope=owner_scope,
                version_parts=(item.id, item.updated_at, node.version),
                updated_at=item.updated_at.isoformat() if item.updated_at else None,
                metadata={"canvas_id": str(canvas.id), "node_id": str(node.id)},
            ))
        return documents
    if source_type == "calendar":
        rows = (await db.execute(select(CalendarEvent).where(
            CalendarEvent.user_id == owner_user_id,
        ).order_by(CalendarEvent.created_at.desc(), CalendarEvent.id.desc()))).scalars().all()
        documents = []
        for row in rows:
            text = "\n".join(filter(None, [
                f"活动：{row.title}", f"日期：{row.date}",
                f"时间：{row.time or '全天'}", row.description or "",
            ]))
            documents.extend(_documents(
                owner_user_id=owner_user_id, source_type="calendar", source_id=str(row.id),
                title=row.title, text=text, scope=owner_scope,
                version_parts=(row.id, row.version, row.date, row.description or ""),
                metadata={"event_id": str(row.id), "project_id": str(row.project_id or "")},
            ))
        return documents
    if source_type == "scheduled_task":
        rows = (await db.execute(select(ScheduledTask).where(
            ScheduledTask.user_id == owner_user_id,
        ).order_by(ScheduledTask.updated_at.desc(), ScheduledTask.id.desc()))).scalars().all()
        documents = []
        for row in rows:
            payload = row.payload or ""
            text = f"定时任务：{row.name}\n计划：{row.cron}\n状态：{'启用' if row.enabled else '停用'}\n{payload}"
            documents.extend(_documents(
                owner_user_id=owner_user_id, source_type="scheduled_task", source_id=str(row.id),
                title=row.name, text=text, scope=owner_scope,
                version_parts=(row.id, row.updated_at, row.cron, payload),
                metadata={"task_id": str(row.id), "enabled": row.enabled},
            ))
        return documents
    if source_type == "conversation":
        sessions = (await db.execute(select(ConversationSession).where(
            ConversationSession.user_id == owner_user_id,
        ).order_by(ConversationSession.updated_at.desc(), ConversationSession.id.desc()))).scalars().all()
        documents = []
        for session in sessions:
            messages = (await db.execute(select(ConversationMessage).where(
                ConversationMessage.session_id == session.id,
                ConversationMessage.id > (session.baseline_message_id or 0),
            ).order_by(ConversationMessage.id.asc()))).scalars().all()
            session_scope = _scope(owner_user_id, session)
            for row in messages:
                if not (row.content or "").strip():
                    continue
                text = f"{row.role}：{row.content}"
                documents.extend(_documents(
                    owner_user_id=owner_user_id, source_type="conversation",
                    source_id=str(row.id), title=session.title, text=text,
                    scope=session_scope, version_parts=(row.id, row.created_at, row.content),
                    updated_at=(row.sent_at or row.created_at).isoformat(),
                    metadata={"session_id": str(session.id), "role": row.role},
                ))
        return documents
    raise ValueError(f"不支持的知识索引来源：{source_type}")


INDEX_SOURCE_TYPES = (
    "memory", "project", "file", "note", "canvas", "calendar", "scheduled_task", "conversation",
)


async def rebuild_knowledge_index(db, owner_user_id: object, source_types=None) -> dict[str, int]:
    """重建 owner 的统一索引，返回各来源 chunk 数量。"""
    selected = tuple(source_types or INDEX_SOURCE_TYPES)
    counts: dict[str, int] = {}
    for source_type in selected:
        documents = await build_source_documents(db, owner_user_id, source_type)
        counts[source_type] = await replace_source_documents(db, owner_user_id, source_type, documents)
    await db.commit()
    return counts


__all__ = ["INDEX_SOURCE_TYPES", "build_source_documents", "rebuild_knowledge_index"]
