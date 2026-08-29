"""RAG Memory 文档的向量缓存适配。

Memory 的直接注入缓存和 RAG 索引使用不同的分块契约，不能共用裸 chunk hash。
RAG 缓存使用带来源前缀的最终 chunk 内容 hash，避免覆盖旧的 memory.md 缓存，
并让不同 scope 的相同正文安全复用向量。
"""
from __future__ import annotations

from collections.abc import Iterable

from agent.rag.models import IndexDocument


RAG_VECTOR_PREFIX = "rag:"


def cache_key(document: IndexDocument) -> str | None:
    """返回按最终 chunk 正文生成的稳定 key，跨 scope 也不会发生内容错配。"""
    if not document.content.strip() or document.source_id == "pattern":
        return None
    return f"{RAG_VECTOR_PREFIX}{document.source_id}:{document.content_hash}"


async def sync_memory_index_vectors(
    user_id: object,
    documents: Iterable[IndexDocument],
    *,
    force: bool = False,
    strict: bool = False,
    prune: bool = True,
) -> int:
    """按 RAG 文档契约增量生成 profile/daily/memory 向量。

    pattern 继续使用 ``pattern_vec.json``，这里仅维护 RAG 的非 pattern 文档。
    旧的 memory.md 裸 key 保留给直接记忆注入，不参与 RAG key GC。
    """
    from agent.memory import embedding, store

    if not embedding.is_enabled():
        return 0
    try:
        docs = [document for document in documents if document.source_id != "pattern"]
        vecs = await store.read_memory_vecs(user_id)
        tag = embedding.model_tag()
        alive = {key for document in docs if (key := cache_key(document))}
        if prune:
            vecs = {
                key: value for key, value in vecs.items()
                if not key.startswith(RAG_VECTOR_PREFIX) or key in alive
            }
        changed = False
        written = 0
        seen: set[str] = set()
        for document in docs:
            key = cache_key(document)
            if not key or key in seen:
                continue
            seen.add(key)
            current = vecs.get(key)
            if not force and current and current.get("t") == tag:
                continue
            vector = await embedding.embed(document.content)
            if vector:
                vecs[key] = {"v": vector, "t": tag}
                changed = True
                written += 1
            elif strict:
                raise RuntimeError("RAG 文档向量生成失败")
        if changed:
            await store.write_memory_vecs(user_id, vecs)
        return written
    except Exception:
        if strict:
            raise
        return 0


async def sync_knowledge_index_vectors(
    user_id: object,
    documents: Iterable[IndexDocument],
    *,
    force: bool = False,
    strict: bool = False,
) -> int:
    """同步 Knowledge 文档向量，复用 Memory 的 owner 缓存和 TTL。"""
    return await sync_memory_index_vectors(
        user_id, documents, force=force, strict=strict, prune=False,
    )


__all__ = [
    "RAG_VECTOR_PREFIX", "cache_key", "sync_knowledge_index_vectors",
    "sync_memory_index_vectors",
]
