"""附件记录与所有权：draft/attached 两态的 DB 行、claim、引用复用与物理清理。

**元数据以 `chat_attachments` 表为所有权真相来源**（PRD-STORAGE-1 Phase A）——
附件只有 `draft`/`attached` 两态，Redis 完全不参与「这个对象是否有主人」的判断，
只在 DB 查不到时作为 v3 上线前遗留数据的 legacy fallback（会随旧 Redis key
自然过期消失，不专门下线）。

物理删除的唯一入口是 `try_delete_storage_if_unreferenced()`（stage()/stage_sync()
insert 失败时的补偿删除除外）——删除前检查是否还有其他存活行引用同一个
`storage_key`（PRD-IM-9 的引用复用场景会让多条附件行共享一份物理字节）。
"""
from __future__ import annotations

import json

from app.core import redis as redis_module
from app.core.tz import now_utc
from app.services import storage as storage_service

from .constants import DRAFT_TTL, _PREFIX


class AttachmentClaimError(Exception):
    """消息发送时至少一个附件 claim 失败——已被其他请求 claim 走，或已被草稿 GC 清理。"""


_ROW_META_FIELDS = {"attach_id", "name", "ext", "mime", "size", "storage_key",
                    "kind", "duration", "img_width", "img_height", "platform",
                    "platform_message_id", "attachment_index"}


def _extra_from_meta(meta: dict) -> dict | None:
    """meta 里除了 chat_attachments 专门列之外的其余字段（platform/qq_face/quoted 等
    stage() 的 extra= 参数塞进来的展示用字段），塞进 DB 行的 extra JSON 列。"""
    extra = {k: v for k, v in meta.items() if k not in _ROW_META_FIELDS and v is not None}
    return extra or None


def row_to_meta(row) -> dict:
    """把 `ChatAttachment` 行转成跟旧 Redis meta 兼容的字典（下游一大批代码按这个
    dict 形状读字段，不改动它们，只换数据来源）。"""
    meta = {
        "attach_id": row.attach_id, "name": row.name, "ext": row.ext,
        "mime": row.mime or "", "size": row.size, "storage_key": row.storage_key,
        "kind": row.kind, "duration": row.duration,
        "img_width": row.img_width, "img_height": row.img_height,
        "platform": row.platform,
        "platform_message_id": row.platform_message_id,
        "attachment_index": row.attachment_index,
    }
    if row.extra:
        meta.update(row.extra)
    if row.state == "draft":
        # `_ttl`：给 `_fmt_age()`（agent/tools/files）估算"大约存了多久"用，
        # 语义从"Redis 剩余 TTL"改成"按 DRAFT_TTL 倒推的剩余额度"，效果一致。
        elapsed = max(0.0, (now_utc() - row.created_at).total_seconds())
        meta["_ttl"] = max(0, int(DRAFT_TTL - elapsed))
    return meta


async def record_draft(user_id, attach_id: str, storage_key: str, meta: dict) -> None:
    """插入一条 draft 状态的 chat_attachments 行——调用方（stage()）在这一步失败时
    要 best-effort 回滚刚写的 storage 字节，这是"物理删除只能走统一入口"这条规则的
    唯一的例外（此时 DB ownership 从未成功建立过，没有行可查、也没有其他引用需要
    担心，直接删就是安全的）。"""
    from app.models import ChatAttachment
    import app.db.session as db_session
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        db.add(ChatAttachment(
            attach_id=attach_id, user_id=user_id, storage_key=storage_key,
            platform=meta.get("platform"),
            platform_message_id=meta.get("platform_message_id"),
            attachment_index=meta.get("attachment_index"),
            name=meta.get("name") or "", ext=meta.get("ext") or "",
            mime=meta.get("mime") or None, kind=meta.get("kind") or "binary",
            size=meta.get("size") or 0, duration=meta.get("duration"),
            img_width=meta.get("img_width"), img_height=meta.get("img_height"),
            state="draft", extra=_extra_from_meta(meta),
        ))
        await db.commit()


async def record_draft_isolated(user_id, attach_id: str, storage_key: str, meta: dict) -> None:
    """`record_draft` 的独立引擎版本，给 `stage_sync()` 的线程内 `asyncio.run()` 用。

    `stage_sync()` 跑在一次性新开的事件循环里（调用方本来就没有运行中的 loop，
    见该函数文档字符串）——不能复用主进程共享的 async 引擎连接池：asyncpg 连接
    绑定创建它的事件循环，跨循环复用会直接报错。这里现开一个只用一次的独立引擎，
    插入完就 `dispose()`，避免碰共享连接池。IM 语音/图片入库频率不高，这点额外
    建连开销可以接受。"""
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
    from app.core.config import get_settings
    from app.models import ChatAttachment
    engine = create_async_engine(get_settings().db.url, pool_size=1, max_overflow=0)
    try:
        Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with Session() as db:
            db.add(ChatAttachment(
                attach_id=attach_id, user_id=user_id, storage_key=storage_key,
                platform=meta.get("platform"),
                platform_message_id=meta.get("platform_message_id"),
                attachment_index=meta.get("attachment_index"),
                name=meta.get("name") or "", ext=meta.get("ext") or "",
                mime=meta.get("mime") or None, kind=meta.get("kind") or "binary",
                size=meta.get("size") or 0, duration=meta.get("duration"),
                img_width=meta.get("img_width"), img_height=meta.get("img_height"),
                state="draft", extra=_extra_from_meta(meta),
            ))
            await db.commit()
    finally:
        await engine.dispose()


async def try_delete_storage_if_unreferenced(user_id, storage_key: str) -> str:
    """物理删除的唯一入口（`record_draft`/`record_draft_isolated` 的 insert 失败
    回滚除外）。删除前检查是否还有其他存活的 `chat_attachments` 行指着同一个
    `storage_key`（PRD-IM-9 的引用复用场景会让多条附件行共享一份物理字节，
    不做这个检查会误删还在被别的消息使用的字节）。

    返回 `"deleted"`（真的删了物理字节）或 `"skipped"`（还有其他存活引用，跳过）。
    **这个"检查再删除"本身不是原子操作**（PRD-STORAGE-1 FR-STORAGE-1-1 第 4 条
    不变量）——这里只保证检查逻辑本身正确，"检查完之后不会冒出新引用"依赖调用方
    配合（尤其 PRD-IM-9 的复用逻辑要在创建共享引用期间锁住源行）。"""
    from app.models import ChatAttachment
    from sqlalchemy import select
    import app.db.session as db_session
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        await _lock_storage_key(db, user_id, storage_key)
        still_referenced = (await db.execute(
            select(ChatAttachment.id).where(
                ChatAttachment.user_id == user_id,
                ChatAttachment.storage_key == storage_key,
            ).limit(1)
        )).scalar_one_or_none() is not None
        if still_referenced:
            await db.commit()
            return "skipped"
        try:
            await storage_service.get_storage().delete(storage_key)
        except Exception:
            pass
        await db.commit()
        return "deleted"


async def _lock_storage_key(db, user_id, storage_key: str) -> None:
    """复用与物理清理共享一把事务锁；SQLite 测试环境不支持 advisory lock。"""
    bind = db.get_bind()
    if bind.dialect.name != "postgresql":
        return
    from sqlalchemy import text
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"chat-attachment:{user_id}:{storage_key}"},
    )


async def reuse_attachment(
    user_id,
    *,
    platform: str,
    platform_message_id: str,
    attachment_index: int | None = None,
    extra: dict | None = None,
) -> dict | None:
    """为引用消息创建独立附件行，共享源附件的物理 storage_key，不重新下载。"""
    if not user_id or not platform or not platform_message_id:
        return None
    from app.models import ChatAttachment
    from sqlalchemy import select
    import uuid
    import app.db.session as db_session
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        query = select(ChatAttachment).where(
            ChatAttachment.user_id == user_id,
            ChatAttachment.platform == platform,
            ChatAttachment.platform_message_id == platform_message_id,
            ChatAttachment.state.in_(("draft", "attached")),
        ).order_by(ChatAttachment.attachment_index, ChatAttachment.id).with_for_update()
        rows = (await db.execute(query)).scalars().all()
        if attachment_index is not None:
            rows = [row for row in rows if row.attachment_index == attachment_index]
        source = rows[0] if rows else None
        if source is None:
            await db.rollback()
            return None
        await _lock_storage_key(db, user_id, source.storage_key)
        # DB 行可能还在，但物理对象已经被外部清理或存储后端丢失；这种情况
        # 必须按未命中处理，让 IM 入口回退到带 URL 的正常下载流程，不能制造坏引用。
        if not await storage_service.get_storage().exists(source.storage_key):
            await db.rollback()
            return None
        meta = row_to_meta(source)
        attach_id = uuid.uuid4().hex[:16]
        merged_extra = dict(source.extra or {})
        merged_extra.update(extra or {})
        row = ChatAttachment(
            attach_id=attach_id,
            user_id=user_id,
            storage_key=source.storage_key,
            platform=platform,
            platform_message_id=platform_message_id,
            attachment_index=attachment_index,
            name=meta.get("name") or "",
            ext=meta.get("ext") or "",
            mime=meta.get("mime") or None,
            kind=meta.get("kind") or "binary",
            size=meta.get("size") or 0,
            duration=meta.get("duration"),
            img_width=meta.get("img_width"),
            img_height=meta.get("img_height"),
            state="draft",
            extra=merged_extra or None,
        )
        db.add(row)
        await db.commit()
        return row_to_meta(row)


async def claim_attachments(db, user_id, message_id: int, attach_ids: list[str]) -> None:
    """把消息引用的附件从 `draft` 原子转成 `attached`，写 `message_id`。

    必须在调用方已经 `db.flush()` 拿到 `message_id`、且仍处于同一个未提交事务的
    `db` 上调用——任何一次 claim 的 `affected_rows != 1` 都会抛 `AttachmentClaimError`，
    调用方必须让整个事务连同消息一起回滚（PRD-STORAGE-1 不变量 3：不允许"消息存在
    但只有部分附件 claim 成功"的半完整状态）。

    `attach_ids` 只应该传 `resolve_for_message` 已经确认存在的那些 id（即
    `cards` 里出现的 `attach_id`），不要传用户原始输入——不存在/输错的 attach_id
    在 `resolve_for_message` 阶段就已经被忽略、不会出现在 cards 里，不该在这里
    变成 claim 失败去炸掉整条消息。"""
    if not attach_ids:
        return
    from sqlalchemy import update
    from app.models import ChatAttachment
    for aid in dict.fromkeys(str(a) for a in attach_ids if a):
        result = await db.execute(
            update(ChatAttachment)
            .where(
                ChatAttachment.attach_id == aid,
                ChatAttachment.user_id == user_id,
                ChatAttachment.state == "draft",
            )
            .values(state="attached", message_id=message_id, attached_at=now_utc())
        )
        if result.rowcount != 1:
            raise AttachmentClaimError(aid)


async def clear_staged(user_id) -> int:
    """删除该用户所有草稿态暂存附件（字节 + DB 行），返回删除数量；同时尽力清一遍
    v3 上线前遗留、只存在 Redis 里的旧暂存记录（DB 里查不到但 Redis 还有）。"""
    from app.models import ChatAttachment
    from sqlalchemy import select, delete as sa_delete
    import app.db.session as db_session
    db_session.ensure_engine()
    deleted = 0
    async with db_session._SessionLocal() as db:
        rows = (await db.execute(
            select(ChatAttachment).where(
                ChatAttachment.user_id == user_id,
                ChatAttachment.state == "draft",
            )
        )).scalars().all()
        storage_keys = list(dict.fromkeys(r.storage_key for r in rows))
        await db.execute(
            sa_delete(ChatAttachment).where(
                ChatAttachment.user_id == user_id,
                ChatAttachment.state == "draft",
            )
        )
        await db.commit()
    for sk in storage_keys:
        if await try_delete_storage_if_unreferenced(user_id, sk) == "deleted":
            deleted += 1
    # legacy：v3 上线前只存在 Redis 里、DB 查不到的旧暂存记录
    r = redis_module.get_redis()
    prefix = f"{_PREFIX}{user_id}:"
    legacy_keys = []
    async for k in r.scan_iter(match=f"{prefix}*", count=200):
        legacy_keys.append(k if isinstance(k, str) else k.decode())
    storage = storage_service.get_storage()
    for k in legacy_keys:
        try:
            raw = await r.get(k)
            if raw:
                meta = json.loads(raw)
                try:
                    await storage.delete(meta["storage_key"])
                except Exception:
                    pass
            await r.delete(k)
            deleted += 1
        except Exception:
            pass
    return deleted
