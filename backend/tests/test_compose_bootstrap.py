from pathlib import Path

import pytest

import compose_bootstrap
from compose_bootstrap import (
    ComposeConfigError,
    ensure_admin_password,
    ensure_secret_key,
    main,
    validate_required_config,
)


def _ensure_database_password(**kwargs):
    ensure = getattr(compose_bootstrap, "ensure_database_password", None)
    assert callable(ensure), "embedded single-container bootstrap must provide database password generation"
    ensure(**kwargs)


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


def test_validate_required_config_requires_external_database_password(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("SECRET_KEY=test-secret\n", encoding="utf-8")
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("GUGU_DB_PASSWORD", raising=False)
    monkeypatch.delenv("DB__PASSWORD", raising=False)

    with pytest.raises(ComposeConfigError, match="GUGU_DB_PASSWORD 未设置"):
        validate_required_config(
            env_file=env_file,
            data_dir=tmp_path / "data",
            host_data_dir="/srv/gugu-data",
        )


def test_embedded_database_password_is_generated_once_and_persisted(tmp_path: Path, monkeypatch, capsys):
    env_file = tmp_path / ".env"
    monkeypatch.delenv("GUGU_DB_PASSWORD", raising=False)
    monkeypatch.delenv("DB__PASSWORD", raising=False)

    _ensure_database_password(env_file=env_file, env_file_values={}, embedded=True)
    first = env_file.read_text(encoding="utf-8")
    password = first.split("DB__PASSWORD=", 1)[1].strip()
    assert len(password) >= 32
    assert password not in capsys.readouterr().out
    assert env_file.stat().st_mode & 0o077 == 0

    _ensure_database_password(env_file=env_file, env_file_values={"DB__PASSWORD": password}, embedded=True)
    assert env_file.read_text(encoding="utf-8") == first


def test_embedded_database_password_fills_existing_empty_assignment(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("DB__PASSWORD=\nOTHER_SETTING=preserve\n", encoding="utf-8")
    monkeypatch.delenv("GUGU_DB_PASSWORD", raising=False)
    monkeypatch.delenv("DB__PASSWORD", raising=False)

    _ensure_database_password(env_file=env_file, env_file_values={"DB__PASSWORD": ""}, embedded=True)

    values = env_file.read_text(encoding="utf-8")
    password = values.split("DB__PASSWORD=", 1)[1].splitlines()[0]
    assert len(password) >= 32
    assert "OTHER_SETTING=preserve" in values


def test_embedded_database_password_preserves_explicit_value_and_external_mode(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("DB__PASSWORD=configured-secret\n", encoding="utf-8")
    monkeypatch.delenv("GUGU_DB_PASSWORD", raising=False)
    monkeypatch.delenv("DB__PASSWORD", raising=False)

    _ensure_database_password(
        env_file=env_file,
        env_file_values={"DB__PASSWORD": "configured-secret"},
        embedded=True,
    )
    assert env_file.read_text(encoding="utf-8") == "DB__PASSWORD=configured-secret\n"

    _ensure_database_password(env_file=env_file, env_file_values={}, embedded=False)
    assert env_file.read_text(encoding="utf-8") == "DB__PASSWORD=configured-secret\n"


def test_embedded_database_password_maps_persisted_legacy_compose_key(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("GUGU_DB_PASSWORD=legacy-configured-secret\n", encoding="utf-8")
    monkeypatch.delenv("GUGU_DB_PASSWORD", raising=False)
    monkeypatch.delenv("DB__PASSWORD", raising=False)

    _ensure_database_password(
        env_file=env_file,
        env_file_values={"GUGU_DB_PASSWORD": "legacy-configured-secret"},
        embedded=True,
    )

    assert "DB__PASSWORD=legacy-configured-secret" in env_file.read_text(encoding="utf-8")


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


def test_main_generates_database_password_for_first_embedded_deployment(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    data_dir = tmp_path / "data"
    monkeypatch.setenv("GUGU_ENV_FILE", str(env_file))
    monkeypatch.setenv("GUGU_DATA_DIR", str(data_dir))
    monkeypatch.setenv("GUGU_EMBEDDED_DEPS", "1")
    monkeypatch.delenv("GUGU_DB_PASSWORD", raising=False)
    monkeypatch.delenv("DB__PASSWORD", raising=False)
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("ADMIN_USERNAME", raising=False)

    assert main() == 0
    contents = env_file.read_text(encoding="utf-8")
    password = contents.split("DB__PASSWORD=", 1)[1].splitlines()[0]
    assert len(password) >= 32
    assert "ADMIN_PASSWORD=" in contents


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
