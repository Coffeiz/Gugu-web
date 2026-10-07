from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.services.filesync import baseline
from app.services.filesync.scan import FINGERPRINT_VERSION, ScanEntry


def _store(monkeypatch, tmp_path):
    storage_root = tmp_path / "users"
    storage_root.mkdir()
    monkeypatch.setattr(
        baseline, "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(storage_root))),
    )
    return baseline.FileSyncBaselineStore(uuid4(), 17)


def test_baseline_generation_round_trips_without_absolute_paths(monkeypatch, tmp_path):
    store = _store(monkeypatch, tmp_path)
    entries = {
        "notes/today.md": ScanEntry("notes/today.md", "file", 12, 34, 56, "a" * 64),
        "notes": ScanEntry("notes", "folder", 0, 78, 90, fingerprint_version=FINGERPRINT_VERSION),
    }

    generation = store.stage(root_fingerprint="b" * 64, entries=entries)
    manifest = store.load(generation, expected_root_fingerprint="b" * 64)

    assert manifest.generation == generation
    assert manifest.entries == entries
    serialized = (store._path(generation) / "entries-000000.json").read_text(encoding="utf-8")
    assert str(tmp_path) not in serialized
    assert "notes/today.md" in serialized


def test_baseline_round_trips_skipped_symlink_marker(monkeypatch, tmp_path):
    store = _store(monkeypatch, tmp_path)
    marker = ScanEntry("node_modules/.bin", "excluded", 0, 78, 90, fingerprint_version=FINGERPRINT_VERSION)

    generation = store.stage(root_fingerprint="b" * 64, entries={marker.relative_path: marker})
    manifest = store.load(generation, expected_root_fingerprint="b" * 64)

    assert manifest.entries[marker.relative_path] == marker


def test_baseline_rejects_wrong_scope_and_tampered_manifest(monkeypatch, tmp_path):
    store = _store(monkeypatch, tmp_path)
    generation = store.stage(
        root_fingerprint="c" * 64,
        entries={"note.md": ScanEntry("note.md", "file", 1, 2, 3, "d" * 64)},
    )
    with pytest.raises(ValueError, match="绑定范围"):
        store.load(generation, expected_root_fingerprint="e" * 64)

    path = store._path(generation) / "manifest.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["entry_count"] = 2
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="校验"):
        store.load(generation, expected_root_fingerprint="c" * 64)


def test_baseline_detects_missing_or_corrupt_shard_without_mutating_generation(monkeypatch, tmp_path):
    store = _store(monkeypatch, tmp_path)
    generation = store.stage(
        root_fingerprint="c" * 64,
        entries={
            "note.md": ScanEntry("note.md", "file", 1, 2, 3, "d" * 64),
        },
    )
    shard = store._path(generation) / "entries-000000.json"
    shard.write_text("{}", encoding="utf-8")

    with pytest.raises(ValueError, match="分片校验"):
        store.load(generation, expected_root_fingerprint="c" * 64)
    assert store._path(generation).exists()


def test_baseline_rejects_unsafe_paths_and_invalid_file_fingerprints(monkeypatch, tmp_path):
    store = _store(monkeypatch, tmp_path)
    with pytest.raises(ValueError):
        store.stage(
            root_fingerprint="f" * 64,
            entries={"../outside": ScanEntry("../outside", "file", 1, 1, 1, "a" * 64)},
        )
    with pytest.raises(ValueError, match="指纹"):
        store.stage(
            root_fingerprint="f" * 64,
            entries={"note.md": ScanEntry("note.md", "file", 1, 1, 1, None)},
        )


def test_discard_removes_only_named_candidate_generation(monkeypatch, tmp_path):
    store = _store(monkeypatch, tmp_path)
    first = store.stage(
        root_fingerprint="a" * 64,
        entries={"first": ScanEntry("first", "file", 1, 1, 1, "1" * 64)},
    )
    second = store.stage(
        root_fingerprint="a" * 64,
        entries={"second": ScanEntry("second", "file", 1, 1, 1, "2" * 64)},
    )
    assert store.discard(first)
    assert not store.discard(first)
    assert store.load(second, expected_root_fingerprint="a" * 64).entries.keys() == {"second"}
