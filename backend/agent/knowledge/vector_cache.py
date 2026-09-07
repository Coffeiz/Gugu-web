"""Knowledge 专属向量缓存。

Knowledge 的向量是 Knowledge 文档的派生数据，和 Memory 的 pattern、daily、memory
向量分开保存，避免重建、GC 或故障恢复互相影响。
"""

from __future__ import annotations

import json
from collections.abc import Iterable

from app.services.storage import get_storage
from agent.rag.models import IndexDocument
from agent.rag.vector_cache import cache_key


KNOWLEDGE_VECTOR_FILE = ".agent/knowledge/vectors.json"
_LEGACY_PREFIX = "rag:knowledge-"


def _key(user_id: object) -> str:
    return f"{user_id}/{KNOWLEDGE_VECTOR_FILE}"


async def read_vectors(user_id: object) -> dict:
    try:
        raw = await get_storage().get(_key(user_id))
        value = json.loads(raw.decode("utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


async def write_vectors(user_id: object, vectors: dict) -> None:
    await get_storage().put(
        _key(user_id),
        json.dumps(vectors, ensure_ascii=False).encode("utf-8"),
        "application/json",
    )


async def _migrate_legacy_vectors(user_id: object, vectors: dict) -> tuple[dict, bool]:
    """把旧 memory_vec.json 中的 Knowledge 条目惰性迁移到专属文件。"""
    from agent.memory import store

    legacy = await store.read_memory_vecs(user_id)
    moved = {key: value for key, value in legacy.items() if key.startswith(_LEGACY_PREFIX)}
    if not moved:
        return vectors, False
    vectors = {**moved, **vectors}
    remaining = {key: value for key, value in legacy.items() if not key.startswith(_LEGACY_PREFIX)}
    await store.write_memory_vecs(user_id, remaining)
    return vectors, True


async def sync_vectors(
    user_id: object,
    documents: Iterable[IndexDocument],
    *,
    force: bool = False,
    strict: bool = False,
) -> int:
    """同步 Knowledge 文档向量，并清理已删除或已失效的 Knowledge key。"""
    from agent.memory import embedding

    if not embedding.is_enabled():
        return 0
    try:
        docs = [document for document in documents if document.source_type == "knowledge"]
        vectors = await read_vectors(user_id)
        vectors, migrated = await _migrate_legacy_vectors(user_id, vectors)
        tag = embedding.model_tag()
        alive = {key for document in docs if (key := cache_key(document))}
        before_prune = len(vectors)
        vectors = {key: value for key, value in vectors.items() if key in alive}
        changed = migrated or len(vectors) != before_prune
        written = 0
        seen: set[str] = set()
        for document in docs:
            key = cache_key(document)
            if not key or key in seen:
                continue
            seen.add(key)
            current = vectors.get(key)
            if not force and current and current.get("t") == tag:
                continue
            vector = await embedding.embed(document.content)
            if vector:
                vectors[key] = {"v": vector, "t": tag}
                changed = True
                written += 1
            elif strict:
                raise RuntimeError("Knowledge 向量生成失败")
        if changed:
            await write_vectors(user_id, vectors)
        return written
    except Exception:
        if strict:
            raise
        return 0


__all__ = ["KNOWLEDGE_VECTOR_FILE", "read_vectors", "write_vectors", "sync_vectors"]
