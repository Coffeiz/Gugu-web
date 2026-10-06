"""显式运行的 100k 合成目录压力回归：GUGU_RUN_FILESYNC_STRESS=1。"""
from __future__ import annotations

import os
import tracemalloc
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.services.filesync.scan import scan_binding_tree
from app.services.filesync import checkpoint


@pytest.mark.skipif(
    os.environ.get("GUGU_RUN_FILESYNC_STRESS") != "1",
    reason="100k 文件压力测试需显式设置 GUGU_RUN_FILESYNC_STRESS=1",
)
def test_scanner_handles_one_hundred_thousand_synthetic_files(tmp_path, monkeypatch):
    storage_root = tmp_path / "storage"
    storage_root.mkdir()
    monkeypatch.setattr(checkpoint, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(storage_root)),
    ))
    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    for directory_index in range(10):
        directory = root / f"group-{directory_index:03d}"
        directory.mkdir(parents=True)
        for file_index in range(10_000):
            (directory / f"item-{file_index:04d}.txt").touch()

    store = checkpoint.ScanCheckpointStore(uuid4(), 1, uuid4())
    state = {}
    tracemalloc.start()
    for _ in range(1_000):
        store.begin_scan_segment()
        result = scan_binding_tree(
            root, user_root=user_root, checkpoint_state=state,
            checkpoint_entries=store.entries,
            checkpoint_queue=store.pending_directories,
            max_entries=1_000,
        )
        if result.complete:
            store.commit_scan_segment({"scan_complete": True})
            break
        assert result.checkpoint_state is not None
        state = result.checkpoint_state
        store.commit_scan_segment(state)
    else:
        tracemalloc.stop()
        pytest.fail("十万项扫描未能在 1000 个持久片段内完成")
    _, peak_python_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert result.complete
    assert result.file_count == 100_000
    assert result.directory_count == 10
    assert len(result.entries) == 100_010
    assert result.entries is store.entries
    assert peak_python_bytes < 24 * 1024 * 1024, (
        f"十万项扫描的 Python 峰值内存过高：{peak_python_bytes / 1024 / 1024:.1f} MiB"
    )
    store.close()
