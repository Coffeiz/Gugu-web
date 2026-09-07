from pathlib import Path

from scripts.migrate_storage_root import MIGRATION_MARKER, migrate_tree


def test_migrate_tree_copies_nested_compose_data_and_is_idempotent(tmp_path: Path):
    source = tmp_path / "legacy-volume"
    target = tmp_path / "Gugu-data"
    (source / "users" / "user-a" / ".agent").mkdir(parents=True)
    (source / "byok").mkdir()
    (source / "users" / "user-a" / ".agent" / "memory.md").write_text("旧记忆", encoding="utf-8")
    (source / "byok" / ".byok-master-key").write_bytes(b"test-key")

    assert migrate_tree(source, target, apply=True) == (2, 2, 0)
    assert (target / "users" / "user-a" / ".agent" / "memory.md").read_text(encoding="utf-8") == "旧记忆"
    assert (target / "byok" / ".byok-master-key").read_bytes() == b"test-key"
    assert (target / MIGRATION_MARKER).is_file()

    # 迁移后目标目录已经投入使用；旧 volume 保持 v1，不应在重启/升级时制造冲突。
    (target / "users" / "user-a" / ".agent" / "memory.md").write_text("新记忆", encoding="utf-8")
    assert migrate_tree(source, target, apply=True) == (0, 0, 0)
    assert (target / "users" / "user-a" / ".agent" / "memory.md").read_text(encoding="utf-8") == "新记忆"


def test_migrate_tree_stops_on_conflict_without_overwriting(tmp_path: Path):
    source = tmp_path / "legacy-volume"
    target = tmp_path / "Gugu-data"
    source.mkdir()
    target.mkdir()
    (source / "users.db").write_text("legacy", encoding="utf-8")
    (target / "users.db").write_text("current", encoding="utf-8")

    assert migrate_tree(source, target, apply=True) == (1, 0, 1)
    assert (target / "users.db").read_text(encoding="utf-8") == "current"
