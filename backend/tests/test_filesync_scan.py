"""保护手动扫描的完整性、临时清单有界读取与协作取消。"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest

from app.services.filesync.scan import (
    ScanIncomplete,
    ScanTimedOut,
    connect_manifest,
    iter_manifest_entries,
    iter_reconcile_candidate_batches,
    run_scan_in_thread,
    scan_to_manifest,
)


def test_scan_streams_entries_to_private_manifest_and_hashes_every_file(tmp_path: Path):
    root = tmp_path / "root"
    temp = tmp_path / "tmp"
    (root / "folder").mkdir(parents=True)
    (root / "folder" / "same-stat.txt").write_bytes(b"first")
    (root / "other.txt").write_bytes(b"second")
    stop = Event()

    manifest = scan_to_manifest(
        root,
        temp_directory=temp,
        stop_event=stop,
        max_manifest_bytes=1024 * 1024,
        commit_entries=16,
    )
    try:
        assert manifest.scanned_count == 3
        assert manifest.manifest_bytes <= 1024 * 1024
        assert manifest.path.stat().st_mode & 0o077 == 0
        batches = list(iter_manifest_entries(manifest, batch_size=1))
        rows = [row for batch in batches for row in batch]
        by_name = {row[0]: row for row in rows}
        assert by_name["folder"][1] == "directory"
        assert by_name["folder/same-stat.txt"][4]
        assert by_name["other.txt"][4]
    finally:
        manifest.close()
    assert not manifest.path.exists()


def test_symlink_makes_scan_incomplete_so_it_cannot_become_a_missing_delete(tmp_path: Path):
    root = tmp_path / "root"
    outside = tmp_path / "outside.txt"
    root.mkdir()
    outside.write_text("do not index")
    (root / "link.txt").symlink_to(outside)

    with pytest.raises(ScanIncomplete):
        scan_to_manifest(
            root,
            temp_directory=tmp_path / "tmp",
            stop_event=Event(),
            max_manifest_bytes=1024 * 1024,
        )
    assert list((tmp_path / "tmp").glob("gugu-filesync-*.sqlite")) == []


def test_unavailable_or_cancelled_scan_never_returns_a_complete_manifest(tmp_path: Path):
    with pytest.raises(ScanIncomplete):
        scan_to_manifest(
            tmp_path / "missing",
            temp_directory=tmp_path / "tmp",
            stop_event=Event(),
            max_manifest_bytes=1024 * 1024,
        )
    assert list((tmp_path / "tmp").glob("gugu-filesync-*.sqlite")) == []

    root = tmp_path / "root"
    root.mkdir()
    (root / "entry").write_text("content")
    stop = Event()
    stop.set()
    with pytest.raises(InterruptedError):
        scan_to_manifest(
            root,
            temp_directory=tmp_path / "tmp",
            stop_event=stop,
            max_manifest_bytes=1024 * 1024,
        )
    assert list((tmp_path / "tmp").glob("gugu-filesync-*.sqlite")) == []


@pytest.mark.asyncio
async def test_cancel_waits_for_scan_thread_exit_before_releasing_caller(tmp_path: Path):
    started = Event()
    stop_seen = Event()
    allow_exit = Event()
    exited = Event()

    def blocked_scanner(root, *, stop_event, **_kwargs):
        started.set()
        assert stop_event.wait(timeout=2)
        stop_seen.set()
        assert allow_exit.wait(timeout=2)
        exited.set()
        raise InterruptedError("cancelled")

    stop = Event()
    root = tmp_path / "root"
    root.mkdir()
    with ThreadPoolExecutor(max_workers=1) as executor:
        task = asyncio.create_task(run_scan_in_thread(
            executor,
            root,
            temp_directory=tmp_path / "tmp",
            stop_event=stop,
            max_manifest_bytes=1024 * 1024,
            timeout_seconds=10,
            scanner=blocked_scanner,
        ))
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        assert await asyncio.to_thread(stop_seen.wait, 1)
        assert not task.done()
        allow_exit.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert exited.is_set()


@pytest.mark.asyncio
async def test_timeout_signals_and_joins_scan_thread_before_reporting_timeout(tmp_path: Path):
    exited = Event()

    def cooperative_scanner(root, *, stop_event, **_kwargs):
        assert stop_event.wait(timeout=2)
        exited.set()
        raise InterruptedError("budget expired")

    root = tmp_path / "root"
    root.mkdir()
    with ThreadPoolExecutor(max_workers=1) as executor:
        with pytest.raises(ScanTimedOut):
            await run_scan_in_thread(
                executor,
                root,
                temp_directory=tmp_path / "tmp",
                stop_event=Event(),
                max_manifest_bytes=1024 * 1024,
                timeout_seconds=0.02,
                scanner=cooperative_scanner,
            )

    assert exited.is_set()


def test_complete_manifest_diff_is_bounded_and_marks_duplicate_or_type_conflicts_ambiguous(tmp_path: Path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "same.txt").write_bytes(b"same")
    (root / "changed.txt").write_bytes(b"new")
    (root / "conflict.txt").write_bytes(b"local changed")
    (root / "new-folder").mkdir()
    (root / "existing-folder").mkdir()
    (root / "type-conflict").mkdir()
    stop = Event()
    manifest = scan_to_manifest(
        root,
        temp_directory=tmp_path / "tmp",
        stop_event=stop,
        max_manifest_bytes=1024 * 1024,
    )
    try:
        entries = {
            row[0]: row
            for batch in iter_manifest_entries(manifest, batch_size=2)
            for row in batch
        }
        with connect_manifest(manifest) as connection:
            connection.execute(
                "INSERT INTO db_files "
                "(id, relative_path, storage_key, size_bytes, version, display_name, ext, space, fingerprint) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ",
                (1, "same.txt", "u/Personal/same.txt", entries["same.txt"][2], 3, "same", "txt", "personal", entries["same.txt"][4]),
            )
            connection.execute(
                "INSERT INTO db_files "
                "(id, relative_path, storage_key, size_bytes, version, display_name, ext, space, fingerprint) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ",
                (6, "changed.txt", "u/Personal/changed.txt", 2, 4, "changed", "txt", "personal", "old"),
            )
            connection.execute(
                "INSERT INTO db_files "
                "(id, relative_path, storage_key, size_bytes, version, display_name, ext, space, "
                "fingerprint, file_updated_at, journal_updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (7, "conflict.txt", "u/Personal/conflict.txt", 12, 5, "conflict", "txt", "personal", "baseline", 20, 10),
            )
            connection.execute(
                "INSERT INTO db_files "
                "(id, relative_path, storage_key, size_bytes, version, display_name, ext, space, fingerprint) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ",
                (2, "gone.txt", "u/Personal/gone.txt", 4, 7, "gone", "txt", "personal", "old"),
            )
            connection.executemany(
                "INSERT INTO db_files "
                "(id, relative_path, storage_key, size_bytes, version, display_name, ext, space, fingerprint) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ",
                [
                    (3, "duplicate.txt", "u/a", 1, 1, "duplicate", "txt", "personal", "a"),
                    (4, "duplicate.txt", "u/b", 1, 1, "duplicate", "txt", "personal", "b"),
                    (5, "type-conflict", "u/type-conflict", 1, 1, "type-conflict", "", "personal", "a"),
                ],
            )
            connection.execute(
                "INSERT INTO db_folders VALUES (10, 'existing-folder', 2, NULL)"
            )
            connection.commit()

        candidates = [
            candidate
            for batch in iter_reconcile_candidate_batches(manifest, batch_size=2)
            for candidate in batch
        ]
        by_path = {candidate.relative_path: candidate for candidate in candidates}
        assert (by_path["changed.txt"].operation, by_path["changed.txt"].object_version) == ("update", 4)
        assert by_path["conflict.txt"].operation == "conflict"
        assert by_path["conflict.txt"].baseline_fingerprint == "baseline"
        assert by_path["gone.txt"].operation == "delete"
        assert by_path["gone.txt"].object_version == 7
        assert by_path["duplicate.txt"].operation == "ambiguous"
        assert by_path["type-conflict"].operation == "ambiguous"
        assert by_path["new-folder"].operation == "create"
        assert "same.txt" not in by_path
        assert by_path["existing-folder"].operation == "update"
        assert by_path["existing-folder"].object_version == 2
    finally:
        manifest.close()
