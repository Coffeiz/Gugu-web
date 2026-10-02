"""上传归档的异步只读预检。预检期间不写入任何业务对象。"""
from __future__ import annotations

import asyncio
import logging
import tempfile
import zipfile
from datetime import timedelta

from sqlalchemy import select, update

from app.core.redaction import diag_log
from app.core.tz import now_utc
from app.models import DataImportJob, DataPortableIdentity
from app.services.data_portability.crypto_stream import EncryptedArchiveReader
from app.services.data_portability.schema import PortableEntityRecord
from app.services.data_portability.projection import RECORD_SPECS, count_owned_records
from app.services.data_portability.conflicts import find_unique_conflicts
from app.services.data_portability.archive_validation import validate_encrypted_archive
from app.services.data_portability.jobs import ClaimedJob, renew_lease
from app.services.storage import get_storage

_log = logging.getLogger("data_portability.import")
_STAGING_TTL = timedelta(hours=24)


async def process_import_preflight(job: ClaimedJob, *, worker_id: str, session_factory) -> None:
    """校验 staging 中的归档并生成预览。业务写入由独立的确认任务处理。"""
    async with session_factory() as db:
        row = (await db.execute(select(DataImportJob).where(
            DataImportJob.id == job.job_id,
            DataImportJob.user_id == job.user_id,
            DataImportJob.mode == "preflight",
            DataImportJob.status == "running",
            DataImportJob.lease_owner == worker_id,
        ))).scalar_one_or_none()
        if row is None or not row.staging_key:
            return
        staging_key = row.staging_key
        expected_sha256 = row.archive_sha256

    stop = asyncio.Event()

    async def heartbeat():
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=25)
                return
            except TimeoutError:
                async with session_factory() as lease_db:
                    if not await renew_lease(lease_db, "import", job.job_id, worker_id):
                        return

    heartbeat_task = asyncio.create_task(heartbeat())
    source = None
    try:
        source = tempfile.TemporaryFile(mode="w+b")
        async for chunk in get_storage().iter_chunks(staging_key):
            source.write(chunk)
        source.seek(0)
        context = f"data-portability-staging:{job.user_id.hex}:{job.job_id.hex}"
        result = validate_encrypted_archive(source, context=context, allow_incomplete=True)
        if expected_sha256 and result.archive_sha256 != expected_sha256:
            raise ValueError("暂存归档摘要与上传内容不一致")
        identities = set()
        async with session_factory() as identity_db:
            known_rows = (await identity_db.execute(select(
                DataPortableIdentity.source_type, DataPortableIdentity.portable_id,
            ).where(
                DataPortableIdentity.user_id == job.user_id,
                DataPortableIdentity.origin_id == result.manifest.origin_id,
            ))).all()
            identities = {(str(source_type), str(portable_id)) for source_type, portable_id in known_rows}
        source_counts, existing_counts = {}, {}
        memory_source_counts = {"owner_memory_file": 0, "im_memory_file": 0}
        memory_existing_counts = {"owner_memory_file": 0, "im_memory_file": 0}
        source.seek(0)
        unpacked = EncryptedArchiveReader(source, f"data-portability-staging:{job.user_id.hex}:{job.job_id.hex}")
        with zipfile.ZipFile(unpacked, "r") as archive:
            for entry in result.manifest.entries:
                if not entry.path.endswith((".jsonl", ".json")) or not (
                    entry.path.startswith("records/")
                    or entry.path in {"memory/im/entries.jsonl", "memory/im/sources.jsonl"}
                ):
                    continue
                with archive.open(entry.path, "r") as stream:
                    for line in stream:
                        if not line.strip():
                            continue
                        record = PortableEntityRecord.model_validate_json(line)
                        if record.source_type == "account":
                            continue
                        source_counts[record.source_type] = source_counts.get(record.source_type, 0) + 1
                        identity = (record.source_type, record.portable_id)
                        if identity in identities:
                            existing_counts[record.source_type] = existing_counts.get(record.source_type, 0) + 1
            for entry in result.manifest.entries:
                if entry.path.startswith(("memory/owner/", "memory/legacy/")):
                    source_type = "owner_memory_file"
                elif entry.path.startswith("memory/im/scopes/"):
                    source_type = "im_memory_file"
                else:
                    continue
                memory_source_counts[source_type] += 1
                if (source_type, entry.path) in identities:
                    memory_existing_counts[source_type] += 1
        add_counts = {
            source_type: count - existing_counts.get(source_type, 0)
            for source_type, count in source_counts.items()
        }
        memory_add_counts = {
            source_type: count - memory_existing_counts[source_type]
            for source_type, count in memory_source_counts.items()
        }
        preview = {
            "format_version": result.manifest.format_version,
            "origin_id": str(result.manifest.origin_id),
            "export_id": str(result.manifest.export_id),
            "created_at": result.manifest.created_at.isoformat(),
            "complete": result.manifest.complete,
            "record_count": result.record_count,
            "expanded_bytes": result.expanded_bytes,
            "incremental": {
                "add": add_counts,
                "skip": existing_counts,
                "add_total": sum(add_counts.values()),
                "skip_total": sum(existing_counts.values()),
            },
            "replace": {
                "current": {},
                "incoming": {
                    category: details.records
                    for category, details in result.manifest.categories.items()
                },
            },
            "memory": {
                "add": memory_add_counts,
                "skip": memory_existing_counts,
                "add_total": sum(memory_add_counts.values()),
                "skip_total": sum(memory_existing_counts.values()),
            },
            "categories": {
                name: {
                    "included": category.included,
                    "records": category.records,
                    "bytes": category.bytes,
                }
                for name, category in result.manifest.categories.items()
            },
        }
        async with session_factory() as db:
            source.seek(0)
            conflict_reader = EncryptedArchiveReader(
                source, f"data-portability-staging:{job.user_id.hex}:{job.job_id.hex}"
            )
            try:
                with zipfile.ZipFile(conflict_reader, "r") as conflict_archive:
                    conflicts = await find_unique_conflicts(
                        db, user_id=job.user_id, archive=conflict_archive,
                        manifest=result.manifest,
                    )
            finally:
                conflict_reader.close()
            current_counts = await count_owned_records(db, job.user_id)
            preview["replace"]["current"] = {
                category: sum(current_counts.get(spec.record_type, 0) for spec in RECORD_SPECS
                              if spec.category == category)
                for category in result.manifest.categories
            }
            preview["replace"]["current"]["account"] = 1
            preview["conflicts"] = {"total": len(conflicts), "items": conflicts}
            timestamp = now_utc()
            await db.execute(update(DataImportJob).where(
                DataImportJob.id == job.job_id,
                DataImportJob.user_id == job.user_id,
                DataImportJob.mode == "preflight",
                DataImportJob.status == "running",
                DataImportJob.lease_owner == worker_id,
            ).values(
                status="preview_ready", stage="preview_ready", preview=preview,
                archive_origin_id=result.manifest.origin_id,
                archive_export_id=result.manifest.export_id,
                archive_sha256=result.archive_sha256,
                progress_current=result.record_count,
                progress_total=result.record_count,
                finished_at=timestamp,
                expires_at=timestamp + _STAGING_TTL,
                updated_at=timestamp,
                lease_owner=None,
                lease_until=None,
            ))
            await db.commit()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        diag_log("data_portability.import_preflight", exc)
        async with session_factory() as db:
            timestamp = now_utc()
            await db.execute(update(DataImportJob).where(
                DataImportJob.id == job.job_id,
                DataImportJob.user_id == job.user_id,
                DataImportJob.status == "running",
                DataImportJob.lease_owner == worker_id,
            ).values(
                status="failed", stage="failed", error_code="invalid_archive",
                finished_at=timestamp, updated_at=timestamp,
                lease_owner=None, lease_until=None,
            ))
            await db.commit()
        _log.warning("数据归档预检失败 job=%s type=%s", job.job_id.hex, type(exc).__name__)
    finally:
        stop.set()
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)
        if source is not None:
            source.close()
