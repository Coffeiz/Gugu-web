from pathlib import Path

import pytest

from standalone_bootstrap import (
    StandaloneConfigError,
    ensure_admin_password,
    validate_required_config,
)


def test_validate_required_config_reports_actionable_missing_secret(tmp_path: Path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("GUGU_DB_PASSWORD", raising=False)
    monkeypatch.delenv("DB__PASSWORD", raising=False)

    with pytest.raises(StandaloneConfigError, match="SECRET_KEY.*openssl rand -base64 32"):
        validate_required_config(
            env_file=tmp_path / ".env",
            data_dir=data_dir,
            host_data_dir=str(data_dir),
        )


def test_validate_required_config_reports_unwritable_data_dir(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("SECRET_KEY=secret\nGUGU_DB_PASSWORD=db-secret\n", encoding="utf-8")
    missing_data_dir = tmp_path / "missing-data"
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("GUGU_DB_PASSWORD", raising=False)
    monkeypatch.delenv("DB__PASSWORD", raising=False)

    with pytest.raises(StandaloneConfigError, match="用户数据目录不存在.*mkdir -p"):
        validate_required_config(
            env_file=env_file,
            data_dir=missing_data_dir,
            host_data_dir="/srv/gugu-data",
        )


def test_ensure_admin_password_appends_once_and_preserves_existing_field(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("ADMIN_USERNAME=synthetic-admin\n", encoding="utf-8")
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("ADMIN_USERNAME", raising=False)

    ensure_admin_password(env_file=env_file, env_file_values={"ADMIN_USERNAME": "synthetic-admin"})
    first = env_file.read_text(encoding="utf-8")
    assert first.count("ADMIN_PASSWORD=") == 1
    generated_password = first.split("ADMIN_PASSWORD=", 1)[1].strip()
    assert generated_password

    ensure_admin_password(env_file=env_file, env_file_values={"ADMIN_USERNAME": "synthetic-admin"})
    assert env_file.read_text(encoding="utf-8") == first

    env_file.write_text("ADMIN_PASSWORD=keep-me\n", encoding="utf-8")
    ensure_admin_password(env_file=env_file, env_file_values={"ADMIN_PASSWORD": "keep-me"})
    assert env_file.read_text(encoding="utf-8") == "ADMIN_PASSWORD=keep-me\n"
