"""Cython RAG sidecar 的共享 wire 与路径约定。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from agent.rag.models import IndexDocument, Scope

SIDECAR_STREAM_LIMIT_BYTES = 32 * 1024 * 1024


class RagSidecarUnavailable(RuntimeError):
    """RAG sidecar 未启动或请求失败。"""

    def __init__(
        self, message: str, *, code: str | None = None,
        diagnostics: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics


def sidecar_socket_path() -> str:
    try:
        from app.core.config import get_settings

        return str(getattr(get_settings().search, "rag_sidecar_socket", "") or "")
    except Exception:
        return ""


def index_dir_for_owner(owner_user_id: object) -> str:
    """返回用户私有的 RAG 派生索引目录。"""
    from app.core.config import get_settings

    settings = get_settings()
    storage = getattr(settings, "storage", None)
    local_path = getattr(storage, "local_path", "") if storage is not None else ""
    if local_path:
        return str(Path(local_path).expanduser() / str(owner_user_id) / ".agent" / "rag" / "unified")
    return str(Path(".agent") / "rag" / "unified")


def scope_to_wire(scope: Scope) -> dict[str, str]:
    return {
        "scope_type": scope.scope_type or "owner",
        "scope_id": scope.scope_id or "",
        "platform": scope.platform or "",
        "bot_id": scope.bot_id or "",
        "group_id": scope.group_id or "",
    }


def wire_document(document: IndexDocument) -> dict[str, Any]:
    text_parts = [document.title]
    content = document.content.strip()
    if document.summary and not content.startswith(document.summary):
        text_parts.append(document.summary)
    text_parts.append(document.content)
    from agent.rag.delta import chunk_slot_key

    wire = {
        "id": chunk_slot_key(document),
        "text": "\n".join(text_parts),
        "source_id": document.source_id,
        "title": document.title,
        "summary": document.summary,
        "content": document.content,
        "source_type": document.source_type,
        "platform": document.scope.platform,
        "bot_id": document.scope.bot_id,
        "group_id": document.scope.group_id,
        "scope_type": document.scope.scope_type,
        "scope_id": document.scope.scope_id or "",
        "document_version": document.version or "",
        "parent_id": document.parent_document_id or "",
        "chunk_index": document.chunk_index,
        "chunk_count": document.chunk_count,
        "updated_at": document.updated_at,
        "metadata": document.metadata,
    }
    if document.source_type == "conversation":
        wire["ranking_text"] = str(document.metadata.get("context_current") or document.content)
        if document.metadata.get("kind") == "message":
            context_text = document.contextual_content()
            if context_text:
                wire["context_text"] = context_text
    return wire


def from_wire_document(raw: dict[str, Any], owner_user_id: str) -> IndexDocument | None:
    try:
        return IndexDocument(
            document_id=str(raw.get("id") or ""),
            source_type=str(raw.get("source_type") or ""),
            source_id=str(raw.get("source_id") or raw.get("id") or ""),
            scope=Scope(
                owner_user_id=owner_user_id,
                platform=str(raw.get("platform") or ""),
                bot_id=str(raw.get("bot_id") or ""),
                group_id=str(raw.get("group_id") or ""),
                scope_type=str(raw.get("scope_type") or "owner"),
                scope_id=str(raw.get("scope_id") or ""),
            ),
            title=str(raw.get("title") or ""),
            summary=str(raw.get("summary") or ""),
            content=str(raw.get("content") or raw.get("text") or ""),
            version=str(raw.get("document_version") or ""),
            chunk_index=int(raw.get("chunk_index") or 0),
            chunk_count=int(raw.get("chunk_count") or 1),
            parent_document_id=str(raw.get("parent_id") or "") or None,
            updated_at=str(raw.get("updated_at") or "") or None,
            metadata=raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {},
        )
    except (TypeError, ValueError):
        return None
