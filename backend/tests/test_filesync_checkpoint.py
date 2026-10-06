from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

from app.services.filesync import checkpoint
from app.services.filesync.scan import ScanEntry


def test_checkpoint_persists_cursor_and_resets_only_changed_directory(monkeypatch, tmp_path):
    storage_root = tmp_path / "users"
    storage_root.mkdir()
    monkeypatch.setattr(
        checkpoint, "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(storage_root))),
    )
    store = checkpoint.ScanCheckpointStore(uuid4(), 29, uuid4())
    entries = {
        "folder": ScanEntry("folder", "folder", 0, 1, 2, "a" * 64, 2),
        "folder/old.txt": ScanEntry("folder/old.txt", "file", 3, 4, 5, "b" * 64),
        "other.txt": ScanEntry("other.txt", "file", 6, 7, 8, "c" * 64),
    }
    store.save({"active_dir": "folder", "last_name": "old.txt"}, entries)
    store.block_paths(("folder/old.txt", "other.txt"))

    state, loaded = store.load()
    assert state == {"active_dir": "folder", "last_name": "old.txt"}
    assert loaded == entries

    store.save({"active_dir": "folder", "last_name": ""}, {
        "folder": ScanEntry("folder", "folder", 0, 9, 10, "d" * 64, 2),
        "folder/new.txt": ScanEntry("folder/new.txt", "file", 1, 2, 3, "e" * 64),
    }, reset_prefixes=("folder",))
    _, loaded = store.load()

    assert set(loaded) == {"folder", "folder/new.txt", "other.txt"}
    assert loaded["other.txt"] == entries["other.txt"]
    assert not store.is_blocked("folder/old.txt")
    assert store.is_blocked("other.txt")
    store.reset()
    assert store.blocked_count() == 0
    assert store.discard()
    assert not store._path.exists()


def test_pending_directory_queue_is_persisted_outside_cursor(monkeypatch, tmp_path):
    storage_root = tmp_path / "users"
    storage_root.mkdir()
    monkeypatch.setattr(
        checkpoint, "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(storage_root))),
    )
    run_id = uuid4()
    user_id = uuid4()
    store = checkpoint.ScanCheckpointStore(user_id, 30, run_id)
    store.begin_scan_segment()
    store.pending_directories.add("nested")
    store.pending_directories.add("other")
    store.commit_scan_segment({"queue_initialized": True})
    store.close()

    resumed = checkpoint.ScanCheckpointStore(user_id, 30, run_id)
    state, _ = resumed.load()
    assert state == {"queue_initialized": True}
    assert resumed.pending_directories.pop() == "other"
    assert resumed.pending_directories.pop() == "nested"
    assert len(resumed.pending_directories) == 0
    resumed.discard()
