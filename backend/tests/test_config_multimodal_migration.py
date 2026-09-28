"""运行配置的多模态字段一次性迁移。"""

import json
import os

import pytest

from app.core import config


def test_override_multimodal_migration_renames_keys_and_preserves_other_sections(tmp_path, monkeypatch):
    override_path = tmp_path / "config.override.json"
    original = {
        "db": {"host": "db.internal", "port": 5432},
        "ai": {
            "vision": True,
            "vision_video": True,
            "vision_audio": False,
            "vision_detail": "high",
            "capability_overrides": {"vision": True, "tools": True},
        },
        "ai_presets": {"active_id": "one", "items": [{
            "id": "one", "vision": True, "vision_video": False,
            "vision_audio": True, "vision_detail": "original",
        }]},
        "unrelated": {"keep": [1, 2, 3]},
    }
    raw = json.dumps(original, ensure_ascii=False, indent=2).encode()
    override_path.write_bytes(raw)
    override_path.chmod(0o640)
    monkeypatch.setattr(config, "OVERRIDE_FILE", override_path)
    backup_dir = tmp_path / "private-backups"
    monkeypatch.setattr(config, "_multimodal_override_backup_dir", lambda: backup_dir)

    config._migrate_multimodal_override()

    migrated = json.loads(override_path.read_text(encoding="utf-8"))
    assert migrated["ai"] == {
        "image": True, "video": True, "audio": False, "image_detail": "high",
        "capability_overrides": {"image": True, "tools": True},
    }
    assert migrated["ai_presets"]["items"][0] == {
        "id": "one", "image": True, "video": False, "audio": True,
        "image_detail": "original",
    }
    assert migrated["db"] == original["db"]
    assert migrated["unrelated"] == original["unrelated"]
    backups = list(backup_dir.glob("config.override.json.backup-multimodal-*"))
    assert len(backups) == 1
    assert list(tmp_path.glob("config.override.json.backup-multimodal-*")) == []
    assert not (tmp_path / ".config.override.json.multimodal-migration.lock").exists()
    assert backups[0].read_bytes() == raw
    assert os.stat(backups[0]).st_mode & 0o777 == 0o600
    assert os.stat(backup_dir).st_mode & 0o777 == 0o700
    assert os.stat(override_path).st_mode & 0o777 == 0o600


def test_override_multimodal_migration_is_idempotent(tmp_path, monkeypatch):
    override_path = tmp_path / "config.override.json"
    override_path.write_text(json.dumps({"ai": {"image": True}}), encoding="utf-8")
    monkeypatch.setattr(config, "OVERRIDE_FILE", override_path)
    monkeypatch.setattr(config, "_multimodal_override_backup_dir", lambda: tmp_path / "private-backups")

    config._migrate_multimodal_override()

    assert list((tmp_path / "private-backups").glob("*.backup-multimodal-*")) == []
    assert json.loads(override_path.read_text(encoding="utf-8")) == {"ai": {"image": True}}


def test_override_multimodal_migration_rejects_conflicts_without_rewriting(tmp_path, monkeypatch):
    override_path = tmp_path / "config.override.json"
    raw = json.dumps({"ai": {"vision": True, "image": False}}).encode()
    override_path.write_bytes(raw)
    monkeypatch.setattr(config, "OVERRIDE_FILE", override_path)
    monkeypatch.setattr(config, "_multimodal_override_backup_dir", lambda: tmp_path / "private-backups")

    with pytest.raises(ValueError, match="值冲突"):
        config._migrate_multimodal_override()

    assert override_path.read_bytes() == raw
    assert list((tmp_path / "private-backups").glob("*.backup-multimodal-*")) == []
