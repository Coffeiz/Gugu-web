"""RAG 写路径影子比对：TS worker ``adapt`` 投影与 Python record 管线投影的 chunk 级对账。

同一批 source record 分别走 TS 适配器（``adapt_records``）与 Python
``record_documents``→``_wire_document``，在 wire 域逐字段比对；只记录脱敏诊断
（chunk 数量、首个差异位置、差异字段名），永不抛出、永不改写写路径产物。这是
PRD-RAG-7 Phase 4 写路径移交第②步；比对基线稳定后才允许规划第③步生产切换。
"""
from __future__ import annotations

import logging
import time

from agent.rag.models import IndexDocument, Scope

logger = logging.getLogger("agent.rag.write_shadow")


def scope_to_wire(scope: Scope) -> dict:
    """Scope → TS 适配器消费的 wire scope（空值统一为空串，与现网口径一致）。"""
    return {
        "scope_type": scope.scope_type or "owner",
        "scope_id": scope.scope_id or "",
        "platform": scope.platform or "",
        "bot_id": scope.bot_id or "",
        "group_id": scope.group_id or "",
    }


def _normalize(wire_documents: list[dict]) -> list[dict]:
    """剔除 None 值键，对齐 JSON 往返后 TS 侧省略 undefined 字段的键集。"""
    return [{key: value for key, value in document.items() if value is not None}
            for document in wire_documents]


def _written_wire_documents(documents: list[IndexDocument]) -> list[dict]:
    """写库产物 → wire 域期望值：影子比对的对象就是真实落库的 chunk。"""
    from agent.rag.ts_sidecar import _wire_document

    return _normalize([_wire_document(document) for document in documents])


def _diff_fields(left: dict, right: dict) -> list[str]:
    keys = set(left) | set(right)
    return sorted(key for key in keys if left.get(key) != right.get(key))


async def shadow_compare_build(
    owner_user_id: object,
    source_type: str,
    records: list[tuple[dict, Scope]] | None,
    documents: list[IndexDocument],
    *,
    settings=None,
) -> dict | None:
    """影子比对一次来源构建；返回脱敏诊断，关闭/无 record 管线时返回 None。

    任何异常都收敛进诊断并记日志，绝不向写路径抛出——影子失败只代表观测缺失，
    不代表索引错误。
    """
    if records is None:
        return None
    from app.core.config import get_settings

    settings = settings or get_settings()
    if not settings.search.rag_write_shadow:
        return None

    diagnostic: dict[str, object] = {"source": source_type}
    started = time.monotonic()
    try:
        from agent.rag.index_cache import index_dir_for_owner
        from agent.rag.ts_sidecar import get_lexical_client

        client = await get_lexical_client(
            owner_user_id,
            command=settings.search.ts_sidecar_command,
            index_dir=index_dir_for_owner(owner_user_id),
        )
        payload = [{**record, "scope": scope_to_wire(scope)} for record, scope in records]
        ts_documents = _normalize(await client.adapt_records(source_type, payload))
        expected = _written_wire_documents(documents)
        diagnostic["python_chunks"] = len(expected)
        diagnostic["ts_chunks"] = len(ts_documents)
        if len(expected) != len(ts_documents):
            diagnostic["equal"] = False
            diagnostic["first_diff_index"] = min(len(expected), len(ts_documents))
        else:
            first_diff_index = next(
                (index for index, (left, right) in enumerate(zip(expected, ts_documents))
                 if left != right),
                None,
            )
            diagnostic["equal"] = first_diff_index is None
            if first_diff_index is not None:
                first_left = expected[first_diff_index]
                first_right = ts_documents[first_diff_index]
                diagnostic["first_diff_index"] = first_diff_index
                # 只记 chunk 标识与长度等结构信息，不记正文。
                diagnostic["first_diff_chunk"] = first_left.get("id") or first_right.get("id")
                diagnostic["diff_fields"] = _diff_fields(first_left, first_right)
                diagnostic["left_len"] = len(first_left.get("content") or "")
                diagnostic["right_len"] = len(first_right.get("content") or "")
    except Exception as exc:  # 影子观测绝不影响写路径
        diagnostic["equal"] = None
        diagnostic["error"] = type(exc).__name__
    diagnostic["elapsed_ms"] = int((time.monotonic() - started) * 1000)

    if diagnostic.get("equal") is True:
        logger.info(
            "RAG 写路径影子比对一致 source=%(source)s chunks=%(python_chunks)s elapsed_ms=%(elapsed_ms)s",
            diagnostic,
        )
    elif diagnostic.get("equal") is False:
        logger.warning(
            "RAG 写路径影子比对不一致 source=%(source)s python_chunks=%(python_chunks)s "
            "ts_chunks=%(ts_chunks)s first_diff_index=%(first_diff_index)s "
            "chunk=%(first_diff_chunk)s diff_fields=%(diff_fields)s "
            "left_len=%(left_len)s right_len=%(right_len)s elapsed_ms=%(elapsed_ms)s",
            diagnostic,
        )
    else:
        logger.warning(
            "RAG 写路径影子比对失败 source=%(source)s error=%(error)s elapsed_ms=%(elapsed_ms)s",
            diagnostic,
        )
    return diagnostic


__all__ = ["shadow_compare_build", "scope_to_wire"]
