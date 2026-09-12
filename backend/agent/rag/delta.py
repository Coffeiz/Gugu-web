"""通用 chunk 差异工具与稳定键契约（PRD-RAG-9 Phase 0 冻结）。

契约（所有来源共用，不得各自实现一份）：
    parent_key = source_type + ":" + parent_document_id（无 parent 时为 document_id）
    chunk_slot = parent_key + ":" + chunk_index        # 即 TS worker 文档键
    document_digest = chunk_slot + 词法索引字段的规范化 hash

差异规则（§6.2）：
    current = {chunk_slot: document}
    previous = {chunk_slot: document}
    upserts = current 中新增，或 digest 相对 previous 变化的项
    deletes = previous 中不再出现在 current 的项

文档版本（``version``）不参与 digest：版本变化单独不构成重新投影的理由，
与 TS worker 的稳定槽位契约逐字对齐。差异结果按键排序，同一输入必然产出
同一结果；正文不进入任何日志。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from agent.rag.models import IndexDocument
from agent.rag.protocol import RAG_PROJECTION_VERSION, TOKENIZER_VERSION


def parent_document_key(document: IndexDocument) -> str:
    """稳定父文档键：``source_type:parent_document_id``。"""
    parent = document.parent_document_id or document.document_id
    return f"{document.source_type}:{parent}"


def chunk_slot_key(document: IndexDocument) -> str:
    """稳定 chunk 槽位：``parent_key:chunk_index``，即 TS worker 文档键。"""
    return f"{parent_document_key(document)}:{document.chunk_index}"


def document_digest(document: IndexDocument) -> str:
    """词法索引字段及召回展示上下文的规范化 hash；不含 document.version。

    纳入 scope 与 chunk_count（§3.2：scope 与必要元数据变化必须触发重新投影）；
    旧实现（ts_sidecar._index_document_digest）漏掉这两项，会让移动/拆分后的
    存活 chunk 残留旧 scope 或旧 chunk 计数。
    """
    context = document.contextual_content() if document.source_type == "conversation" else ""
    scope = document.scope
    payload = "\x1f".join((
        chunk_slot_key(document),
        document.source_type,
        document.title,
        document.summary,
        document.content,
        context,
        str(document.chunk_count),
        scope.scope_type or "", scope.scope_id or "",
        scope.platform or "", scope.bot_id or "", scope.group_id or "",
        "conversation-ranking-v1" if document.source_type == "conversation" else "",
    ))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ChunkDelta:
    """一次 chunk 级差异；upserts/deletes 均按 chunk 槽位排序保证确定性。"""

    upserts: tuple[IndexDocument, ...]
    deletes: tuple[str, ...]
    unchanged: tuple[str, ...]

    @property
    def is_empty(self) -> bool:
        return not self.upserts and not self.deletes


def compute_chunk_delta(
    previous: list[IndexDocument] | tuple[IndexDocument, ...],
    current: list[IndexDocument] | tuple[IndexDocument, ...],
) -> ChunkDelta:
    """对同一来源（或同一父文档）的前后文档集合计算 chunk 级差异。

    输入顺序无关；相同输入必然得到相同输出（按键排序）。比较依据是
    ``document_digest``（含正文、标题、摘要、scope 等词法索引字段），
    ``version`` 变化单独不触发 upsert。
    """
    previous_by_key = {chunk_slot_key(document): document for document in previous}
    current_by_key = {chunk_slot_key(document): document for document in current}

    upserts = [
        document for key, document in sorted(current_by_key.items())
        if key not in previous_by_key
        or document_digest(previous_by_key[key]) != document_digest(document)
    ]
    deletes = sorted(key for key in previous_by_key if key not in current_by_key)
    unchanged = sorted(
        key for key, document in current_by_key.items()
        if key in previous_by_key
        and document_digest(previous_by_key[key]) == document_digest(document)
    )
    return ChunkDelta(
        upserts=tuple(upserts),
        deletes=tuple(deletes),
        unchanged=tuple(unchanged),
    )


def projection_revision_stamp() -> str:
    """投影契约版本前缀，进入索引 revision（§3.2 revision 契约的一部分）。"""
    return f"{TOKENIZER_VERSION}:{RAG_PROJECTION_VERSION}"


__all__ = [
    "ChunkDelta",
    "chunk_slot_key",
    "compute_chunk_delta",
    "document_digest",
    "parent_document_key",
    "projection_revision_stamp",
]
