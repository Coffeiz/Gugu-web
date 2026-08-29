"""Memory 单来源 adapter：只读取当前 owner 的记忆 namespace。"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from agent.memory import store
from agent.rag.chunking import split_sections, split_text, text_version
from agent.rag.models import IndexDocument, Scope
from agent.memory.scopes import MemoryScope, split_member_scope_id
from agent.memory.scope_lifecycle import preview_scope


SCOPE_DOCUMENT_CACHE_TTL_SECONDS = 30 * 60


@dataclass
class _ScopeDocumentCacheEntry:
    documents: list[IndexDocument]
    revision: str
    last_access: float


@dataclass
class _DailyDocumentCacheEntry:
    documents: list[IndexDocument]
    baseline_revision: str
    last_access: float


@dataclass
class _OwnerDocumentCacheEntry:
    documents: list[IndexDocument]
    baseline_revision: str
    last_access: float


class MemoryAdapter:
    source_type = "memory"
    _scope_cache: dict[str, _ScopeDocumentCacheEntry] = {}
    _scope_locks: dict[str, asyncio.Lock] = {}
    _daily_cache: dict[str, _DailyDocumentCacheEntry] = {}
    _daily_locks: dict[str, asyncio.Lock] = {}
    _owner_cache: dict[str, _OwnerDocumentCacheEntry] = {}
    _owner_locks: dict[str, asyncio.Lock] = {}

    def __init__(self, user_id: object):
        self.user_id = user_id

    @staticmethod
    async def _scope_revision(scope: Scope) -> str:
        """读取 scope_version，避免每条消息都重新构建 scope 文档。"""
        if scope.scope_type not in {"group", "member"}:
            return "owner"
        from sqlalchemy import select
        from app.models import MemoryReflectionCursor
        from agent.memory.scope_lifecycle import _db_session

        try:
            async with await _db_session() as db:
                row = (await db.execute(
                    select(MemoryReflectionCursor.scope_version, MemoryReflectionCursor.updated_at)
                    .where(
                        MemoryReflectionCursor.owner_user_id == scope.owner_user_id,
                        MemoryReflectionCursor.platform == scope.platform,
                        MemoryReflectionCursor.bot_id == scope.bot_id,
                        MemoryReflectionCursor.scope_type == scope.scope_type,
                        MemoryReflectionCursor.scope_id == scope.scope_id,
                    )
                )).first()
        except Exception:
            # revision 读取失败不能阻塞召回；本次使用稳定的不可用版本，下一次重试。
            return "unavailable"
        if row is None:
            return "missing"
        updated = row.updated_at.isoformat() if row.updated_at is not None else ""
        return f"{int(row.scope_version or 0)}:{updated}"

    async def build_cached_documents(self, *, scope: Scope) -> tuple[list[IndexDocument], str]:
        """返回稳定的 scope 文档投影；revision 变化或 TTL 到期才重建。"""
        if scope.scope_type not in {"group", "member"}:
            return await self.build_documents(scope=scope), "owner"
        key = f"{self.user_id}:{scope.key()}"
        revision = await self._scope_revision(scope)
        if revision == "unavailable":
            documents = await self.build_documents(scope=scope)
            return documents, "scope-rebuild:revision-unavailable"
        now = time.monotonic()
        entry = self._scope_cache.get(key)
        if entry is not None and entry.revision == revision and now - entry.last_access <= SCOPE_DOCUMENT_CACHE_TTL_SECONDS:
            entry.last_access = now
            return entry.documents, f"scope-cache:{revision}"
        lock = self._scope_locks.setdefault(key, asyncio.Lock())
        async with lock:
            revision = await self._scope_revision(scope)
            if revision == "unavailable":
                documents = await self.build_documents(scope=scope)
                return documents, "scope-rebuild:revision-unavailable"
            entry = self._scope_cache.get(key)
            now = time.monotonic()
            if entry is not None and entry.revision == revision and now - entry.last_access <= SCOPE_DOCUMENT_CACHE_TTL_SECONDS:
                entry.last_access = now
                return entry.documents, f"scope-cache:{revision}"
            documents = await self.build_documents(scope=scope)
            self._scope_cache[key] = _ScopeDocumentCacheEntry(documents, revision, time.monotonic())
            return documents, f"scope-rebuild:{revision}"

    @classmethod
    def invalidate_scope_cache(cls, owner_user_id: object) -> int:
        prefix = f"{owner_user_id}:"
        keys = [key for key in cls._scope_cache if key.startswith(prefix)]
        for key in keys:
            cls._scope_cache.pop(key, None)
        cls._daily_cache = {
            key: entry for key, entry in cls._daily_cache.items()
            if not key.startswith(f"{owner_user_id}:")
        }
        cls._owner_cache = {
            key: entry for key, entry in cls._owner_cache.items()
            if not key.startswith(f"{owner_user_id}:")
        }
        return len(keys)

    @staticmethod
    def _scope_value_text(value: object) -> str:
        """把 scope 文件的字符串/字典/列表安全转换成可检索文本。"""
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, dict):
            for key in ("text", "content", "summary", "value"):
                candidate = value.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip()
            return ""
        if isinstance(value, list):
            parts = []
            for item in value:
                text = MemoryAdapter._scope_value_text(item)
                if text:
                    parts.append(text)
            return "\n".join(parts)
        return str(value or "").strip()

    async def build_documents(self, *, scope: Scope) -> list[IndexDocument]:
        if scope.owner_user_id != str(self.user_id):
            return []
        if scope.scope_type in {"group", "member"}:
            scope_id = scope.scope_id
            if scope.scope_type == "member":
                group_id, member_id = split_member_scope_id(scope.scope_id)
                if group_id != scope.group_id or not member_id:
                    return []
                # 成员 scope 沿用 IM-3 的 group_id:platform_user_id 绑定，避免把
                # 一个群里的成员事件泄漏到另一个群；profile/pattern/summary/memory
                # 使用同一物理 scope，不能只取裸 member_id。
            memory_scope = MemoryScope(
                self.user_id, scope.platform, scope.bot_id,
                "group" if scope.scope_type == "group" else "platform-user",
                scope_id,
            )
            data = await preview_scope(memory_scope)
            if not isinstance(data, dict):
                return []
            documents: list[IndexDocument] = []
            sources = (
                (("summary", "群组摘要"), ("profile", "群组资料"),
                 ("daily", "群组近期记忆"), ("memory", "群组长期记忆"))
                if scope.scope_type == "group" else
                (("summary", "群友摘要"), ("profile", "群友资料"),
                 ("pattern", "群友行为模式"), ("memory", "群友事件记忆"))
            )
            for source_id, title in sources:
                value = data.get(source_id)
                text = self._scope_value_text(value)
                documents.extend(self._make_chunks(scope, source_id, text, title, 0))
            return documents
        profile = await store.read_profile_list(self.user_id)
        patterns = await store.read_pattern_list(self.user_id)
        daily = await store.read_daily_lines(self.user_id)
        memory = await store.read_memory_doc(self.user_id)
        documents: list[IndexDocument] = []
        for index, item in enumerate(profile):
            documents.extend(self._make_chunks(scope, "profile", str(item.get("text") or ""), "用户画像", index))
        for index, item in enumerate(patterns):
            documents.extend(self._make_chunks(scope, "pattern", str(item.get("text") or ""), "行为模式", index, item.get("id")))
        for index, line in enumerate(daily):
            documents.extend(self._make_chunks(scope, "daily", line, "近期记忆", index))
        for index, (title, section) in enumerate(split_sections(memory)):
            text = f"{title}\n{section}".strip() if title else section
            documents.extend(self._make_chunks(scope, "memory", text, title or "长期记忆", index))
        return documents

    async def build_daily_documents(self, *, scope: Scope) -> list[IndexDocument]:
        """只构建 owner 的 daily 投影，供持久索引竞态时做轻量新鲜度修复。"""
        if scope.owner_user_id != str(self.user_id) or scope.scope_type != "owner":
            return []
        daily = await store.read_daily_lines(self.user_id)
        documents: list[IndexDocument] = []
        for index, line in enumerate(daily):
            documents.extend(self._make_chunks(scope, "daily", line, "近期记忆", index))
        return documents

    async def build_cached_daily_documents(self, *, scope: Scope) -> tuple[list[IndexDocument], str]:
        """在同一 snapshot baseline 内复用 daily 投影，revision 变化时重建。"""
        if scope.owner_user_id != str(self.user_id) or scope.scope_type != "owner":
            return [], "daily-cache:unsupported-scope"
        from agent.rag.context import get_snapshot_revision

        baseline_revision = get_snapshot_revision()
        if not baseline_revision:
            # 显式 search_memory 等脱离 session snapshot 的调用仍需读取最新 daily。
            return await self.build_daily_documents(scope=scope), "daily-refresh:unbound"
        key = f"{self.user_id}:{baseline_revision}"
        now = time.monotonic()
        entry = self._daily_cache.get(key)
        if entry is not None and now - entry.last_access <= SCOPE_DOCUMENT_CACHE_TTL_SECONDS:
            entry.last_access = now
            return entry.documents, f"daily-cache:{entry.baseline_revision}"

        lock = self._daily_locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._daily_cache.get(key)
            now = time.monotonic()
            if entry is not None and now - entry.last_access <= SCOPE_DOCUMENT_CACHE_TTL_SECONDS:
                entry.last_access = now
                return entry.documents, f"daily-cache:{entry.baseline_revision}"
            daily = await store.read_daily_lines(self.user_id)
            documents: list[IndexDocument] = []
            for index, line in enumerate(daily):
                documents.extend(self._make_chunks(scope, "daily", line, "近期记忆", index))
            self._daily_cache[key] = _DailyDocumentCacheEntry(
                documents, baseline_revision, time.monotonic(),
            )
            return documents, f"daily-refresh:{baseline_revision}"

    async def build_cached_owner_documents(self, *, scope: Scope) -> tuple[list[IndexDocument], str]:
        """返回跟随 snapshot baseline 固定的 owner Memory 文档集合。"""
        if scope.owner_user_id != str(self.user_id) or scope.scope_type != "owner":
            return await self.build_documents(scope=scope), "owner-rebuild:unsupported-scope"
        from agent.rag.context import get_snapshot_revision
        from agent.rag.storage import PersistentMemoryIndex

        baseline_revision = get_snapshot_revision()
        if not baseline_revision:
            index = PersistentMemoryIndex(self.user_id)
            documents = await index.load()
            if documents is None:
                documents = await self.build_documents(scope=scope)
                try:
                    await index.replace(documents)
                except Exception:
                    pass
            else:
                fresh_daily = await self.build_daily_documents(scope=scope)
                documents = [document for document in documents if document.source_id != "daily"]
                documents.extend(fresh_daily)
            return documents, "owner-refresh:unbound"

        key = f"{self.user_id}:{baseline_revision}"
        now = time.monotonic()
        entry = self._owner_cache.get(key)
        if entry is not None and now - entry.last_access <= SCOPE_DOCUMENT_CACHE_TTL_SECONDS:
            entry.last_access = now
            return entry.documents, f"owner-cache:{entry.baseline_revision}"

        lock = self._owner_locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._owner_cache.get(key)
            now = time.monotonic()
            if entry is not None and now - entry.last_access <= SCOPE_DOCUMENT_CACHE_TTL_SECONDS:
                entry.last_access = now
                return entry.documents, f"owner-cache:{entry.baseline_revision}"

            index = PersistentMemoryIndex(self.user_id)
            documents = await index.load()
            if documents is None:
                documents = await self.build_documents(scope=scope)
                try:
                    await index.replace(documents)
                except Exception:
                    pass
                source = "owner-rebuild"
            else:
                fresh_daily, daily_source = await self.build_cached_daily_documents(scope=scope)
                documents = [document for document in documents if document.source_id != "daily"]
                documents.extend(fresh_daily)
                source = daily_source
            self._owner_cache[key] = _OwnerDocumentCacheEntry(
                documents, baseline_revision, time.monotonic(),
            )
            return documents, f"owner-refresh:{source}"

    def _make_chunks(
        self, scope: Scope, source_id: str, text: str, title: str, index: int, stable_id: object = None,
    ) -> list[IndexDocument]:
        text = text.strip()
        if not text:
            return []
        source_key = str(stable_id or f"{source_id}:{index}")
        version = text_version(text, source_id, source_key)
        pieces = split_text(text)
        parent = f"memory:{source_id}:{source_key}"
        return [IndexDocument(
            document_id=parent,
            parent_document_id=parent,
            source_type="memory",
            source_id=source_id,
            scope=scope,
            title=title,
            summary=text[:240],
            content=piece,
            version=version,
            chunk_index=position,
            chunk_count=len(pieces),
            metadata={"vector_key": source_key if source_id == "pattern" else store._chunk_key(piece)},
        ) for position, piece in enumerate(pieces)]
