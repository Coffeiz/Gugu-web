from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from app.services.filesync.plan import build_reconcile_plan, iter_success_baseline_entries
from app.services.filesync.scan import ScanControl, ScanEntry, scan_binding_tree


def test_importing_scanner_does_not_load_database_or_orm_modules():
    """纯扫描调用方导入扫描器时不应初始化 ORM 或数据库依赖。"""
    backend_root = Path(__file__).resolve().parents[1]
    environment = os.environ.copy()
    existing_pythonpath = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(backend_root), existing_pythonpath) if part
    )
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import app.services.filesync.scan, sys; "
            "assert 'sqlalchemy' not in sys.modules; "
            "assert 'app.models' not in sys.modules",
        ],
        cwd=backend_root,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_unchanged_snapshot_reuses_fingerprint_and_full_check_rehashes(tmp_path):
    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    root.mkdir(parents=True)
    (root / "note.txt").write_text("stable content", encoding="utf-8")

    first = scan_binding_tree(root, user_root=user_root)
    assert first.complete
    assert first.file_count == 1
    assert first.hashed_count == 1

    second = scan_binding_tree(root, user_root=user_root, previous=first.entries)
    plan = build_reconcile_plan(second, first.entries)
    assert second.complete
    assert second.hashed_count == 0
    assert plan.added == frozenset()
    assert plan.changed == frozenset()
    assert plan.missing == frozenset()
    assert plan.unchanged == frozenset({"note.txt"})

    integrity = scan_binding_tree(
        root, user_root=user_root, previous=second.entries, integrity_full=True,
    )
    assert integrity.complete
    assert integrity.hashed_count == 1
    assert build_reconcile_plan(integrity, second.entries).changed == frozenset()


def test_complete_scan_can_infer_deleted_paths(tmp_path):
    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    root.mkdir(parents=True)
    previous = {"unseen.txt": ScanEntry("unseen.txt", "file", 1, 1, 1, "old")}
    result = scan_binding_tree(root, user_root=user_root)
    plan = build_reconcile_plan(result, previous)
    assert result.complete
    assert plan.missing == frozenset({"unseen.txt"})


def test_cancelled_scan_is_incomplete_and_cannot_infer_deletion(tmp_path):
    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    root.mkdir(parents=True)
    stop = threading.Event()
    stop.set()
    previous = {"old.txt": ScanEntry("old.txt", "file", 1, 1, 1, "old")}

    result = scan_binding_tree(
        root,
        user_root=user_root,
        previous=previous,
        control=ScanControl(time.monotonic() + 10, stop),
    )
    plan = build_reconcile_plan(result, previous)
    assert not result.complete
    assert result.error_code == "cancelled"
    assert plan.missing == frozenset()


def test_scan_rejects_root_outside_user_scope(tmp_path):
    user_root = tmp_path / "synthetic-user"
    outside = tmp_path / "outside"
    outside.mkdir()
    result = scan_binding_tree(outside, user_root=user_root)
    assert not result.complete
    assert result.error_code == "invalid_root"


def test_segmented_scan_resumes_directory_cursor_without_losing_entries(tmp_path):
    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    (root / "nested").mkdir(parents=True)
    (root / "a.txt").write_text("a", encoding="utf-8")
    (root / "nested" / "b.txt").write_text("b", encoding="utf-8")
    (root / "nested" / "c.txt").write_text("c", encoding="utf-8")

    expected = scan_binding_tree(root, user_root=user_root)
    state = None
    candidate = {}
    for _ in range(10):
        result = scan_binding_tree(
            root, user_root=user_root, checkpoint_state=state,
            checkpoint_entries=candidate, max_entries=1,
        )
        if result.complete:
            break
        assert result.error_code == "slice_expired"
        state = result.checkpoint_state
        candidate.update(result.checkpoint_entries or {})
    else:
        pytest.fail("目录游标未能在有限片段内完成")

    assert result.complete
    assert result.entries == expected.entries
    assert result.file_count == expected.file_count == 3


def test_directory_mutation_during_enumeration_restarts_only_that_scope(monkeypatch, tmp_path):
    from app.services.filesync import scan as scan_module

    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    root.mkdir(parents=True)
    (root / "existing.txt").write_text("existing", encoding="utf-8")
    real_scandir = scan_module.os.scandir
    changed = False

    class MutatingIterator:
        def __init__(self, path):
            self._iterator = real_scandir(path)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            self._iterator.close()

        def __iter__(self):
            nonlocal changed
            yield from self._iterator
            if not changed:
                changed = True
                (root / "added-during-scan.txt").write_text("new", encoding="utf-8")

    monkeypatch.setattr(scan_module.os, "scandir", MutatingIterator)
    result = scan_module.scan_binding_tree(root, user_root=user_root)

    assert result.complete
    assert set(result.entries) == {"existing.txt", "added-during-scan.txt"}


def test_resumed_directory_revalidates_already_seen_file_metadata(tmp_path):
    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    root.mkdir(parents=True)
    first_file = root / "first.txt"
    first_file.write_text("before", encoding="utf-8")
    (root / "second.txt").write_text("second", encoding="utf-8")

    first = scan_binding_tree(root, user_root=user_root, max_entries=1)
    assert not first.complete
    first_path = next(iter(first.checkpoint_entries))
    old_fingerprint = first.checkpoint_entries[first_path].fingerprint
    (root / first_path).write_text("after with a different body", encoding="utf-8")

    resumed = scan_binding_tree(
        root, user_root=user_root,
        checkpoint_state=first.checkpoint_state,
        checkpoint_entries=first.checkpoint_entries,
        max_entries=10,
    )

    assert resumed.complete
    assert resumed.entries[first_path].fingerprint != old_fingerprint


def test_large_file_hash_resumes_from_bounded_digest_frontier(tmp_path):
    from app.services.filesync.scan import _ScanStopped

    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    root.mkdir(parents=True)
    payload = b"chunk-data" * 400_000
    (root / "large.bin").write_bytes(payload)

    class StopAfterOneChunk:
        checks = 0

        def check(self):
            self.checks += 1
            if self.checks >= 5:
                raise _ScanStopped("slice_expired")

    first = scan_binding_tree(
        root, user_root=user_root, hash_chunk_bytes=1_000_000,
        control=StopAfterOneChunk(),
    )
    assert not first.complete
    hash_state = first.checkpoint_state["hash_state"]
    assert hash_state["offset"] == 1_000_000
    assert len(hash_state["digest_stack"]) <= 64
    assert len(hash_state["digest_stack"]) < 10

    resumed = scan_binding_tree(
        root, user_root=user_root, hash_chunk_bytes=1_000_000,
        checkpoint_state=first.checkpoint_state,
        checkpoint_entries=first.checkpoint_entries,
        control=ScanControl(float("inf"), threading.Event()),
    )
    uninterrupted = scan_binding_tree(
        root, user_root=user_root, hash_chunk_bytes=1_000_000,
    )
    assert resumed.complete
    assert resumed.entries["large.bin"].fingerprint == uninterrupted.entries["large.bin"].fingerprint


@pytest.mark.skipif(not hasattr(__import__("os"), "symlink"), reason="平台不支持符号链接")
def test_symlink_is_skipped_without_following_or_deleting_protected_paths(tmp_path):
    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    root.mkdir(parents=True)
    target = user_root / "outside.txt"
    target.write_text("outside", encoding="utf-8")
    (root / "link.txt").symlink_to(target)
    outside_dir = tmp_path / "outside-dir"
    outside_dir.mkdir()
    (outside_dir / "secret.txt").write_text("secret", encoding="utf-8")
    (root / "linked-dir").symlink_to(outside_dir, target_is_directory=True)
    previous = {
        "known.txt": ScanEntry("known.txt", "file", 1, 1, 1, "a" * 64),
        "linked-dir/secret.txt": ScanEntry("linked-dir/secret.txt", "file", 6, 1, 1, "b" * 64),
    }

    result = scan_binding_tree(root, user_root=user_root, previous=previous)
    plan = build_reconcile_plan(result, previous)
    assert result.complete
    assert result.error_code is None
    assert result.excluded_count == 2
    assert "linked-dir/secret.txt" not in result.entries
    assert "link.txt" not in plan.added
    assert plan.missing == frozenset({"known.txt"})
    assert dict(iter_success_baseline_entries(
        result.entries, previous, preserve_missing=False,
    ))["linked-dir/secret.txt"] == previous["linked-dir/secret.txt"]


@pytest.mark.skipif(not hasattr(__import__("os"), "symlink"), reason="平台不支持符号链接")
def test_replacing_scanned_directory_with_symlink_drops_stale_candidates(tmp_path):
    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    linked = root / "tool"
    linked.mkdir(parents=True)
    (linked / "old.txt").write_text("old", encoding="utf-8")
    previous_scan = scan_binding_tree(root, user_root=user_root)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "private.txt").write_text("private", encoding="utf-8")
    (linked / "old.txt").unlink()
    linked.rmdir()
    linked.symlink_to(outside, target_is_directory=True)

    result = scan_binding_tree(root, user_root=user_root, previous=previous_scan.entries)

    assert result.complete
    assert result.excluded_count == 1
    assert "tool/old.txt" not in result.entries
    assert "tool/private.txt" not in result.entries
