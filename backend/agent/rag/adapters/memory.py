"""Memory 单来源 adapter：只读取当前 owner 的记忆 namespace。"""
from __future__ import annotations

from agent.memory import store
from agent.rag.chunking import split_sections, split_text, text_version
from agent.rag.models import IndexDocument, Scope
from agent.memory.scopes import MemoryScope, split_member_scope_id
from agent.memory.scope_lifecycle import preview_scope


class MemoryAdapter:
    source_type = "memory"

    def __init__(self, user_id: object):
        self.user_id = user_id

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
