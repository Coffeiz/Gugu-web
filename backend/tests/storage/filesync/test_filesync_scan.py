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
    manifest_exclusions_overlap_database,
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


def test_scan_finalizes_directory_when_prefix_sibling_sorts_before_child(tmp_path: Path):
    """路径段排序必须让目录后代连续，避免前缀相似的兄弟项提前关闭目录栈。"""
    root = tmp_path / "root"
    (root / "branch").mkdir(parents=True)
    (root / "branch" / "inside.txt").write_text("nested", encoding="utf-8")
    (root / "branch-note.txt").write_text("sibling", encoding="utf-8")

    manifest = scan_to_manifest(
        root,
        temp_directory=tmp_path / "tmp",
        stop_event=Event(),
        max_manifest_bytes=1024 * 1024,
    )
    try:
        entries = {
            row[0]: row
            for batch in iter_manifest_entries(manifest)
            for row in batch
        }
        assert manifest.scanned_count == 3
        assert entries["branch"][1] == "directory"
        assert entries["branch"][4]
        assert entries["branch/inside.txt"][4]
        assert entries["branch-note.txt"][4]
    finally:
        manifest.close()


def test_user_root_scan_excludes_non_library_namespaces_before_traversal(tmp_path: Path):
    root = tmp_path / "user"
    (root / "个人文件").mkdir(parents=True)
    (root / "个人文件" / "note.txt").write_text("library", encoding="utf-8")
    runtime = root / "workspace" / "default" / "node_modules"
    runtime.mkdir(parents=True)
    for index in range(100):
        (runtime / f"runtime-{index}.pak").write_bytes(b"runtime data")
    (root / ".system").mkdir()
    (root / ".system" / "internal.json").write_text("{}", encoding="utf-8")

    manifest = scan_to_manifest(
        root,
        temp_directory=tmp_path / "tmp",
        stop_event=Event(),
        max_manifest_bytes=1024 * 1024,
        included_root_entries=frozenset({"个人文件", "项目文件"}),
    )
    try:
        rows = [row for batch in iter_manifest_entries(manifest) for row in batch]
        assert manifest.scanned_count == 2
        assert {row[0] for row in rows} == {"个人文件", "个人文件/note.txt"}
    finally:
        manifest.close()


def test_symlinks_are_excluded_without_following_and_only_block_when_they_hide_library_records(
    tmp_path: Path,
):
    root = tmp_path / "root"
    outside = tmp_path / "outside.txt"
    outside_dir = tmp_path / "outside-dir"
    root.mkdir()
    outside_dir.mkdir()
    (root / "safe.txt").write_text("safe", encoding="utf-8")
    outside.write_text("do not index")
    (root / "link.txt").symlink_to(outside)
    (outside_dir / "hidden.txt").write_text("do not index", encoding="utf-8")
    (root / "linked-dir").symlink_to(outside_dir, target_is_directory=True)

    manifest = scan_to_manifest(
        root,
        temp_directory=tmp_path / "tmp",
        stop_event=Event(),
        max_manifest_bytes=1024 * 1024,
    )
    try:
        rows = [row for batch in iter_manifest_entries(manifest) for row in batch]
        assert manifest.scanned_count == 1
        assert manifest.rejected_count == 2
        assert {row[0] for row in rows} == {"safe.txt"}
        assert not manifest_exclusions_overlap_database(manifest)

        connection = connect_manifest(manifest)
        try:
            connection.execute(
                "INSERT INTO db_files "
                "(id, relative_path, storage_key, size_bytes, version, display_name, ext, space) "
                "VALUES (1, 'linked-dir/hidden.txt', 'user/workspace/linked-dir/hidden.txt', "
                "7, 1, 'hidden', 'txt', 'workspace')"
            )
            connection.commit()
        finally:
            connection.close()
        assert manifest_exclusions_overlap_database(manifest)
    finally:
        manifest.close()


def test_permission_denied_subtree_does_not_block_visible_files_or_delete_hidden_records(
    tmp_path: Path, monkeypatch,
):
    """私有 0700 子目录不能中断整棵同步树，也不能让其中旧记录变成删除候选。"""
    import app.services.filesync.scan as scan

    root = tmp_path / "root"
    private = root / "private"
    visible = root / "visible"
    private.mkdir(parents=True)
    visible.mkdir()
    (visible / "new.png").write_bytes(b"new image")
    real_scandir = scan.os.scandir

    def deny_private(path):
        if Path(path).resolve() == private.resolve():
            raise PermissionError("synthetic private directory")
        return real_scandir(path)

    monkeypatch.setattr(scan.os, "scandir", deny_private)
    manifest = scan_to_manifest(
        root,
        temp_directory=tmp_path / "tmp",
        stop_event=Event(),
        max_manifest_bytes=1024 * 1024,
    )
    try:
        connection = connect_manifest(manifest)
        try:
            connection.execute(
                "INSERT INTO db_files "
                "(id, relative_path, storage_key, size_bytes, version, display_name, ext, space) "
                "VALUES (1, 'private/old.png', 'user/workspace/private/old.png', "
                "7, 1, 'old', 'png', 'workspace')"
            )
            connection.commit()
            exclusions = connection.execute(
                "SELECT relative_path, reason FROM excluded_paths"
            ).fetchall()
        finally:
            connection.close()

        candidates = [
            item
            for batch in iter_reconcile_candidate_batches(manifest)
            for item in batch
        ]
        assert manifest.scanned_count == 3
        assert manifest.rejected_count == 1
        assert manifest.permission_excluded_count == 1
        assert exclusions == [("private", "permission")]
        assert not manifest_exclusions_overlap_database(manifest)
        assert [(item.relative_path, item.operation) for item in candidates] == [
            ("visible", "create"),
            ("visible/new.png", "create"),
        ]
    finally:
        manifest.close()


def test_manifest_budget_failure_removes_partial_manifest_and_never_returns_scan(tmp_path: Path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "entry.txt").write_text("new file")

    with pytest.raises(ScanIncomplete, match="空间预算") as error:
        scan_to_manifest(
            root,
            temp_directory=tmp_path / "tmp",
            stop_event=Event(),
            max_manifest_bytes=1,
            commit_entries=1,
        )

    assert error.value.code == "scan_manifest_budget_exceeded"

    assert list((tmp_path / "tmp").glob("gugu-filesync-*.sqlite")) == []


def test_unavailable_or_cancelled_scan_never_returns_a_complete_manifest(tmp_path: Path):
    with pytest.raises(ScanIncomplete) as error:
        scan_to_manifest(
            tmp_path / "missing",
            temp_directory=tmp_path / "tmp",
            stop_event=Event(),
            max_manifest_bytes=1024 * 1024,
        )
    assert error.value.code == "binding_root_unavailable"
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
@pytest.mark.parametrize("stop_mode", ["cancel", "timeout"])
async def test_stop_during_directory_traversal_joins_thread_before_releasing_slot(
    tmp_path: Path, monkeypatch, stop_mode: str,
):
    import app.services.filesync.scan as scan

    root = tmp_path / "root"
    nested = root / "nested"
    nested.mkdir(parents=True)
    (nested / "entry.txt").write_text("entry")
    entered_nested = Event()
    release_scandir = Event()
    original_scandir = scan.os.scandir

    def gated_scandir(path):
        if Path(path) == nested:
            entered_nested.set()
            assert release_scandir.wait(timeout=15)
        return original_scandir(path)

    monkeypatch.setattr(scan.os, "scandir", gated_scandir)
    stop = Event()
    # 给线程池线程充分时间进入受控目录；超时仍会发生在真实遍历阻塞期间。
    timeout = 10 if stop_mode == "timeout" else 20
    with ThreadPoolExecutor(max_workers=1) as executor:
        task = asyncio.create_task(run_scan_in_thread(
            executor,
            root,
            temp_directory=tmp_path / "tmp",
            stop_event=stop,
            max_manifest_bytes=1024 * 1024,
            timeout_seconds=timeout,
        ))
        assert await asyncio.to_thread(entered_nested.wait, 12)
        if stop_mode == "cancel":
            task.cancel()
            assert await asyncio.to_thread(stop.wait, 1)
        else:
            assert await asyncio.to_thread(stop.wait, 11)
        assert not task.done()
        release_scandir.set()
        expected = asyncio.CancelledError if stop_mode == "cancel" else ScanTimedOut
        with pytest.raises(expected):
            await task

    assert list((tmp_path / "tmp").glob("gugu-filesync-*.sqlite")) == []


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


@pytest.mark.asyncio
@pytest.mark.parametrize("stop_mode", ["cancel", "timeout"])
async def test_cancel_during_real_file_hash_chunk_joins_thread_and_removes_manifest(
    tmp_path: Path, monkeypatch, stop_mode: str,
):
    import app.services.filesync.scan as scan

    root = tmp_path / "root"
    root.mkdir()
    (root / "large.bin").write_bytes(b"x" * (24 * 1024 * 1024))
    chunk_read = Event()
    release_reader = Event()
    original_fdopen = scan.os.fdopen

    class GatedReader:
        def __init__(self, stream):
            self.stream = stream
            self.gated = False

        def __enter__(self):
            self.stream.__enter__()
            return self

        def __exit__(self, *args):
            return self.stream.__exit__(*args)

        def read(self, size=-1):
            value = self.stream.read(size)
            if value and not self.gated:
                self.gated = True
                chunk_read.set()
                assert release_reader.wait(timeout=3)
            return value

    def fdopen(descriptor, mode="r", *, closefd=True):
        stream = original_fdopen(descriptor, mode, closefd=closefd)
        return GatedReader(stream) if mode == "rb" else stream

    monkeypatch.setattr(scan.os, "fdopen", fdopen)
    stop = Event()
    with ThreadPoolExecutor(max_workers=1) as executor:
        task = asyncio.create_task(run_scan_in_thread(
            executor,
            root,
            temp_directory=tmp_path / "tmp",
            stop_event=stop,
            max_manifest_bytes=8 * 1024 * 1024,
            # 给工作线程稳定进入真实分块读取的时间，再验证超时能否 join。
            timeout_seconds=1 if stop_mode == "timeout" else 10,
        ))
        assert await asyncio.to_thread(chunk_read.wait, 2)
        if stop_mode == "cancel":
            task.cancel()
        assert await asyncio.to_thread(stop.wait, 1)
        assert not task.done()
        release_reader.set()
        expected = asyncio.CancelledError if stop_mode == "cancel" else ScanTimedOut
        with pytest.raises(expected):
            await task

    assert list((tmp_path / "tmp").glob("gugu-filesync-*.sqlite")) == []


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
