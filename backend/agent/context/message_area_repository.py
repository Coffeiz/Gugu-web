"""MessageArea 持久化增量的数据库 adapter。"""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select

from agent.context.canonical_context import digest as canonical_digest


def restore_entries(history):
    """将已完成 baseline/window/hydration 的持久化行恢复为 Canonical entries。"""
    from agent.context.assembly.area import MessageArea
    from agent.context.history import canonical_restore_record

    return MessageArea.from_restored(
        [canonical_restore_record(message) for message in history],
    )


async def _insert_or_get_batch(db, values: dict[str, Any]):
    from app.models import ConversationBatch

    dialect_name = db.get_bind().dialect.name
    if dialect_name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert
    elif dialect_name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert
    else:
        raise RuntimeError(f"canonical batch 不支持数据库方言：{dialect_name}")

    statement = (
        dialect_insert(ConversationBatch)
        .values(**values)
        .on_conflict_do_nothing(
            index_elements=[ConversationBatch.session_id, ConversationBatch.digest]
        )
        .returning(ConversationBatch.id)
    )
    inserted_id = (await db.execute(statement)).scalar_one_or_none()
    if inserted_id is not None:
        row = await db.get(ConversationBatch, inserted_id)
        if row is not None:
            return row, True
    existing = (await db.execute(select(ConversationBatch).where(
        ConversationBatch.session_id == values["session_id"],
        ConversationBatch.digest == values["digest"],
    ))).scalars().first()
    if existing is None:
        raise RuntimeError("canonical batch 插入后无法读取结果")
    return existing, False


def _persistence_groups(delta):
    grouped = {
        batch["batch_id"]: batch
        for batch in getattr(delta, "batches", ())
    }
    standalone = []
    for entry in delta.entries:
        if not entry.batch_id:
            standalone.append(entry)
    groups = [
        (
            min(entry.sequence for entry in batch["entries"]),
            list(batch["entries"]),
            batch.get("digest", ""),
            batch.get("metadata", {}),
        )
        for batch in grouped.values()
    ]
    groups.extend((entry.sequence, [entry], "", {"kind": entry.source.value}) for entry in standalone)
    return sorted(groups, key=lambda item: item[0])


async def commit_delta(
    db,
    *,
    session_id: int,
    delta,
    run_id: str | None,
    default_round_id: str | None,
    user_message,
    interrupted: bool,
) -> dict[str, Any]:
    """按 Area 顺序原子提交 delta；相同 run 的重复 finalize 由 batch digest 去重。"""
    from app.core import chat_attach
    from app.models import ConversationMessage

    entries = tuple(delta.entries)
    if not entries:
        return {"entry_count": 0, "batch_count": 0, "digest": delta.digest}
    user_sequence = delta.user_anchor_sequence if user_message is not None else None
    inserted_messages = 0
    batch_count = 0
    for first_sequence, group_entries, original_digest, original_metadata in _persistence_groups(delta):
        canonical_messages = [entry.canonical_message for entry in group_entries]
        metadata = {
            **original_metadata,
            "source": group_entries[0].source.value,
            "sequence_start": first_sequence,
            "sequence_end": max(entry.sequence for entry in group_entries),
            "outcome": "interruption" if interrupted else "success",
        }
        identity = {
            "messages": canonical_messages,
            "metadata": metadata,
            "run_id": run_id or "",
        }
        batch_digest = canonical_digest(identity)
        round_id = next((entry.round_id for entry in group_entries if entry.round_id), None)
        row, is_new = await _insert_or_get_batch(db, {
            "session_id": session_id,
            "version": "v1",
            "run_id": run_id,
            "round_id": round_id or default_round_id,
            "digest": batch_digest,
        })
        batch_count += 1
        if not is_new:
            continue
        for entry, message in zip(group_entries, canonical_messages):
            values = {
                "session_id": session_id,
                "role": str(message.get("role") or "user"),
                "content": message.get("content") if isinstance(message.get("content"), str) else "",
                "canonical_batch_id": row.id,
                "run_id": run_id,
                "round_id": entry.round_id or default_round_id,
            }
            if not isinstance(message.get("content"), str):
                values["content_json"] = chat_attach.strip_image_for_history(message.get("content"))
            if user_message is not None and user_sequence is not None:
                if entry.sequence < user_sequence:
                    values["created_at"] = user_message.created_at - timedelta(
                        microseconds=user_sequence - entry.sequence,
                    )
                elif interrupted and entry.sequence > user_sequence:
                    values["created_at"] = user_message.created_at + timedelta(
                        microseconds=entry.sequence - user_sequence,
                    )
            db.add(ConversationMessage(**values))
            inserted_messages += 1
    return {
        "entry_count": len(entries),
        "inserted_message_count": inserted_messages,
        "batch_count": batch_count,
        "digest": delta.digest,
    }
