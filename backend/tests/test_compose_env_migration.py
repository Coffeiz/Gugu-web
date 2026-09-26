"""默认 Compose 升级时迁移旧应用 env，且不覆盖新版持久化配置。"""

import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_SCRIPT = REPO_ROOT / "scripts" / "migrate-compose-env.sh"


def _run_migration(source: Path, target: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(MIGRATION_SCRIPT), str(source), str(target)],
        capture_output=True,
        check=False,
        text=True,
    )


def test_old_backend_env_fills_missing_keys_without_overwriting_data_env(tmp_path: Path):
    source = tmp_path / "backend" / ".env"
    target = tmp_path / "Gugu-data" / ".env"
    source.parent.mkdir()
    target.parent.mkdir()
    source.write_text(
        "ADMIN_PASSWORD=legacy-admin\n"
        "SECRET_KEY=legacy-secret\n"
        "DB__PASSWORD=legacy-db\n"
        "PROVIDER__API_KEY=legacy-provider-key\n",
        encoding="utf-8",
    )
    original = "ADMIN_PASSWORD=newer-admin\nDB__PASSWORD=newer-db\n"
    target.write_text(original, encoding="utf-8")
    target.chmod(0o640)

    result = _run_migration(source, target)

    assert result.returncode == 0, result.stderr
    migrated = target.read_text(encoding="utf-8")
    assert "ADMIN_PASSWORD=newer-admin" in migrated
    assert "DB__PASSWORD=newer-db" in migrated
    assert "SECRET_KEY=legacy-secret" in migrated
    assert "PROVIDER__API_KEY=legacy-provider-key" in migrated
    assert migrated.count("ADMIN_PASSWORD=") == 1
    assert target.stat().st_mode & 0o777 == 0o600
    backups = list(target.parent.glob(".env.pre-migration-*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == original
    assert backups[0].stat().st_mode & 0o777 == 0o600
    assert "legacy-admin" not in result.stdout + result.stderr
    assert "legacy-provider-key" not in result.stdout + result.stderr


def test_old_backend_env_initializes_missing_data_env_with_private_permissions(tmp_path: Path):
    source = tmp_path / "backend.env"
    target = tmp_path / "data" / ".env"
    source.write_text("ADMIN_PASSWORD=synthetic-password\nSECRET_KEY=synthetic-secret\n", encoding="utf-8")

    result = _run_migration(source, target)

    assert result.returncode == 0, result.stderr
    assert target.read_text(encoding="utf-8") == source.read_text(encoding="utf-8")
    assert target.stat().st_mode & 0o777 == 0o600
    assert not list(target.parent.glob(".env.pre-migration-*"))


def test_empty_data_env_is_filled_from_legacy_config(tmp_path: Path):
    source = tmp_path / "backend.env"
    target = tmp_path / "data" / ".env"
    target.parent.mkdir()
    source.write_text("ADMIN_PASSWORD=synthetic-password\n", encoding="utf-8")
    target.write_text("", encoding="utf-8")

    result = _run_migration(source, target)

    assert result.returncode == 0, result.stderr
    assert target.read_text(encoding="utf-8") == source.read_text(encoding="utf-8")


def test_missing_legacy_env_does_not_create_new_persistent_config(tmp_path: Path):
    source = tmp_path / "missing.env"
    target = tmp_path / "data" / ".env"

    result = _run_migration(source, target)

    assert result.returncode == 0
    assert not target.exists()
