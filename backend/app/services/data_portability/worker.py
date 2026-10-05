"""持久化可移植任务的 worker 执行器。"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import tempfile
import zipfile
from datetime import timedelta

from sqlalchemy import select, text, update

from app.core.redaction import diag_log
from app.core.tz import now_utc
from app.models import DataExportJob, DataImportJob
from app.services.data_portability.archive import build_encrypted_archive
from app.services.data_portability.archive_validation import validate_encrypted_archive
from app.services.data_portability.crypto_stream import EncryptedArchiveReader, EncryptedArchiveWriter
from app.services.data_portability.import_apply import apply_incremental_archive
from app.services.data_portability.identity_map import SQLitePortableIdentityMap
from app.services.data_portability.jobs import ClaimedJob, claim_next_job, renew_lease
from app.services.data_portability.producers import build_record_producers, portable_origin_identity
from app.services.data_portability.schema import PORTABLE_CATEGORIES
from app.services.storage import get_storage
from app.services.data_portability.replace import (
    clear_portable_database, create_rollback_snapshot, replace_memory_files,
    restore_memory_files, rollback_context,
)

_log = logging.getLogger("data_portability.worker")
_EXPORT_TTL = timedelta(hours=24)
_EXPORT_HEARTBEAT_INTERVAL_SECONDS = 2


async def process_export_job(job: ClaimedJob, *, worker_id: str, session_factory) -> None:
    """生成、加密并存放单个用户归档；任何失败都不给用户一个部分归档。"""
    storage = get_storage()
    artifact_key = f"{job.user_id.hex}/.data-portability/exports/{job.job_id.hex}.gupa"
    heartbeat_stop = asyncio.Event()
    cancel_requested = asyncio.Event()
    export_task = asyncio.current_task()

    async def heartbeat():
        while not heartbeat_stop.is_set():
            try:
                await asyncio.wait_for(
                    heartbeat_stop.wait(), timeout=_EXPORT_HEARTBEAT_INTERVAL_SECONDS,
                )
                return
            except TimeoutError:
                async with session_factory() as lease_db:
                    if not await renew_lease(lease_db, "export", job.job_id, worker_id):
                        export_job = (await lease_db.execute(select(DataExportJob).where(
                            DataExportJob.id == job.job_id,
                            DataExportJob.user_id == job.user_id,
                            DataExportJob.lease_owner == worker_id,
                        ))).scalar_one_or_none()
                        if export_job is not None and export_job.status == "canceling":
                            cancel_requested.set()
                            if export_task is not None:
                                export_task.cancel()
                        return

    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        async with session_factory() as db:
            export_job = (await db.execute(select(DataExportJob).where(
                DataExportJob.id == job.job_id, DataExportJob.user_id == job.user_id,
                DataExportJob.status == "running", DataExportJob.lease_owner == worker_id,
            ))).scalar_one_or_none()
            if export_job is None:
                return
            categories = set(export_job.options.get("categories") or ())
            if not categories or not categories.issubset(PORTABLE_CATEGORIES - {"archive_docs"}):
                raise ValueError("导出类别无效")
            complete = categories == PORTABLE_CATEGORIES - {"archive_docs"}
            export_job.stage = "projecting"
            export_job.updated_at = now_utc()
            await db.commit()

            # 所有 SQL 查询处于同一只读一致性视图。身份 ledger 写入仍在本事务内，
            # 归档完成后才提交，构造失败不会留下半成品身份。
            if db.bind is not None and db.bind.dialect.name == "postgresql":
                await db.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            identity_map = SQLitePortableIdentityMap()
            try:
                origin_id, _identities, producers = await build_record_producers(
                    db, user_id=job.user_id, selected_categories=categories,
                    identity_map=identity_map,
                )
                with tempfile.TemporaryFile(mode="w+b") as encrypted:
                    size, digest, _manifest = await build_encrypted_archive(
                        encrypted,
                        context=portable_origin_identity(job.user_id, origin_id, job.job_id),
                        origin_id=origin_id,
                        export_id=job.job_id,
                        producers=producers,
                        complete=complete,
                        included_categories=categories,
                    )
                    # 归档构造成功后先提交身份映射，再在独立事务里推进任务阶段。
                    await db.commit()
                    # db 在 PostgreSQL 上使用 REPEATABLE READ 构造一致快照；租约心跳
                    # 会并发更新同一条任务记录。快照事务不能再写这条记录，否则提交会
                    # 因并发更新触发 SerializationError。状态更新放到新事务中。
                    async with session_factory() as stage_db:
                        await stage_db.execute(update(DataExportJob).where(
                            DataExportJob.id == job.job_id,
                            DataExportJob.user_id == job.user_id,
                            DataExportJob.status == "running",
                            DataExportJob.lease_owner == worker_id,
                        ).values(stage="storing", updated_at=now_utc()))
                        await stage_db.commit()
                    await storage.put_stream(artifact_key, encrypted, size, "application/vnd.gugu.portable+zip")
                    timestamp = now_utc()
                    finalized = await db.execute(update(DataExportJob).where(
                        DataExportJob.id == job.job_id,
                        DataExportJob.user_id == job.user_id,
                        DataExportJob.status == "running",
                        DataExportJob.lease_owner == worker_id,
                    ).values(
                        artifact_key=artifact_key,
                        artifact_size=size,
                        artifact_sha256=digest,
                        status="ready",
                        stage="ready",
                        progress_current=len(categories),
                        progress_total=len(categories),
                        finished_at=timestamp,
                        expires_at=timestamp + _EXPORT_TTL,
                        updated_at=timestamp,
                        lease_owner=None,
                        lease_until=None,
                    ))
                    if finalized.rowcount != 1:
                        await db.rollback()
                        await storage.delete(artifact_key)
                        canceled_at = now_utc()
                        await db.execute(update(DataExportJob).where(
                            DataExportJob.id == job.job_id,
                            DataExportJob.user_id == job.user_id,
                            DataExportJob.status == "canceling",
                            DataExportJob.lease_owner == worker_id,
                        ).values(
                            status="canceled", stage="canceled", error_code=None,
                            artifact_key=None, artifact_size=None, artifact_sha256=None,
                            finished_at=canceled_at, updated_at=canceled_at,
                            lease_owner=None, lease_until=None,
                        ))
                        await db.commit()
                        return
                    await db.commit()
            finally:
                identity_map.close()
    except asyncio.CancelledError:
        if not cancel_requested.is_set():
            raise
        try:
            await storage.delete(artifact_key)
        except Exception as cleanup_exc:
            diag_log("data_portability.export_cleanup", cleanup_exc)
        async with session_factory() as db:
            timestamp = now_utc()
            await db.execute(update(DataExportJob).where(
                DataExportJob.id == job.job_id,
                DataExportJob.user_id == job.user_id,
                DataExportJob.status == "canceling",
                DataExportJob.lease_owner == worker_id,
            ).values(
                status="canceled", stage="canceled", error_code=None,
                artifact_key=None, artifact_size=None, artifact_sha256=None,
                finished_at=timestamp, updated_at=timestamp,
                lease_owner=None, lease_until=None,
            ))
            await db.commit()
    except Exception as exc:
        diag_log("data_portability.export", exc)
        try:
            await storage.delete(artifact_key)
        except Exception as cleanup_exc:
            diag_log("data_portability.export_cleanup", cleanup_exc)
        async with session_factory() as db:
            export_job = (await db.execute(select(DataExportJob).where(
                DataExportJob.id == job.job_id, DataExportJob.user_id == job.user_id,
                DataExportJob.lease_owner == worker_id,
            ).with_for_update())).scalar_one_or_none()
            if export_job is not None:
                timestamp = now_utc()
                if export_job.status == "canceling":
                    export_job.status = export_job.stage = "canceled"
                    export_job.error_code = None
                elif export_job.status == "running":
                    export_job.status = export_job.stage = "failed"
                    export_job.error_code = "export_failed"
                else:
                    await db.commit()
                    _log.warning("数据导出任务已由其他流程收尾 job=%s", job.job_id.hex)
                    return
                export_job.artifact_key = None
                export_job.artifact_size = None
                export_job.artifact_sha256 = None
                export_job.finished_at = timestamp
                export_job.updated_at = timestamp
                export_job.lease_owner = None
                export_job.lease_until = None
                await db.commit()
                if export_job.status == "canceled":
                    _log.info("数据导出任务已取消 job=%s", job.job_id.hex)
                else:
                    _log.warning("数据导出任务失败 job=%s type=%s", job.job_id.hex, type(exc).__name__)
    finally:
        heartbeat_stop.set()
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)


async def cleanup_expired_portability_data(*, session_factory) -> None:
    """清除已过期的私有包/暂存对象，保留不含正文的过期任务状态。"""
    timestamp = now_utc()
    async with session_factory() as db:
        exports = (await db.execute(select(DataExportJob).where(
            DataExportJob.expires_at.is_not(None), DataExportJob.expires_at <= timestamp,
            DataExportJob.status.in_({"ready", "failed", "canceled"}),
        ).limit(50))).scalars().all()
        imports = (await db.execute(select(DataImportJob).where(
            (
                (DataImportJob.status.in_({"preview_ready", "completed", "rolled_back", "failed", "canceled"})
                 & ((DataImportJob.expires_at.is_not(None) & (DataImportJob.expires_at <= timestamp))
                    | (DataImportJob.rollback_expires_at.is_not(None)
                       & (DataImportJob.rollback_expires_at <= timestamp))))
                | ((DataImportJob.status == "uploading")
                   & DataImportJob.expires_at.is_not(None)
                   & (DataImportJob.expires_at <= timestamp))
                | ((DataImportJob.status == "expired")
                   & DataImportJob.staging_key.is_not(None)
                   & DataImportJob.expires_at.is_not(None)
                   & (DataImportJob.expires_at <= timestamp))
            ),
        ).limit(50))).scalars().all()
        await db.commit()

    storage = get_storage()
    for row in exports:
        try:
            if row.artifact_key:
                await storage.delete(row.artifact_key)
        except Exception as exc:
            diag_log("data_portability.expiry_cleanup", exc)
            continue
        async with session_factory() as db:
            await db.execute(update(DataExportJob).where(
                DataExportJob.id == row.id,
                DataExportJob.user_id == row.user_id,
                DataExportJob.expires_at <= timestamp,
                DataExportJob.status.in_({"ready", "failed", "canceled"}),
            ).values(
                status="expired", stage="expired", artifact_key=None,
                artifact_size=None, artifact_sha256=None,
                updated_at=timestamp,
            ))
            await db.commit()

    for row in imports:
        staging_expired = row.expires_at is not None and row.expires_at <= timestamp
        rollback_expired = row.rollback_expires_at is not None and row.rollback_expires_at <= timestamp
        upload_expired = row.status == "uploading" and staging_expired
        try:
            if staging_expired:
                staging_key = row.staging_key
                if upload_expired and not staging_key:
                    # 上传进程可能在对象落盘后、写回 staging_key 前退出；路径由 job id 决定。
                    staging_key = f"{row.user_id.hex}/.data-portability/imports/{row.id.hex}.gupi"
                if staging_key:
                    await storage.delete(staging_key)
            if rollback_expired and row.rollback_key:
                await storage.delete(row.rollback_key)
        except Exception as exc:
            diag_log("data_portability.expiry_cleanup", exc)
            if upload_expired:
                # 对象存储短暂不可用时也必须解除用户级活跃任务锁；保留 staging_key，
                # 后续清理轮次会继续删除孤立暂存对象。
                staging_key = row.staging_key or f"{row.user_id.hex}/.data-portability/imports/{row.id.hex}.gupi"
                async with session_factory() as db:
                    await db.execute(update(DataImportJob).where(
                        DataImportJob.id == row.id,
                        DataImportJob.user_id == row.user_id,
                        DataImportJob.status == "uploading",
                        DataImportJob.expires_at <= timestamp,
                    ).values(
                        status="expired", stage="expired", staging_key=staging_key,
                        import_token_hash=None, error_code="upload_expired",
                        finished_at=timestamp, updated_at=timestamp,
                    ))
                    await db.commit()
            continue
        async with session_factory() as db:
            replacements_left = row.mode in {"replace", "rollback"} and not rollback_expired and bool(row.rollback_key)
            values = {
                "staging_key": None if staging_expired else row.staging_key,
                "rollback_key": None if rollback_expired else row.rollback_key,
                "preview": None if not replacements_left else row.preview,
                "import_token_hash": None,
                "updated_at": timestamp,
            }
            if upload_expired:
                values.update(status="expired", stage="expired", finished_at=timestamp, error_code="upload_expired")
            if not replacements_left:
                values.update(status="expired", stage="expired")
            await db.execute(update(DataImportJob).where(
                DataImportJob.id == row.id,
                DataImportJob.user_id == row.user_id,
                DataImportJob.status.in_({"uploading", "preview_ready", "completed", "rolled_back", "failed", "canceled", "expired"}),
                ((DataImportJob.expires_at.is_not(None) & (DataImportJob.expires_at <= timestamp))
                 | (DataImportJob.rollback_expires_at.is_not(None)
                    & (DataImportJob.rollback_expires_at <= timestamp))),
            ).values(**values))
            await db.commit()


async def process_incremental_import(job: ClaimedJob, *, worker_id: str, session_factory) -> None:
    """重新校验暂存包后在单个数据库事务中应用增量记录。"""
    from app.models import User

    async with session_factory() as lookup_db:
        row = (await lookup_db.execute(select(DataImportJob).where(
            DataImportJob.id == job.job_id, DataImportJob.user_id == job.user_id,
            DataImportJob.mode == "incremental", DataImportJob.status == "running",
            DataImportJob.lease_owner == worker_id,
        ))).scalar_one_or_none()
        if row is None or not row.staging_key:
            return
        staging_key = row.staging_key
        expected_digest = row.archive_sha256
    storage = get_storage()
    import_asset_prefix = f"{job.user_id.hex}/.data-portability/imported/{job.job_id.hex}/"
    # running 租约过期后重试时，先清理上一个 worker 在崩溃前写出的未提交附件。
    await _delete_storage_prefix(storage, import_asset_prefix)
    written_keys: list[str] = []
    heartbeat_stop = asyncio.Event()
    lease_lost = asyncio.Event()

    async def heartbeat():
        while not heartbeat_stop.is_set():
            try:
                await asyncio.wait_for(heartbeat_stop.wait(), timeout=25)
                return
            except TimeoutError:
                async with session_factory() as lease_db:
                    if not await renew_lease(lease_db, "import", job.job_id, worker_id):
                        lease_lost.set()
                        return

    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        with tempfile.TemporaryFile(mode="w+b") as encrypted:
            async for chunk in storage.iter_chunks(staging_key):
                encrypted.write(chunk)
            encrypted.seek(0)
            context = f"data-portability-staging:{job.user_id.hex}:{job.job_id.hex}"
            validated = validate_encrypted_archive(encrypted, context=context, allow_incomplete=True)
            if expected_digest and validated.archive_sha256 != expected_digest:
                raise ValueError("暂存归档摘要不匹配")
            encrypted.seek(0)
            unpacked = EncryptedArchiveReader(encrypted, context)
            with zipfile.ZipFile(unpacked, "r") as archive:
                async with session_factory() as db:
                    async with db.begin():
                        user = await db.get(User, job.user_id)
                        if user is None:
                            raise ValueError("导入账号不存在")
                        counts = await apply_incremental_archive(
                            db, user=user, archive=archive, manifest=validated.manifest,
                            job_id=job.job_id, written_storage_keys=written_keys,
                        )
                        if lease_lost.is_set():
                            raise RuntimeError("导入任务租约已丢失")
                        current = (await db.execute(select(DataImportJob).where(
                            DataImportJob.id == job.job_id,
                            DataImportJob.user_id == job.user_id,
                            DataImportJob.status == "running",
                            DataImportJob.lease_owner == worker_id,
                        ).with_for_update())).scalar_one_or_none()
                        if current is None:
                            raise RuntimeError("导入任务租约已丢失")
                        timestamp = now_utc()
                        current.preview = {**(current.preview or {}), "result": counts}
                        current.status = "completed"
                        current.stage = current.status
                        current.progress_current = validated.record_count
                        current.progress_total = validated.record_count
                        current.finished_at = timestamp
                        current.expires_at = timestamp + _EXPORT_TTL
                        current.lease_owner = None
                        current.lease_until = None
                        current.updated_at = timestamp
        # 导入完成后保留 staging 到期限用于审计/重试状态查询，清理 worker 到期处理。
    except asyncio.CancelledError:
        for key in written_keys:
            try:
                await storage.delete(key)
            except Exception as cleanup_exc:
                diag_log("data_portability.import_asset_cleanup", cleanup_exc)
        await _delete_storage_prefix(storage, import_asset_prefix)
        raise
    except Exception as exc:
        diag_log("data_portability.import_apply", exc)
        for key in written_keys:
            try:
                await storage.delete(key)
            except Exception as cleanup_exc:
                diag_log("data_portability.import_asset_cleanup", cleanup_exc)
        async with session_factory() as db:
            timestamp = now_utc()
            await db.execute(update(DataImportJob).where(
                DataImportJob.id == job.job_id,
                DataImportJob.user_id == job.user_id,
                DataImportJob.status == "running",
                DataImportJob.lease_owner == worker_id,
            ).values(
                status="failed", stage="failed", error_code="import_failed",
                finished_at=timestamp, updated_at=timestamp,
                lease_owner=None, lease_until=None,
            ))
            await db.commit()
        _log.warning("数据增量导入失败 job=%s type=%s", job.job_id.hex, type(exc).__name__)
    finally:
        heartbeat_stop.set()
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)


async def process_replace_import(job: ClaimedJob, *, worker_id: str, session_factory) -> None:
    """用已校验完整归档替换可移植数据；数据库切换单事务，文件记忆有快照补偿。"""
    from app.models import User
    from app.services.data_portability.replace import ROLLBACK_TTL_SECONDS

    async with session_factory() as lookup_db:
        row = (await lookup_db.execute(select(DataImportJob).where(
            DataImportJob.id == job.job_id, DataImportJob.user_id == job.user_id,
            DataImportJob.mode.in_({"replace", "rollback"}), DataImportJob.status.in_({"running", "applying"}),
            DataImportJob.lease_owner == worker_id,
        ))).scalar_one_or_none()
        if row is None:
            return
        staging_key, rollback_key = row.staging_key, row.rollback_key
        expected_digest = row.archive_sha256
        source_job_id, mode = row.source_job_id, row.mode
        resumed_apply = row.status == "applying"

    storage = get_storage()
    import_asset_prefix = f"{job.user_id.hex}/.data-portability/imported/{job.job_id.hex}/"
    written_keys: list[str] = []
    heartbeat_stop = asyncio.Event()
    lease_lost = asyncio.Event()

    async def heartbeat():
        while not heartbeat_stop.is_set():
            try:
                await asyncio.wait_for(heartbeat_stop.wait(), timeout=25)
                return
            except TimeoutError:
                async with session_factory() as lease_db:
                    if not await renew_lease(lease_db, "import", job.job_id, worker_id):
                        lease_lost.set()
                        return

    async def load_package(key: str, context: str, *, allow_incomplete: bool):
        encrypted = tempfile.TemporaryFile(mode="w+b")
        async for chunk in storage.iter_chunks(key):
            encrypted.write(chunk)
        encrypted.seek(0)
        validated = validate_encrypted_archive(encrypted, context=context, allow_incomplete=allow_incomplete)
        encrypted.seek(0)
        reader = EncryptedArchiveReader(encrypted, context)
        archive = zipfile.ZipFile(reader, "r")
        return encrypted, reader, archive, validated

    heartbeat_task = asyncio.create_task(heartbeat())
    apply_started = False
    try:
        if mode == "rollback" and not staging_key:
            if source_job_id is None:
                raise ValueError("撤销任务缺少来源快照")
            async with session_factory() as source_db:
                source = (await source_db.execute(select(DataImportJob).where(
                    DataImportJob.id == source_job_id, DataImportJob.user_id == job.user_id,
                    DataImportJob.mode == "replace", DataImportJob.status == "completed",
                ))).scalar_one_or_none()
                if source is None or not source.rollback_key:
                    raise ValueError("待撤销的替换快照不存在")
                source_key = source.rollback_key
            encrypted_source = tempfile.TemporaryFile(mode="w+b")
            encrypted_staging = tempfile.TemporaryFile(mode="w+b")
            source_reader = None
            try:
                async for chunk in storage.iter_chunks(source_key):
                    encrypted_source.write(chunk)
                encrypted_source.seek(0)
                source_context = rollback_context(job.user_id, source_job_id)
                source_validated = validate_encrypted_archive(
                    encrypted_source, context=source_context, allow_incomplete=False,
                )
                if not source_validated.manifest.complete:
                    raise ValueError("撤销需要完整回滚快照")
                encrypted_source.seek(0)
                source_reader = EncryptedArchiveReader(encrypted_source, source_context)
                staging_key = f"{job.user_id.hex}/.data-portability/imports/{job.job_id.hex}.rollback.gupi"
                staging_context = f"data-portability-staging:{job.user_id.hex}:{job.job_id.hex}"
                envelope = EncryptedArchiveWriter(encrypted_staging, staging_context)
                digest = hashlib.sha256()
                while chunk := source_reader.read(1024 * 1024):
                    digest.update(chunk)
                    envelope.write(chunk)
                envelope.finish()
                encrypted_staging.seek(0, 2)
                encrypted_size = encrypted_staging.tell()
                encrypted_staging.seek(0)
                await storage.put_stream(staging_key, encrypted_staging, encrypted_size, "application/octet-stream")
                async with session_factory() as db:
                    current = (await db.execute(select(DataImportJob).where(
                        DataImportJob.id == job.job_id, DataImportJob.user_id == job.user_id,
                        DataImportJob.status == "running", DataImportJob.lease_owner == worker_id,
                    ).with_for_update())).scalar_one_or_none()
                    if current is None:
                        await storage.delete(staging_key)
                        raise RuntimeError("撤销任务租约已丢失")
                    current.staging_key = staging_key
                    current.archive_sha256 = digest.hexdigest()
                    current.updated_at = now_utc()
                    await db.commit()
                expected_digest = digest.hexdigest()
            finally:
                if source_reader is not None:
                    source_reader.close()
                encrypted_source.close()
                encrypted_staging.close()

        # 先关账号写入口，再等待已启动的会话 run 排空，然后才读取回滚快照。
        # applying 状态会被认证依赖识别为维护窗口；崩溃后同样保留门禁并由新 worker 恢复。
        async with session_factory() as db:
            current = (await db.execute(select(DataImportJob).where(
                DataImportJob.id == job.job_id, DataImportJob.user_id == job.user_id,
                DataImportJob.status.in_({"running", "applying"}),
                DataImportJob.lease_owner == worker_id,
            ).with_for_update())).scalar_one_or_none()
            if current is None:
                raise RuntimeError("替换任务租约已丢失")
            current.status = "applying"
            current.stage = "maintenance"
            current.updated_at = now_utc()
            await db.commit()
        await _wait_for_user_sessions(job.user_id, session_factory, lease_lost)

        # 快照 artifact 在 DB 中登记后才允许进入 applying。重试复用同一 job key。
        if not rollback_key:
            rollback_key, _snapshot_size, _snapshot_digest = await create_rollback_snapshot(
                user_id=job.user_id, job_id=job.job_id,
                session_factory=session_factory, storage=storage,
            )
            async with session_factory() as db:
                current = (await db.execute(select(DataImportJob).where(
                DataImportJob.id == job.job_id, DataImportJob.user_id == job.user_id,
                DataImportJob.status == "applying", DataImportJob.lease_owner == worker_id,
            ).with_for_update())).scalar_one_or_none()
                if current is None:
                    raise RuntimeError("替换任务租约已丢失")
                current.rollback_key = rollback_key
                current.rollback_expires_at = now_utc() + timedelta(seconds=ROLLBACK_TTL_SECONDS)
                current.stage = "snapshot_ready"
                current.updated_at = now_utc()
                await db.commit()

        if resumed_apply:
            # applying 且租约已过期说明旧事务不可能提交（数据和任务状态同一事务），
            # 先将跨存储记忆恢复到快照状态，再幂等重做数据库切换。
            old_encrypted, old_reader, old_archive, old_validated = await load_package(
                rollback_key, rollback_context(job.user_id, job.job_id), allow_incomplete=False,
            )
            new_encrypted, new_reader, new_archive, new_validated = await load_package(
                staging_key, f"data-portability-staging:{job.user_id.hex}:{job.job_id.hex}",
                allow_incomplete=False,
            )
            try:
                if not old_validated.manifest.complete or not new_validated.manifest.complete:
                    raise ValueError("恢复替换需要完整归档")
                await restore_memory_files(
                    user_id=job.user_id, old_archive=old_archive, old_manifest=old_validated.manifest,
                    new_archive=new_archive, new_manifest=new_validated.manifest, storage=storage,
                )
            finally:
                old_archive.close(); old_reader.close(); old_encrypted.close()
                new_archive.close(); new_reader.close(); new_encrypted.close()
        else:
            await _delete_storage_prefix(storage, import_asset_prefix)

        async with session_factory() as db:
            current = (await db.execute(select(DataImportJob).where(
                DataImportJob.id == job.job_id, DataImportJob.user_id == job.user_id,
                DataImportJob.status.in_({"running", "applying"}),
                DataImportJob.lease_owner == worker_id,
            ).with_for_update())).scalar_one_or_none()
            if current is None:
                raise RuntimeError("替换任务租约已丢失")
            current.status = "applying"
            current.stage = "applying"
            current.updated_at = now_utc()
            await db.commit()
        apply_started = True

        old_encrypted, old_reader, old_archive, old_validated = await load_package(
            rollback_key, rollback_context(job.user_id, job.job_id), allow_incomplete=False,
        )
        new_encrypted, new_reader, new_archive, new_validated = await load_package(
            staging_key, f"data-portability-staging:{job.user_id.hex}:{job.job_id.hex}",
            allow_incomplete=False,
        )
        old_storage_keys: list[str] = []
        try:
            if expected_digest and new_validated.archive_sha256 != expected_digest:
                raise ValueError("替换归档摘要不匹配")
            if not old_validated.manifest.complete or not new_validated.manifest.complete:
                raise ValueError("替换需要完整归档")
            await replace_memory_files(
                user_id=job.user_id, old_archive=old_archive, old_manifest=old_validated.manifest,
                new_archive=new_archive, new_manifest=new_validated.manifest, storage=storage,
            )
            with new_archive:
                async with session_factory() as db:
                    async with db.begin():
                        user = await db.get(User, job.user_id)
                        if user is None:
                            raise ValueError("替换账号不存在")
                        from app.services.storage.quota_ledger import reconcile_user_storage
                        await reconcile_user_storage(db, user.id)
                        old_rows = await clear_portable_database(db, user_id=job.user_id)
                        old_storage_keys = old_rows["storage_keys"]
                        from app.services.storage.quota_ledger import FILE_LIBRARY, record_usage
                        for file_id, size in old_rows["active_files"]:
                            await record_usage(
                                db, user.id, category=FILE_LIBRARY, delta_bytes=-size,
                                operation="data_replace", resource_type="file", resource_id=file_id,
                                idempotency_key=f"data-replace:{job.job_id}:old-file:{file_id}",
                            )
                        counts = await apply_incremental_archive(
                            db, user=user, archive=new_archive, manifest=new_validated.manifest,
                            job_id=job.job_id, written_storage_keys=written_keys, replace=True,
                        )
                        if lease_lost.is_set():
                            raise RuntimeError("替换任务租约已丢失")
                        current = (await db.execute(select(DataImportJob).where(
                            DataImportJob.id == job.job_id, DataImportJob.user_id == job.user_id,
                            DataImportJob.status == "applying", DataImportJob.lease_owner == worker_id,
                        ).with_for_update())).scalar_one_or_none()
                        if current is None:
                            raise RuntimeError("替换任务租约已丢失")
                        current.preview = {**(current.preview or {}), "result": counts}
                        current.status = "rolled_back" if mode == "rollback" else "completed"
                        current.stage = current.status
                        current.progress_current = new_validated.record_count
                        current.progress_total = new_validated.record_count
                        current.finished_at = now_utc()
                        current.expires_at = now_utc() + _EXPORT_TTL
                        current.lease_owner = None
                        current.lease_until = None
                        current.updated_at = now_utc()
                        if mode == "rollback" and source_job_id is not None:
                            source = (await db.execute(select(DataImportJob).where(
                                DataImportJob.id == source_job_id,
                                DataImportJob.user_id == job.user_id,
                                DataImportJob.status == "completed",
                            ).with_for_update())).scalar_one_or_none()
                            if source is not None:
                                source.status = "rolled_back"
                                source.stage = "rolled_back"
                                source.rollback_expires_at = now_utc()
                                source.updated_at = now_utc()
            # DB 已完成切换后，再清理旧二进制；chat attachment 可能共享同一物理 key。
            from app.core.chat_attach import try_delete_storage_if_unreferenced
            old_key_types: dict[str, set[str]] = {}
            for key, record_type in old_storage_keys:
                old_key_types.setdefault(key, set()).add(record_type)
            for key, record_types in old_key_types.items():
                try:
                    if "chat_attachment" in record_types:
                        await try_delete_storage_if_unreferenced(job.user_id, key)
                    else:
                        await storage.delete(key)
                except Exception as cleanup_exc:
                    diag_log("data_portability.replace_old_asset_cleanup", cleanup_exc)
        finally:
            old_archive.close(); old_reader.close(); old_encrypted.close()
            new_archive.close(); new_reader.close(); new_encrypted.close()
    except asyncio.CancelledError:
        if apply_started and rollback_key:
            await _recover_replacement_failure(
                job, worker_id, session_factory, storage, staging_key, rollback_key, written_keys,
            )
        raise
    except Exception as exc:
        diag_log("data_portability.replace_apply", exc)
        await _recover_replacement_failure(
            job, worker_id, session_factory, storage, staging_key, rollback_key, written_keys,
        )
        _log.warning("数据替换任务失败 job=%s type=%s", job.job_id.hex, type(exc).__name__)
    finally:
        heartbeat_stop.set()
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)


async def _recover_replacement_failure(job, worker_id, session_factory, storage,
                                       staging_key, rollback_key, written_keys):
    """数据库事务失败时恢复记忆文件；恢复失败则持久标记并继续保持写入门禁。"""
    from app.models import DataImportJob
    async with session_factory() as status_db:
        current_status = (await status_db.execute(select(DataImportJob.status).where(
            DataImportJob.id == job.job_id, DataImportJob.user_id == job.user_id,
        ))).scalar_one_or_none()
    if current_status in {"completed", "rolled_back"}:
        # 数据库与 completed 同事务提交；若之后的旧附件清理/worker 关闭失败，不回滚新状态。
        return
    recovered = not bool(rollback_key)
    if rollback_key:
        try:
            old_encrypted = tempfile.TemporaryFile(mode="w+b")
            new_encrypted = tempfile.TemporaryFile(mode="w+b")
            async for chunk in storage.iter_chunks(rollback_key):
                old_encrypted.write(chunk)
            async for chunk in storage.iter_chunks(staging_key):
                new_encrypted.write(chunk)
            old_encrypted.seek(0); new_encrypted.seek(0)
            old_context = rollback_context(job.user_id, job.job_id)
            new_context = f"data-portability-staging:{job.user_id.hex}:{job.job_id.hex}"
            old_validated = validate_encrypted_archive(old_encrypted, context=old_context, allow_incomplete=False)
            new_validated = validate_encrypted_archive(new_encrypted, context=new_context, allow_incomplete=False)
            old_encrypted.seek(0); new_encrypted.seek(0)
            old_reader = EncryptedArchiveReader(old_encrypted, old_context)
            new_reader = EncryptedArchiveReader(new_encrypted, new_context)
            old_archive = zipfile.ZipFile(old_reader, "r")
            new_archive = zipfile.ZipFile(new_reader, "r")
            try:
                await restore_memory_files(
                    user_id=job.user_id, old_archive=old_archive, old_manifest=old_validated.manifest,
                    new_archive=new_archive, new_manifest=new_validated.manifest, storage=storage,
                )
                recovered = True
            finally:
                old_archive.close(); old_reader.close(); old_encrypted.close()
                new_archive.close(); new_reader.close(); new_encrypted.close()
        except Exception as recovery_exc:
            diag_log("data_portability.replace_memory_recovery", recovery_exc)
    for key in written_keys:
        try:
            await storage.delete(key)
        except Exception as cleanup_exc:
            diag_log("data_portability.replace_asset_cleanup", cleanup_exc)
    if recovered:
        await _delete_storage_prefix(storage, f"{job.user_id.hex}/.data-portability/imported/{job.job_id.hex}/")
    async with session_factory() as db:
        timestamp = now_utc()
        await db.execute(update(DataImportJob).where(
            DataImportJob.id == job.job_id, DataImportJob.user_id == job.user_id,
            DataImportJob.lease_owner == worker_id,
            DataImportJob.status.in_({"running", "applying"}),
        ).values(
            status="failed" if recovered else "needs_recovery",
            stage="failed" if recovered else "needs_recovery",
            error_code="replace_failed" if recovered else "replace_needs_recovery",
            finished_at=timestamp if recovered else None,
            updated_at=timestamp,
            lease_owner=None,
            lease_until=None,
        ))
        await db.commit()


async def _wait_for_user_sessions(user_id, session_factory, lease_lost: asyncio.Event) -> None:
    """维护门关闭后等待已有会话 run 完成，避免快照夹在一次对话写入中间。"""
    from app.models import ConversationSession

    deadline = asyncio.get_running_loop().time() + 300
    while True:
        if lease_lost.is_set():
            raise RuntimeError("替换任务租约已丢失")
        async with session_factory() as db:
            active = (await db.execute(select(ConversationSession.id).where(
                ConversationSession.user_id == user_id,
                ConversationSession.active_run_id.is_not(None),
            ).limit(1))).scalar_one_or_none()
        if active is None:
            return
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("等待账号会话任务结束超时")
        await asyncio.sleep(0.5)


async def _delete_storage_prefix(storage, prefix: str) -> None:
    cursor = None
    while True:
        keys, cursor = await storage.list_keys_prefix(prefix, cursor=cursor, limit=500)
        for key in keys:
            try:
                await storage.delete(key)
            except Exception as exc:
                diag_log("data_portability.import_asset_cleanup", exc)
        if cursor is None:
            break
async def run_portability_worker(stop_event, *, worker_id: str, session_factory) -> None:
    """消费导出任务与只读导入预检任务。"""
    last_cleanup = 0.0
    while not stop_event.is_set():
        try:
            if asyncio.get_running_loop().time() - last_cleanup >= 60:
                await cleanup_expired_portability_data(session_factory=session_factory)
                last_cleanup = asyncio.get_running_loop().time()
            async with session_factory() as db:
                job = await claim_next_job(db, worker_id, include_imports=True)
            if job is None:
                await asyncio.sleep(2)
                continue
            if job.kind == "export":
                await process_export_job(job, worker_id=worker_id, session_factory=session_factory)
            elif job.mode == "preflight":
                from app.services.data_portability.import_preflight import process_import_preflight
                await process_import_preflight(job, worker_id=worker_id, session_factory=session_factory)
            elif job.mode == "incremental":
                await process_incremental_import(job, worker_id=worker_id, session_factory=session_factory)
            elif job.mode in {"replace", "rollback"}:
                await process_replace_import(job, worker_id=worker_id, session_factory=session_factory)
            else:
                # 未实现的导入执行模式不应被悄悄消费或标记成功，释放为显式失败。
                from sqlalchemy import update
                from app.models import DataImportJob
                async with session_factory() as db:
                    timestamp = now_utc()
                    await db.execute(update(DataImportJob).where(
                        DataImportJob.id == job.job_id,
                        DataImportJob.user_id == job.user_id,
                        DataImportJob.status == "running",
                        DataImportJob.lease_owner == worker_id,
                    ).values(
                        status="failed", stage="failed", error_code="unsupported_import_mode",
                        finished_at=timestamp, updated_at=timestamp,
                        lease_owner=None, lease_until=None,
                    ))
                    await db.commit()
        except asyncio.CancelledError:
            return
        except Exception as exc:
            diag_log("data_portability.worker_loop", exc)
            _log.warning("数据可移植 worker 循环失败 type=%s", type(exc).__name__)
            await asyncio.sleep(2)
