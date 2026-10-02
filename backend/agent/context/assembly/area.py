"""单次 Run 内的 Canonical 消息区域。"""
from __future__ import annotations

import json
import uuid
import copy
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Iterable

from ..canonical_context import digest as canonical_digest


def _replace_tool_result_block(message: dict, *, tool_call_id: str, result: Any) -> bool:
    content = message.get("content")
    if message.get("role") != "user" or not isinstance(content, list):
        return False
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        result_id = str(block.get("tool_call_id") or block.get("tool_use_id") or "")
        if result_id == tool_call_id:
            block["content"] = json.dumps(result, ensure_ascii=False)
            return True
    return False


class MessageSource(StrEnum):
    RESTORED_HISTORY = "restored_history"
    USER = "user"
    RAG = "rag"
    STANCE = "stance"
    MESSAGE_TIME = "message_time"
    RUNTIME = "runtime"
    REFERENCE = "reference"
    ATTACHMENT = "attachment"
    TOOL_ROUND = "tool_round"
    AGENT_FOLLOWUP = "agent_followup"
    UNKNOWN = "unknown"


class PersistencePolicy(StrEnum):
    ALREADY_PERSISTED = "already_persisted"
    COMMIT_ON_SUCCESS = "commit_on_success"
    COMMIT_ON_INTERRUPTION = "commit_on_interruption"
    REQUEST_ONLY = "request_only"
    RECONSTRUCT_ON_RESTORE = "reconstruct_on_restore"


@dataclass(frozen=True, init=False)
class MessageEntry:
    """不可变 canonical entry；正文以私有 JSON 快照保存，读取时始终返回副本。"""

    entry_id: str
    sequence: int
    source: MessageSource
    persistence_policy: PersistencePolicy
    batch_id: str | None
    round_id: str | None
    persisted_message_id: int | None
    revision: int
    _canonical_json: str = field(repr=False)

    def __init__(
        self,
        entry_id: str,
        sequence: int,
        canonical_message: dict,
        source: MessageSource,
        persistence_policy: PersistencePolicy,
        batch_id: str | None = None,
        round_id: str | None = None,
        persisted_message_id: int | None = None,
        revision: int = 0,
    ) -> None:
        if not isinstance(canonical_message, dict):
            raise TypeError("Canonical message 必须是对象")
        # JSON 往返校验持久化形状，并切断外部可变引用。
        payload = json.dumps(canonical_message, ensure_ascii=False, separators=(",", ":"))
        json.loads(payload)
        object.__setattr__(self, "entry_id", str(entry_id))
        object.__setattr__(self, "sequence", int(sequence))
        object.__setattr__(self, "source", MessageSource(source))
        object.__setattr__(self, "persistence_policy", PersistencePolicy(persistence_policy))
        object.__setattr__(self, "batch_id", str(batch_id) if batch_id else None)
        object.__setattr__(self, "round_id", str(round_id) if round_id else None)
        object.__setattr__(self, "persisted_message_id", persisted_message_id)
        object.__setattr__(self, "revision", int(revision))
        object.__setattr__(self, "_canonical_json", payload)

    @property
    def canonical_message(self) -> dict:
        return json.loads(self._canonical_json)


@dataclass(frozen=True)
class CanonicalAreaSnapshot:
    entries: tuple[MessageEntry, ...]
    revision: int
    digest: str

    @property
    def messages(self) -> tuple[dict, ...]:
        return tuple(entry.canonical_message for entry in self.entries)


@dataclass(frozen=True)
class PersistenceDelta:
    entries: tuple[MessageEntry, ...]
    revision: int
    digest: str
    batches: tuple[dict[str, Any], ...] = ()
    user_anchor_sequence: int | None = None


class MessageArea:
    """有序 canonical ledger；请求前缀、Provider projection 与数据库连接均显式隔离。"""

    def __init__(
        self,
        entries: Iterable[MessageEntry] = (),
        *,
        revision: int = 0,
        request_prefix: Iterable[dict] = (),
        render_options: dict[str, Any] | None = None,
    ) -> None:
        self._entries = list(entries)
        self._revision = int(revision)
        self._next_sequence = max((entry.sequence for entry in self._entries), default=-1) + 1
        self._batch_metadata: dict[str, dict[str, Any]] = {}
        self._batch_digests: dict[str, str] = {}
        self._request_prefix = tuple(copy.deepcopy(tuple(request_prefix)))
        self._dynamic_tail: tuple[dict, ...] = ()
        self.render_options = copy.deepcopy(render_options or {})
        self.canonical_context: Any = None
        self.protected_history_start: int | None = None
        self.provider_cache_anchor: dict[str, str] | None = None
        self._assert_order()

    def remember_provider_cache_anchor(self, anchor: dict[str, str] | None) -> None:
        """暂存 provider 缓存锚点，供 run 收尾写入会话元数据。"""
        self.provider_cache_anchor = copy.deepcopy(anchor) if anchor else None

    @classmethod
    def from_restored(
        cls,
        entries: Iterable[dict | MessageEntry],
        *,
        baseline: Any = None,
        snapshot_revision: int = 0,
    ) -> "MessageArea":
        restored: list[MessageEntry] = []
        for sequence, value in enumerate(entries):
            if isinstance(value, MessageEntry):
                restored.append(value)
                continue
            if not isinstance(value, dict):
                raise TypeError("恢复的 canonical entry 必须是对象")
            restored.append(MessageEntry(
                entry_id=uuid.uuid4().hex,
                sequence=sequence,
                canonical_message=value,
                source=MessageSource.RESTORED_HISTORY,
                persistence_policy=PersistencePolicy.ALREADY_PERSISTED,
                persisted_message_id=value.get("_history_id"),
            ))
        # baseline 元数据归 Repository/restore 流程，不进入内存正文 ledger。
        _ = baseline
        return cls(restored, revision=snapshot_revision)

    @classmethod
    def from_canonical_messages(
        cls,
        messages: Iterable[dict] = (),
        *,
        fixed_prefix_size: int = 0,
        render_options: dict[str, Any] | None = None,
    ) -> "MessageArea":
        """以 canonical 历史与请求前缀构造 Area；主要用于纯内存调用和测试。"""
        values = list(messages)
        prefix_size = max(0, min(int(fixed_prefix_size), len(values)))
        area = cls.from_restored(values[prefix_size:])
        area.configure_request(
            fixed_prefix=values[:prefix_size], render_options=render_options,
        )
        return area

    @property
    def entries(self) -> tuple[MessageEntry, ...]:
        return tuple(self._entries)

    @property
    def revision(self) -> int:
        return self._revision

    def digest(self) -> str:
        return canonical_digest([
            {"sequence": entry.sequence, "message": entry.canonical_message}
            for entry in self._entries
        ])

    def snapshot(self) -> CanonicalAreaSnapshot:
        return CanonicalAreaSnapshot(self.entries, self._revision, self.digest())

    @property
    def fixed_prefix_size(self) -> int:
        return len(self._request_prefix)

    @property
    def request_prefix(self) -> tuple[dict, ...]:
        return copy.deepcopy(self._request_prefix)

    @property
    def dynamic_tail(self) -> list[dict]:
        return copy.deepcopy(list(self._dynamic_tail))

    def configure_request(
        self,
        *,
        fixed_prefix: Iterable[dict],
        render_options: dict[str, Any] | None = None,
    ) -> None:
        """设置本次请求专属固定前缀和纯渲染选项，不写入 canonical history。"""
        self._request_prefix = tuple(copy.deepcopy(tuple(fixed_prefix)))
        self.render_options = copy.deepcopy(render_options or {})

    def set_dynamic_tail(self, messages: Iterable[dict]) -> None:
        """替换仅用于 Provider 请求的动态尾部，不推进 Area revision。"""
        values = tuple(copy.deepcopy(tuple(messages)))
        if any(not isinstance(item, dict) for item in values):
            raise TypeError("Provider dynamic tail 必须由消息对象组成")
        self._dynamic_tail = values

    def insert_request_message(self, index: int, message: dict) -> None:
        """将一次请求专属消息插入固定前缀，不落入 Area 或持久化 delta。"""
        if not isinstance(message, dict):
            raise TypeError("请求消息必须是对象")
        values = list(self._request_prefix)
        values.insert(max(0, min(int(index), len(values))), copy.deepcopy(message))
        self._request_prefix = tuple(values)

    def provider_projection(self):
        """从当前不可变快照生成 ProviderConversation。"""
        from agent.context.history import render_canonical_area_snapshot
        return render_canonical_area_snapshot(
            self.snapshot(), source=self, options=self.render_options,
        )

    def replace_request_baseline(
        self,
        messages: Iterable[dict],
        *,
        expected_revision: int,
    ) -> None:
        """以受控压缩结果替换动态基线，固定前缀和 dynamic tail 不进入 ledger。"""
        from agent.context.history import canonicalize_tool_messages

        values = list(messages)
        conversation = values[self.fixed_prefix_size:]
        canonical = []
        for message in conversation:
            normalized = canonicalize_tool_messages([message])
            canonical.extend(normalized or [message])
        self.replace_baseline(canonical, expected_revision=expected_revision)

    def append(
        self,
        canonical_message: dict,
        *,
        source: MessageSource = MessageSource.UNKNOWN,
        persistence_policy: PersistencePolicy = PersistencePolicy.REQUEST_ONLY,
        batch_id: str | None = None,
        round_id: str | None = None,
        persisted_message_id: int | None = None,
    ) -> MessageEntry:
        self._revision += 1
        entry = MessageEntry(
            entry_id=uuid.uuid4().hex,
            sequence=self._next_sequence,
            canonical_message=canonical_message,
            source=source,
            persistence_policy=persistence_policy,
            batch_id=batch_id,
            round_id=round_id,
            persisted_message_id=persisted_message_id,
            revision=self._revision,
        )
        self._next_sequence += 1
        self._entries.append(entry)
        return entry

    def revise_entry(
        self,
        entry_id: str,
        canonical_message: dict,
        *,
        expected_revision: int,
    ) -> MessageEntry:
        """按 entry 身份受控修订 canonical 内容，并推进 Area 与 entry revision。"""
        if self._revision != expected_revision:
            raise RuntimeError("MessageArea revision 已变化，拒绝覆盖 entry")
        if not isinstance(canonical_message, dict):
            raise TypeError("Canonical message 必须是对象")
        matches = [index for index, entry in enumerate(self._entries) if entry.entry_id == entry_id]
        if len(matches) != 1:
            raise KeyError("MessageArea entry id 无法唯一定位")
        index = matches[0]
        previous = self._entries[index]
        self._revision += 1
        revised = MessageEntry(
            entry_id=previous.entry_id,
            sequence=previous.sequence,
            canonical_message=canonical_message,
            source=previous.source,
            persistence_policy=previous.persistence_policy,
            batch_id=previous.batch_id,
            round_id=previous.round_id,
            persisted_message_id=previous.persisted_message_id,
            revision=self._revision,
        )
        self._entries[index] = revised
        return revised

    def append_batch(
        self,
        batch,
        *,
        source: MessageSource = MessageSource.UNKNOWN,
        persistence_policy: PersistencePolicy = PersistencePolicy.REQUEST_ONLY,
    ) -> tuple[MessageEntry, ...]:
        from .batch import MessageBatch

        if isinstance(batch, MessageBatch):
            batch.seal()
            return self._append_area_entries(
                batch.area_entries,
                metadata=batch.metadata,
                batch_digest=batch.batch_digest,
                default_source=source,
                default_policy=persistence_policy,
            )
        raise TypeError("MessageArea.append_batch 只接受 MessageBatch")

    def _append_area_entries(
        self, area_entries, *, metadata, batch_digest, default_source, default_policy,
    ) -> tuple[MessageEntry, ...]:
        round_id = str(metadata["round_id"]) if metadata.get("round_id") else None
        prepared = []
        for item in area_entries:
            item_source = MessageSource(item.get("source", default_source))
            item_policy = PersistencePolicy(item.get("persistence_policy", default_policy))
            if round_id:
                item_source = MessageSource(item.get("source", MessageSource.TOOL_ROUND))
                item_policy = PersistencePolicy(item.get(
                    "persistence_policy", PersistencePolicy.COMMIT_ON_SUCCESS,
                ))
            prepared.append((
                item["message"], item_source, item_policy,
                bool(item.get("in_batch", False)) or bool(round_id),
                item.get("persisted_message_id"), item.get("round_id") or round_id,
            ))
        if not prepared:
            return ()
        self._revision += 1
        revision = self._revision
        batch_id = uuid.uuid4().hex
        result = []
        batch_messages = []
        for message, item_source, item_policy, in_batch, persisted_id, item_round_id in prepared:
            entry = MessageEntry(
                entry_id=uuid.uuid4().hex,
                sequence=self._next_sequence,
                canonical_message=message,
                source=item_source,
                persistence_policy=item_policy,
                batch_id=batch_id if in_batch else None,
                round_id=item_round_id,
                persisted_message_id=persisted_id,
                revision=revision,
            )
            result.append(entry)
            self._next_sequence += 1
            if in_batch:
                batch_messages.append(message)
        self._entries.extend(result)
        if batch_messages:
            group_metadata = metadata if round_id else {"kind": "runtime-context"}
            self._record_batch(
                batch_id,
                batch_messages,
                group_metadata,
                batch_digest=batch_digest if round_id else "",
            )
        return tuple(result)

    def _record_batch(self, batch_id, messages, metadata, *, batch_digest="") -> None:
        self._batch_metadata[batch_id] = dict(metadata)
        self._batch_digests[batch_id] = batch_digest or canonical_digest({
            "messages": messages, "metadata": metadata,
        })

    def resolve_pending_tool_result(
        self,
        entry_id: str,
        result: Any,
        *,
        tool_call_id: str | None = None,
    ) -> MessageEntry:
        index = next((i for i, entry in enumerate(self._entries) if entry.entry_id == entry_id), None)
        if index is None:
            raise KeyError("Canonical entry 不存在")
        old = self._entries[index]
        message = old.canonical_message
        if not tool_call_id:
            content = message.get("content")
            result_ids = {
                str(block.get("tool_call_id") or block.get("tool_use_id") or "")
                for block in (content if isinstance(content, list) else [])
                if isinstance(block, dict)
                and block.get("type") == "tool_result"
                and (block.get("tool_call_id") or block.get("tool_use_id"))
            }
            if len(result_ids) != 1:
                raise ValueError("entry 必须唯一包含一个待修订的工具结果")
            tool_call_id = next(iter(result_ids))
        if not _replace_tool_result_block(
            message, tool_call_id=tool_call_id, result=result,
        ):
            raise ValueError("指定 entry 中没有匹配的 pending tool result")
        self._revision += 1
        updated = MessageEntry(
            entry_id=old.entry_id,
            sequence=old.sequence,
            canonical_message=message,
            source=old.source,
            persistence_policy=old.persistence_policy,
            batch_id=old.batch_id,
            round_id=old.round_id,
            persisted_message_id=old.persisted_message_id,
            revision=self._revision,
        )
        self._entries[index] = updated
        if old.batch_id:
            self._batch_digests[old.batch_id] = canonical_digest({
                "messages": [
                    entry.canonical_message
                    for entry in self._entries
                    if entry.batch_id == old.batch_id
                ],
                "metadata": self._batch_metadata.get(old.batch_id, {}),
            })
        return updated

    def resolve_tool_result(self, *, tool_call_id: str, result: Any) -> MessageEntry | None:
        for entry in reversed(self._entries):
            message = entry.canonical_message
            content = message.get("content")
            blocks = content if isinstance(content, list) else []
            if any(
                isinstance(block, dict)
                and block.get("type") == "tool_result"
                and str(block.get("tool_call_id") or block.get("tool_use_id") or "") == tool_call_id
                for block in blocks
            ):
                return self.resolve_pending_tool_result(
                    entry.entry_id, result, tool_call_id=tool_call_id,
                )
        return None

    def replace_baseline(
        self,
        replacement: Iterable[dict],
        *,
        expected_revision: int,
    ) -> None:
        if int(expected_revision) != self._revision:
            raise RuntimeError("MessageArea revision 已变化，拒绝覆盖")
        values = list(replacement)
        old_payload = [entry.canonical_message for entry in self._entries]
        if old_payload == values:
            return
        next_revision = self._revision + 1
        available: dict[str, list[MessageEntry]] = {}
        for entry in self._entries:
            available.setdefault(json.dumps(
                entry.canonical_message, ensure_ascii=False, separators=(",", ":"),
            ), []).append(entry)
        replaced = []
        for index, message in enumerate(values):
            key = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
            matches = available.get(key) or []
            old = matches.pop(0) if matches else None
            replaced.append(MessageEntry(
                entry_id=old.entry_id if old else uuid.uuid4().hex,
                sequence=index,
                canonical_message=message,
                source=old.source if old else MessageSource.UNKNOWN,
                persistence_policy=old.persistence_policy if old else PersistencePolicy.REQUEST_ONLY,
                batch_id=old.batch_id if old else None,
                round_id=old.round_id if old else None,
                persisted_message_id=old.persisted_message_id if old else None,
                revision=next_revision,
            ))
        self._entries = replaced
        self._next_sequence = len(replaced)
        self._revision = next_revision
        active_batches = {entry.batch_id for entry in replaced if entry.batch_id}
        self._batch_metadata = {
            key: value for key, value in self._batch_metadata.items() if key in active_batches
        }
        self._batch_digests = {
            key: value for key, value in self._batch_digests.items() if key in active_batches
        }
        for batch_id in active_batches:
            self._batch_digests[batch_id] = canonical_digest({
                "messages": [entry.canonical_message for entry in replaced if entry.batch_id == batch_id],
                "metadata": self._batch_metadata.get(batch_id, {}),
            })

    def batch_records(self) -> tuple[dict, ...]:
        grouped: dict[str, list[MessageEntry]] = {}
        for entry in self._entries:
            if entry.batch_id:
                grouped.setdefault(entry.batch_id, []).append(entry)
        return tuple({
            "messages": [entry.canonical_message for entry in grouped[batch_id]],
            "digest": self._batch_digests.get(batch_id, ""),
            "metadata": dict(self._batch_metadata.get(batch_id, {})),
        } for batch_id in grouped)

    def persistence_delta(self, *, outcome: str) -> PersistenceDelta:
        allowed = {
            "success": {PersistencePolicy.COMMIT_ON_SUCCESS},
            "interruption": {
                PersistencePolicy.COMMIT_ON_SUCCESS,
                PersistencePolicy.COMMIT_ON_INTERRUPTION,
            },
        }.get(str(outcome), set())
        entries = tuple(entry for entry in self._entries if entry.persistence_policy in allowed)
        grouped: dict[str, list[MessageEntry]] = {}
        for entry in entries:
            if entry.batch_id:
                grouped.setdefault(entry.batch_id, []).append(entry)
        batches = tuple({
            "batch_id": batch_id,
            "entries": tuple(grouped[batch_id]),
            "digest": self._batch_digests.get(batch_id, ""),
            "metadata": dict(self._batch_metadata.get(batch_id, {})),
        } for batch_id in grouped)
        user_anchor_sequence = next((
            entry.sequence for entry in reversed(self._entries)
            if entry.persisted_message_id is not None
            and entry.source in {
                MessageSource.USER,
                MessageSource.REFERENCE,
                MessageSource.ATTACHMENT,
            }
        ), None)
        return PersistenceDelta(entries, self._revision, canonical_digest([
            {"sequence": entry.sequence, "message": entry.canonical_message}
            for entry in entries
        ]), batches, user_anchor_sequence)

    def _assert_order(self) -> None:
        sequences = [entry.sequence for entry in self._entries]
        if sequences != sorted(sequences) or len(sequences) != len(set(sequences)):
            raise ValueError("MessageArea sequence 必须严格递增")
