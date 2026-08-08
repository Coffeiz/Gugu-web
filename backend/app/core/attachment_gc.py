"""聊天附件所有权清理（PRD-STORAGE-1 Phase A）：草稿孤儿定时清理 + 低频安全网扫描。

两段独立组织的清理逻辑（PRD §2 FR-STORAGE-1-1 的组织约束：不同生命周期策略不塞进
同一个按前缀分支的扫描函数），共享底层 `chat_attach.try_delete_storage_if_unreferenced()`
这一个物理删除入口和 `agent/memory` 同款的 Redis 分布式锁模式。

- `sweep_draft_attachments()`：DB 驱动（`chat_attachments WHERE state='draft'`），
  不是"扫 storage 再反查 DB"。GC 用条件删除（`affected_rows` 判断成败）先赢得
  DB 所有权，赢了才碰物理字节——跟并发的消息 claim 天然互斥，不需要额外加锁
  （谁先改变这一行的 state，谁赢，另一方的操作是 no-op）。
- `sweep_orphans_and_report_integrity()`：低频（建议每天一次）全量一致性扫描，
  DB 与 storage 交叉检查，两种不一致分开处理——`DB 有记录 + storage 缺失` 是
  integrity violation（告警，不自动删 DB 记录，这种情况意味着真实数据丢失，
  自动"顺手清理"等于把事故悄悄掩盖掉）；`DB 无记录 + storage 存在（非最近写入）`
  才是孤儿候选，允许清理。
"""
from __future__ import annotations

from app.core import redis as R
from app.core import scheduler
from app.core.tz import now_utc

_DRAFT_LOCK_KEY = "storage:attachment_draft_gc:lock"
_SAFETY_NET_LOCK_KEY = "storage:attachment_safety_net:lock"
_LOCK_TIMEOUT = 1800

# 安全网孤儿候选的"非最近写入"安全窗口——避免把 storage.put() 成功、
# chat_attachments 那次 INSERT 还没提交完的正常写入路径误判成孤儿（那个真实窗口
# 只有毫秒级，这里留足够大的余量）。
_SAFETY_NET_ORPHAN_MIN_AGE = 90 * 24 * 3600   # 90 天，见 PRD-STORAGE-1 §4


def _user_id_from_storage_key(storage_key: str):
    """`{user_id}/{subdir}/{attach_id}.{ext}` 里的 user_id 段，解析成 `uuid.UUID`
    （`chat_attachments.user_id` 是 UUID 类型列，传字符串会被类型处理器拒绝）。
    解析不出/不是合法 UUID 就返回 None，调用方据此跳过。"""
    import uuid as _uuid
    parts = storage_key.split("/", 1)
    if len(parts) != 2 or not parts[0]:
        return None
    try:
        return _uuid.UUID(parts[0])
    except ValueError:
        return None


def _is_chat_attachment_key(storage_key: str) -> bool:
    return "/.chat_staging/" in storage_key or "/.voice/" in storage_key


async def _sweep_draft_locked() -> int:
    from app.core import chat_attach
    from app.models import ChatAttachment
    from sqlalchemy import select, delete as sa_delete
    import app.db.session as db_session
    db_session.ensure_engine()

    cutoff = now_utc().timestamp() - chat_attach.DRAFT_TTL
    from datetime import datetime, timezone
    cutoff_dt = datetime.fromtimestamp(cutoff, tz=timezone.utc)

    deleted = 0
    async with db_session._SessionLocal() as db:
        expired = (await db.execute(
            select(ChatAttachment).where(
                ChatAttachment.state == "draft",
                ChatAttachment.created_at < cutoff_dt,
            )
        )).scalars().all()
        rows = [(r.id, r.user_id, r.storage_key) for r in expired]

    for row_id, user_id, storage_key in rows:
        async with db_session._SessionLocal() as db:
            result = await db.execute(
                sa_delete(ChatAttachment).where(
                    ChatAttachment.id == row_id,
                    ChatAttachment.state == "draft",
                )
            )
            await db.commit()
        if result.rowcount != 1:
            continue   # 输给了并发 claim（这行已经不是 draft 了），不是 GC 的了
        if await chat_attach.try_delete_storage_if_unreferenced(user_id, storage_key) == "deleted":
            deleted += 1
    return deleted


async def sweep_draft_attachments() -> int:
    """草稿孤儿定时清理入口。返回真正删除的附件数。"""
    lock = R.get_redis().lock(_DRAFT_LOCK_KEY, timeout=_LOCK_TIMEOUT, blocking=False)
    if not await lock.acquire(blocking=False):
        return 0
    try:
        return await _sweep_draft_locked()
    finally:
        try:
            await lock.release()
        except Exception:
            pass


async def _sweep_safety_net_locked() -> dict:
    from app.core import chat_attach
    from app.models import ChatAttachment
    from app.services.storage import get_storage
    from sqlalchemy import select
    import app.db.session as db_session
    db_session.ensure_engine()

    storage = get_storage()
    now_ts = now_utc().timestamp()

    integrity_violations: list[str] = []
    orphans_deleted = 0

    # ① DB 有记录 + storage 缺失 → integrity violation（只告警，不动 DB）
    async with db_session._SessionLocal() as db:
        all_rows = (await db.execute(select(ChatAttachment))).scalars().all()
        db_storage_keys = {r.storage_key for r in all_rows}
        rows_snapshot = [(r.id, r.state, r.storage_key) for r in all_rows]

    for row_id, state, storage_key in rows_snapshot:
        info = await storage.stat(storage_key)
        if info is None:
            integrity_violations.append(storage_key)

    if integrity_violations:
        from app.core.redaction import diag_log_raw, redact
        msg = redact(f"chat_attachments 有 {len(integrity_violations)} 条记录对应的物理对象缺失")
        diag_log_raw("app.core.attachment_gc.integrity_violation", msg)
        try:
            await _write_system_log(msg)
        except Exception:
            pass

    # ② DB 无记录 + storage 存在（非最近写入）→ 孤儿候选，允许清理
    all_keys = await storage.list_keys()
    for key in all_keys:
        if not _is_chat_attachment_key(key):
            continue
        if key in db_storage_keys:
            continue
        info = await storage.stat(key)
        if info is None or info.mtime is None:
            continue   # 拿不到 mtime，保守不删
        if now_ts - info.mtime <= _SAFETY_NET_ORPHAN_MIN_AGE:
            continue   # 太新，可能是正常写入过程中的正常状态，留给下一轮
        user_id = _user_id_from_storage_key(key)
        if not user_id:
            continue
        if await chat_attach.try_delete_storage_if_unreferenced(user_id, key) == "deleted":
            orphans_deleted += 1

    return {"integrity_violations": len(integrity_violations), "orphans_deleted": orphans_deleted}


async def _write_system_log(message: str) -> None:
    """安全网发现 integrity violation 时补一条后台可见的 SystemLog，运维不用登服务器
    也能发现——写入前已经过 `redact()`（调用方保证），这里只负责落库。"""
    from app.models import SystemLog
    import app.db.session as db_session
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        db.add(SystemLog(level="ERROR", module="app.core.attachment_gc", message=message))
        await db.commit()


async def sweep_orphans_and_report_integrity() -> dict:
    """安全网入口：低频全量一致性扫描。返回 {"integrity_violations": n, "orphans_deleted": n}。"""
    lock = R.get_redis().lock(_SAFETY_NET_LOCK_KEY, timeout=_LOCK_TIMEOUT, blocking=False)
    if not await lock.acquire(blocking=False):
        return {"integrity_violations": 0, "orphans_deleted": 0}
    try:
        return await _sweep_safety_net_locked()
    finally:
        try:
            await lock.release()
        except Exception:
            pass


@scheduler.register(scheduler.cron(hour=4, minute=0), id="attachment_draft_gc", name="草稿附件孤儿清理")
async def _run_draft_gc() -> None:
    """凌晨低峰跑，避开白天的存储/DB I/O 高峰。"""
    try:
        n = await sweep_draft_attachments()
        if n:
            print(f"[attachment_draft_gc] 清理了 {n} 个过期草稿附件", flush=True)
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("app.core.attachment_gc.draft_sweep", exc)


@scheduler.register(scheduler.cron(hour=4, minute=30), id="attachment_safety_net", name="附件所有权安全网扫描")
async def _run_safety_net() -> None:
    """跟草稿 GC 错开半小时，避免同时段抢 DB/存储 I/O。"""
    try:
        result = await sweep_orphans_and_report_integrity()
        if result["integrity_violations"] or result["orphans_deleted"]:
            print(f"[attachment_safety_net] integrity_violations={result['integrity_violations']} "
                  f"orphans_deleted={result['orphans_deleted']}", flush=True)
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("app.core.attachment_gc.safety_net", exc)
