"""Python 侧 TS RAG source projection 等价实现（迁移期，不接生产写入路径）。"""
from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from typing import Any

from agent.rag.models import IndexDocument, Scope

MAX_CHARS = 1000
OVERLAP_CHARS = 150
RAG_WORKER_VERSION = "0.6.1"


def adapt_source_records(owner_user_id: object, source_type: str, records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """复刻 TS ``adapt`` operation 的结果和错误边界。

    ``project_source_records_from_wire`` 是严格内部 primitive；协议层则保留 TS
    的特殊语义：文件明确拒绝，未知来源作为空批次成功，不会泄漏成 Python 异常。
    """
    if source_type == "file":
        return {"status": "error", "code": "unsupported_source", "message": "文件不属于 RAG 来源"}
    projected_documents: list[tuple[IndexDocument, Mapping[str, Any]]] = []
    if source_type not in {
        "memory", "project", "knowledge", "note", "canvas", "calendar",
        "scheduled_task", "conversation",
    }:
        documents = []
    else:
        documents = []
        # Keep the optional-vs-empty distinction from each wire record's scope. The
        # IndexDocument model normalizes both to empty strings, while TS JSON omits
        # fields that the source adapter never supplied.
        for record in records:
            raw_scope = record.get("scope") if isinstance(record.get("scope"), Mapping) else {}
            projected_documents.extend(
                (document, raw_scope)
                for document in project_source_records_from_wire(owner_user_id, source_type, [record])
            )

    from agent.rag.cython_backend import _worker_document_wire
    from agent.rag.delta import chunk_slot_key

    wire_documents = []
    for document, raw_scope in projected_documents:
        wire = _worker_document_wire(document, chunk_slot_key(document))
        if not document.metadata:
            wire.pop("metadata", None)
        if document.updated_at is None:
            wire.pop("updated_at", None)
        if not document.version:
            wire.pop("document_version", None)
        # Empty scope strings are meaningful only when explicitly present in the
        # wire input; otherwise TS serialization omits the undefined property.
        for field in ("platform", "bot_id", "group_id"):
            if field not in raw_scope:
                wire.pop(field, None)
        wire_documents.append(wire)
    return {
        "status": "ok", "version": RAG_WORKER_VERSION,
        "documents": wire_documents, "document_count": len(wire_documents),
    }


def project_source_records(
    owner_user_id: object,
    source_type: str,
    records: Sequence[tuple[Mapping[str, Any], Scope]],
) -> list[IndexDocument]:
    """把与 TS ``buildSourceDocuments`` 相同的 source records 投影为 chunks。

    调用方必须先完成数据库/StorageReader 归属和 scope 授权。该函数只接受
    已授权的 record+Scope，不读取数据、不查询权限，也不修改生产索引。
    """
    if source_type not in {
        "memory", "project", "knowledge", "note", "canvas", "calendar",
        "scheduled_task", "conversation",
    }:
        raise ValueError(f"不支持的 RAG source projection：{source_type}")

    owner = str(owner_user_id)
    output: list[IndexDocument] = []
    for record, scope in records:
        if str(scope.owner_user_id) != owner or not _valid_scope(scope):
            continue
        projected = _project_record(source_type, record, scope)
        if projected is None:
            continue
        projected_source_type = projected.pop("source_type", source_type)
        output.extend(_build_documents(owner, source_type=projected_source_type, **projected))
    return output


def project_source_records_from_wire(
    owner_user_id: object,
    source_type: str,
    records: Sequence[Mapping[str, Any]],
) -> list[IndexDocument]:
    """实现 TS ``adapt`` 的输入边界：wire scope 绑定 owner 后再做 canonical 投影。"""
    owner = str(owner_user_id)
    scoped_records: list[tuple[Mapping[str, Any], Scope]] = []
    for record in records:
        raw_scope = record.get("scope")
        if not isinstance(raw_scope, Mapping):
            continue
        scope = Scope(
            owner_user_id=owner,
            platform=str(raw_scope.get("platform") or ""),
            bot_id=str(raw_scope.get("bot_id") or ""),
            group_id=str(raw_scope.get("group_id") or ""),
            scope_type=str(raw_scope.get("scope_type") or ""),
            scope_id=str(raw_scope.get("scope_id") or ""),
        )
        scoped_records.append((record, scope))
    return project_source_records(owner, source_type, scoped_records)


def project_source_batch(
    owner_user_id: object,
    batch: Mapping[str, Sequence[Mapping[str, Any]]],
) -> list[IndexDocument]:
    """与 TS ``buildSourceDocuments`` 相同顺序处理 batch，供 build/index 组合复用。"""
    output: list[IndexDocument] = []
    for batch_key, source_type in (
        ("memory", "memory"),
        ("project", "project"),
        ("note", "note"),
        ("canvas", "canvas"),
        ("calendar", "calendar"),
        ("scheduled_task", "scheduled_task"),
        ("conversations", "conversation"),
        ("knowledge", "knowledge"),
    ):
        records = batch.get(batch_key) or ()
        output.extend(project_source_records_from_wire(owner_user_id, source_type, records))
    return output


def _project_record(source_type: str, record: Mapping[str, Any], scope: Scope) -> dict[str, Any] | None:
    if source_type in {"memory", "project", "knowledge"}:
        if record.get("id") is None or not record.get("source_type") or not record.get("title"):
            return None
        content = str(record.get("content") or "")
        return {
            "source_type": record["source_type"],
            "id": record["id"],
            "source_id": record.get("source_id") if record.get("source_id") is not None else record["id"],
            "parent_id": record.get("parent_id"), "title": record.get("title"),
            "summary": record.get("summary"), "content": content,
            "version": _document_version(record, content),
            "updated_at": record.get("updated_at"),
            "metadata": record.get("metadata") or {}, "scope": scope,
        }

    if source_type == "note":
        if record.get("id") is None:
            return None
        raw_title = str(record.get("title") or "")
        content = "\n".join(part for part in (
            raw_title, str(record.get("content_plain") or record.get("content_md") or ""),
        ) if part)
        return {
            "id": record["id"], "title": raw_title or "便签", "content": content,
            "version": _document_version(record, content), "updated_at": record.get("updated_at"),
            "metadata": {
                "node_id": str(record["id"]),
                **({"kind": record["kind"]} if "kind" in record else {}),
            },
            "scope": scope,
        }

    if source_type == "canvas":
        if any(record.get(key) is None for key in ("id", "canvas_id", "node_id")):
            return None
        canvas_title = str(record.get("canvas_title") or "未命名画布")
        node_title = str(record.get("node_title") or "未命名节点")
        node_type = _js_template_value(record, "node_type")
        group_path = str(record.get("group_path") or "")
        relation_summary = str(record.get("relation_summary") or "")
        content = "\n".join(part for part in (
            f"画布：{canvas_title}", f"节点：{node_title}", f"类型：{node_type}",
            f"分组：{group_path}" if group_path else "",
            f"关系：{relation_summary}" if relation_summary else "",
            str(record.get("content") or ""),
        ) if part)
        return {
            "id": record["id"], "title": f"{canvas_title} · {node_title}", "content": content,
            "version": _document_version(record, content), "updated_at": record.get("updated_at"),
            "metadata": {
                "canvas_id": str(record["canvas_id"]), "node_id": str(record["node_id"]),
                **({"node_type": record["node_type"]} if "node_type" in record else {}),
                "group_path": group_path,
                "project_id": "" if record.get("project_id") is None else str(record["project_id"]),
                "relation_summary": relation_summary,
            },
            "scope": scope,
        }

    if source_type == "calendar":
        if record.get("id") is None:
            return None
        title, date = _js_template_value(record, "title"), _js_template_value(record, "date")
        content = "\n".join(part for part in (
            f"活动：{title}", f"日期：{date}", f"时间：{record.get('time') or '全天'}",
            str(record.get("description") or ""),
        ) if part)
        return {
            "id": record["id"], "title": title, "content": content,
            "version": _document_version(record, content),
            "metadata": {
                "event_id": str(record["id"]),
                "project_id": "" if record.get("project_id") is None else str(record["project_id"]),
            },
            "scope": scope,
        }

    if source_type == "scheduled_task":
        if record.get("id") is None:
            return None
        enabled = bool(record.get("enabled"))
        content = (
            f"定时任务：{_js_template_value(record, 'name')}\n计划：{_js_template_value(record, 'cron')}\n"
            f"状态：{'启用' if enabled else '停用'}\n{record.get('payload') or ''}"
        )
        return {
            "id": record["id"], "title": record.get("name"), "content": content,
            "version": _document_version(record, content),
            "metadata": {
                "task_id": str(record["id"]),
                **({"enabled": record["enabled"]} if "enabled" in record else {}),
            }, "scope": scope,
        }

    if source_type == "conversation":
        if record.get("id") is None or record.get("kind") not in {"summary", "message"}:
            return None
        kind = str(record["kind"])
        body = str(record.get("summary") or "") if kind == "summary" else str(record.get("content") or "")
        if not body.strip() or (kind == "message" and not record.get("role")):
            return None
        role = str(record.get("role") or "")
        current = f"会话摘要：{body}" if kind == "summary" else f"{role}：{body}"
        metadata: dict[str, Any] = {
            "session_id": _js_template_value(record, "session_id"), "kind": kind,
            "session_source": record.get("session_source") or "",
            "session_updated_at": record.get("session_updated_at") or "",
        }
        if kind == "message":
            metadata.update({
                "message_id": str(record["id"]), "role": role,
                "context_before": record.get("context_before") or "",
                "context_after": record.get("context_after") or "",
                "context_current": current,
            })
        return {
            "id": record["id"], "source_id": record.get("id"),
            "title": record.get("title") or "未命名", "content": current,
            "summary": "" if kind == "message" else None,
            "version": _document_version(record, current),
            "updated_at": record.get("updated_at"), "metadata": metadata, "scope": scope,
        }

    return None


def _build_documents(
    owner: str,
    *,
    source_type: str,
    id: object,
    title: object,
    content: str,
    scope: Scope,
    version: str = "",
    source_id: object | None = None,
    parent_id: object | None = None,
    summary: object | None = None,
    updated_at: object | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> list[IndexDocument]:
    normalized = str(content or "").strip()
    chunks = _chunk_text(normalized)
    if not chunks:
        return []
    source_id = str(id if source_id is None else source_id)
    parent = str(parent_id if parent_id is not None else f"{source_type}:{id}")
    document_title = str(title or "未命名")
    document_summary = str(summary if summary is not None else normalized[:240])
    document_metadata = dict(metadata or {})
    document_updated_at = None if updated_at is None else str(updated_at)
    return [
        IndexDocument(
            document_id=parent,
            source_type=source_type,
            source_id=source_id,
            scope=Scope(
                owner_user_id=owner, platform=scope.platform, bot_id=scope.bot_id,
                group_id=scope.group_id, scope_type=scope.scope_type or "owner",
                scope_id=scope.scope_id or "",
            ),
            title=document_title,
            summary=document_summary,
            content=chunk,
            version=version,
            chunk_index=index,
            chunk_count=len(chunks),
            parent_document_id=parent,
            updated_at=document_updated_at,
            metadata=document_metadata,
        )
        for index, chunk in enumerate(chunks)
    ]


def _chunk_text(text: str) -> list[str]:
    """按 worker adapters/base.ts 的段落、句界与码点预算切块。"""
    normalized = str(text or "").strip()
    if not normalized:
        return []
    output: list[str] = []
    step = max(1, MAX_CHARS - OVERLAP_CHARS)
    buffer: list[str] = []
    for raw_paragraph in re.split(r"\n\s*\n", normalized):
        paragraph = raw_paragraph.strip()
        if not paragraph:
            continue
        pieces = [part.strip() for part in re.split(r"(?<=[。！？!?；;\n])", paragraph) if part.strip()]
        for piece in pieces:
            chars = list(piece)
            if len(chars) > MAX_CHARS:
                if buffer:
                    output.append("".join(buffer).strip())
                    buffer = []
                for start in range(0, len(chars), step):
                    chunk = "".join(chars[start:start + MAX_CHARS]).strip()
                    if chunk:
                        output.append(chunk)
                continue

            candidate = [*buffer, "\n", *chars] if buffer else chars
            if buffer and len(candidate) > MAX_CHARS:
                output.append("".join(buffer).strip())
                tail = "".join(buffer[-OVERLAP_CHARS:]).strip()
                buffer = [*list(tail), "\n", *chars] if tail else chars
            else:
                buffer = candidate
    if buffer:
        output.append("".join(buffer).strip())
    output = [chunk for chunk in output if chunk]
    return output


def _document_version(record: Mapping[str, Any], normalized_content: str) -> str:
    parts = record.get("version_parts")
    if parts is None:
        return str(record.get("document_version") or "")
    normalized = str(normalized_content or "").strip()
    payload = "\x1f".join([*(str(part if part is not None else "") for part in parts), normalized])
    # Node crypto 的 UTF-8 编码会把未配对代理项替换成 U+FFFD；与 chunkText
    # 的 JS UTF-16 行为一致，不能让这类合法解码字符串在 Python 侧直接报错。
    node_text = payload.encode("utf-16-le", errors="surrogatepass").decode(
        "utf-16-le", errors="replace",
    )
    return hashlib.sha256(node_text.encode("utf-8")).hexdigest()[:16]


def _js_template_value(record: Mapping[str, Any], key: str) -> str:
    """复刻 TS 模板字符串对缺失字段和 JSON null 的可观察表示。"""
    if key not in record:
        return "undefined"
    value = record[key]
    return "null" if value is None else str(value)


def _valid_scope(scope: Scope) -> bool:
    return bool(scope.scope_type) and (scope.scope_type != "group" or bool(scope.scope_id))


__all__ = [
    "MAX_CHARS", "OVERLAP_CHARS", "RAG_WORKER_VERSION", "adapt_source_records", "project_source_batch",
    "project_source_records", "project_source_records_from_wire",
]
