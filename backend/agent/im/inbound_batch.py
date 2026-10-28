"""IM 入站防抖批次的分段、权限候选识别与逐段恢复。"""
from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable


def _arrival_key(msg_id: str) -> tuple[int, int]:
    text = str(msg_id or "")
    head, _, tail = text.partition("-")
    try:
        return int(head), int(tail) if tail else 0
    except ValueError:
        return 0, 0


async def _owner_mention_indexes(batch: list[tuple[str, dict]]) -> set[int]:
    """只把当前 Bot 的真实 mention 且身份绑定为 owner 的消息标为独立段。"""
    from agent.im.identity import resolve_owner_account
    from agent.im.permissions import resolve_access

    owner_mentions: set[int] = set()
    access_cache: dict[tuple[str, str], bool] = {}
    identity_cache: dict[str, Any] = {}
    for index, (_msg_id, payload) in enumerate(batch):
        if (payload.get("chat_type") != "group"
                or payload.get("bot_mentioned") is not True
                or payload.get("mentions_other_bot") is True):
            continue
        sender_id = str(payload.get("platform_user_id") or "")
        owner_key = str(payload.get("owner_user_id") or payload.get("user_id") or "")
        if not sender_id or not owner_key:
            continue
        cache_key = (owner_key, sender_id)
        if cache_key not in access_cache:
            try:
                if owner_key not in identity_cache:
                    identity_cache[owner_key] = await resolve_owner_account(payload)
                identity = identity_cache[owner_key]
                if identity is None:
                    access_cache[cache_key] = False
                    continue
                access = await resolve_access(
                    str(payload.get("platform") or ""),
                    "group",
                    str(payload.get("channel_id") or payload.get("bot_id") or ""),
                    identity.user_id,
                    sender_id,
                )
                access_cache[cache_key] = access.role == "owner"
            except Exception as exc:
                from app.core.redaction import diag_log

                diag_log("agent.im.inbound_batch.owner_mention", exc)
                access_cache[cache_key] = False
        if access_cache[cache_key]:
            owner_mentions.add(index)
    return owner_mentions


async def partition_inbound_batch(
    batch: list[tuple[str, dict]],
) -> list[list[tuple[str, dict]]]:
    """相邻普通消息合并；每条已验证 owner @ 消息单独成段。"""
    if not batch:
        return []
    ordered = sorted(batch, key=lambda item: _arrival_key(item[0]))
    owner_mentions = await _owner_mention_indexes(ordered)
    segments: list[list[tuple[str, dict]]] = []
    ordinary: list[tuple[str, dict]] = []
    for index, item in enumerate(ordered):
        if index not in owner_mentions:
            ordinary.append(item)
            continue
        if ordinary:
            segments.append(ordinary)
            ordinary = []
        segments.append([item])
    if ordinary:
        segments.append(ordinary)
    return segments


def resolve_batch_attachment_ids(
    batch_messages: list[dict],
    attachment_meta: dict[str, dict],
    *,
    fallback_platform_message_id: str = "",
) -> None:
    """把媒体入口生成的附件 ID 按来源消息和附件序号归回原批次消息。"""
    by_source: dict[tuple[str, int], str] = {}
    for attach_id, meta in attachment_meta.items():
        platform_message_id = str(meta.get("platform_message_id") or "")
        attachment_index = meta.get("attachment_index")
        if platform_message_id and attachment_index is not None:
            by_source[(platform_message_id, int(attachment_index))] = str(attach_id)

    for message in batch_messages:
        message_platform_id = str(
            message.get("platform_message_id") or fallback_platform_message_id or ""
        )
        resolved: list[str] = []
        for index, attachment in enumerate(message.get("attachments") or []):
            if isinstance(attachment, str):
                resolved.append(attachment)
                continue
            if not isinstance(attachment, dict):
                continue
            attach_id = attachment.get("attach_id")
            if isinstance(attach_id, str) and attach_id:
                resolved.append(attach_id)
                continue
            source_message_id = str(
                attachment.get("source_platform_message_id")
                or attachment.get("batch_platform_message_id")
                or message_platform_id
            )
            source_index = attachment.get(
                "source_attachment_index",
                attachment.get("batch_attachment_index", index),
            )
            if not source_message_id or source_index is None:
                continue
            try:
                source_index = int(source_index)
            except (TypeError, ValueError):
                continue
            resolved_id = by_source.get((source_message_id, source_index))
            if resolved_id:
                resolved.append(resolved_id)
        message["attachments"] = resolved


async def process_inbound_batch(
    batch: list[tuple[str, dict]],
    *,
    merge_payloads: Callable[[list[dict]], dict],
    handle: Callable[[str, dict], Awaitable[Any]],
    run_slot: Callable[[], Any],
    acknowledge: Callable[[str], Awaitable[Any]],
    defer: Callable[..., Awaitable[Any]],
) -> bool:
    """按顺序执行消息段；失败时委托 worker 保留当前段及后续消息。"""
    try:
        segments = await partition_inbound_batch(batch)
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.inbound_batch.partition", exc)
        await defer(batch, release_ids=[mid for mid, _ in batch], retry_delay=60)
        return False

    for segment_index, segment in enumerate(segments):
        segment_ids = [mid for mid, _ in segment]
        merged = merge_payloads([payload for _, payload in segment])
        try:
            from agent.im.inbound_recovery import (
                receipt_key,
                recover_started,
                register_batch,
                release_unconsumed_user_rows,
            )
            from app.core import redis as R

            receipt = await R.get_redis().get(receipt_key(segment_ids[0]))
            recovered = False
            if receipt:
                import app.db.session as db_session

                db_session.ensure_engine()
                recovered = await recover_started(
                    db_session._SessionLocal,
                    receipt.decode() if isinstance(receipt, bytes) else str(receipt),
                )
            if not recovered:
                async with run_slot():
                    merged["_inbound_batch_key"] = await register_batch(
                        R.get_redis(), segment_ids
                    )
                    await handle(segment[-1][0], merged)

            early_ids = merged.get("_early_message_ids") or []
            if early_ids:
                import app.db.session as db_session

                db_session.ensure_engine()
                await release_unconsumed_user_rows(db_session._SessionLocal, early_ids)
            for msg_id in segment_ids:
                await acknowledge(msg_id)
        except asyncio.CancelledError:
            pending = [
                item for later_segment in segments[segment_index:]
                for item in later_segment
            ]
            await defer(
                pending,
                release_ids=[msg_id for msg_id, _ in pending],
                retry_delay=None,
            )
            raise
        except Exception as exc:
            print(
                f"[worker] flush 消息段处理失败，保留待重领: {type(exc).__name__}",
                flush=True,
            )
            pending = [
                item for later_segment in segments[segment_index:]
                for item in later_segment
            ]
            await defer(
                pending,
                release_ids=segment_ids,
                retry_delay=60,
            )
            return False
    return True
