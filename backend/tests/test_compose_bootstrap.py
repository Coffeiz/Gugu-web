from pathlib import Path

import pytest

from compose_bootstrap import (
    ComposeConfigError,
    ensure_admin_password,
    ensure_secret_key,
    main,
    validate_required_config,
)


def test_validate_required_config_reports_actionable_missing_secret(tmp_path: Path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("GUGU_DB_PASSWORD", raising=False)
    monkeypatch.delenv("DB__PASSWORD", raising=False)

    with pytest.raises(ComposeConfigError, match="SECRET_KEY.*openssl rand -base64 32"):
        validate_required_config(
            env_file=tmp_path / ".env",
            data_dir=data_dir,
            host_data_dir=str(data_dir),
        )


def test_validate_required_config_creates_missing_data_dir(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("SECRET_KEY=secret\nGUGU_DB_PASSWORD=db-secret\n", encoding="utf-8")
    missing_data_dir = tmp_path / "missing-data"
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("GUGU_DB_PASSWORD", raising=False)
    monkeypatch.delenv("DB__PASSWORD", raising=False)

    validate_required_config(
        env_file=env_file,
        data_dir=missing_data_dir,
        host_data_dir="/srv/gugu-data",
    )
    assert missing_data_dir.is_dir()


def test_ensure_secret_key_generates_once_and_preserves_existing_value(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("# generated config\n", encoding="utf-8")
    monkeypatch.delenv("SECRET_KEY", raising=False)

    ensure_secret_key(env_file=env_file, env_file_values={})
    first = env_file.read_text(encoding="utf-8")
    generated_key = first.split("SECRET_KEY=", 1)[1].strip()
    assert len(generated_key) >= 48

    ensure_secret_key(env_file=env_file, env_file_values={})
    assert env_file.read_text(encoding="utf-8") == first

    env_file.write_text("SECRET_KEY=keep-me\n", encoding="utf-8")
    ensure_secret_key(env_file=env_file, env_file_values={"SECRET_KEY": "keep-me"})
    assert env_file.read_text(encoding="utf-8") == "SECRET_KEY=keep-me\n"


def test_main_initializes_secret_and_data_dir(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    data_dir = tmp_path / "data"
    monkeypatch.setenv("GUGU_ENV_FILE", str(env_file))
    monkeypatch.setenv("GUGU_DATA_DIR", str(data_dir))
    monkeypatch.setenv("GUGU_DB_PASSWORD", "db-secret")
    monkeypatch.setenv("GUGU_EMBEDDED_DEPS", "0")
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("ADMIN_USERNAME", raising=False)

    assert main() == 0
    content = env_file.read_text(encoding="utf-8")
    assert len(content.split("SECRET_KEY=", 1)[1].splitlines()[0]) >= 48
    assert data_dir.is_dir()


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
