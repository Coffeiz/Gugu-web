"""一体化离线迁移须先形成可恢复备份，失败后不能接流量或伪装成功。"""
import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/runtime/offline_migration.sh"
ENTRYPOINT = Path(__file__).resolve().parents[1] / "docker-entrypoint.sh"


def _run(tmp_path, *, failure="", workspace_state="pending"):
    data = tmp_path / "data"
    (data / "users" / "synthetic-user" / "workspace").mkdir(parents=True)
    (data / "users" / "synthetic-user" / "workspace" / "kept.txt").write_text("original")
    tools = tmp_path / "bin"
    tools.mkdir()
    log = tmp_path / "calls"
    bodies = {
        "pg_dump": 'test "$FAILURE" != dump; for arg in "$@"; do case "$arg" in --file=*) printf backup > "${arg#--file=}" ;; esac; done',
        "pg_restore": "printf 'archive contents\\n'",
        "alembic": 'test "$FAILURE" != alembic',
        "python": 'if [[ "$*" == *--status* ]]; then printf "%s\\n" "$WORKSPACE_STATE"; elif [[ "$*" == *--apply* ]]; then test "$FAILURE" != layout; fi',
    }
    for name, body in bodies.items():
        tool = tools / name
        tool.write_text(f'#!/bin/bash\nset -e\nprintf "%s\\n" "{name} $*" >> "$CALL_LOG"\n{body}\n')
        tool.chmod(0o755)
    result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env={
        **os.environ, "PATH": f"{tools}:{os.environ['PATH']}", "GUGU_DATA_DIR": str(data),
        "GUGU_OFFLINE_PG_BIN": str(tools), "CALL_LOG": str(log), "FAILURE": failure,
        "WORKSPACE_STATE": workspace_state,
    })
    return result, data, log.read_text()


@pytest.mark.parametrize("failure", ["", "alembic", "layout"])
def test_offline_migration_preserves_backups_and_failure_state(tmp_path, failure):
    result, data, calls = _run(tmp_path, failure=failure)
    backup = next((data / "migration-backups").iterdir())
    assert (backup / "postgres.dump").read_bytes() == b"backup"
    archive = subprocess.run(["tar", "-xOf", str(backup / "users.tar"),
                              "users/synthetic-user/workspace/kept.txt"], capture_output=True)
    assert archive.returncode == 0 and archive.stdout == b"original"
    assert calls.index("pg_restore") < calls.index("alembic")
    assert (backup.stat().st_mode & 0o777) == 0o700
    if failure:
        assert result.returncode != 0
        assert (backup / "recovery-required").exists()
        assert "updater.database_check" not in calls
    else:
        assert result.returncode == 0, result.stderr
        assert "--status" in calls
        assert "--apply --services-stopped" in calls
        assert "--check" in calls and "updater.database_check" in calls
        assert not (backup / "recovery-required").exists()
    assert (data / "users/synthetic-user/workspace/kept.txt").read_text() == "original"


@pytest.mark.parametrize("workspace_state", ["completed", "empty"])
def test_offline_migration_skips_backup_when_layout_needs_no_migration(tmp_path, workspace_state):
    result, data, calls = _run(tmp_path, workspace_state=workspace_state)
    assert result.returncode == 0, result.stderr
    assert "--status" in calls
    assert "pg_dump" not in calls
    assert "alembic" not in calls
    assert "--apply" not in calls
    assert not (data / "migration-backups").exists()


def test_offline_migration_aborts_before_schema_changes_on_backup_failure(tmp_path):
    result, data, calls = _run(tmp_path, failure="dump")
    assert result.returncode != 0
    assert "alembic" not in calls
    assert (data / "users/synthetic-user/workspace/kept.txt").read_text() == "original"


@pytest.mark.parametrize("flags,unified,embedded", [
    ([], "1", "1"), (["--services-stopped"], "0", "1"),
    (["--services-stopped"], "1", "0"), (["--services-stopped"], "1", "1"),
])
def test_offline_entrypoint_rejects_invalid_mode_or_missing_database(tmp_path, flags, unified, embedded):
    result = subprocess.run(["bash", str(ENTRYPOINT), "gugu-offline-migrate", *flags],
                            capture_output=True, text=True, env={
        **os.environ, "GUGU_UNIFIED_APP": unified, "GUGU_EMBEDDED_DEPS": embedded,
        "GUGU_DATA_DIR": str(tmp_path),
    })
    assert result.returncode != 0
    assert "拒绝离线迁移" in result.stderr or "必须先停旧容器" in result.stderr
    assert list(tmp_path.iterdir()) == []
