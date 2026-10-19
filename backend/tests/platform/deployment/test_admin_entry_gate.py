import os
import subprocess
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[4] / "nginx" / "prepare-admin-entry.sh"


def _generate(
    tmp_path: Path,
    token: str | None,
    allowed_hosts: str | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["ADMIN_ENTRY_CONFIG_DIR"] = str(tmp_path)
    if token is None:
        env.pop("GUGU_ADMIN_ENTRY_PATH", None)
    else:
        env["GUGU_ADMIN_ENTRY_PATH"] = token
    if allowed_hosts is None:
        env.pop("GUGU_ADMIN_ALLOWED_HOSTS", None)
    else:
        env["GUGU_ADMIN_ALLOWED_HOSTS"] = allowed_hosts
    return subprocess.run(["sh", str(SCRIPT)], env=env, text=True, capture_output=True)


def test_unconfigured_entry_keeps_legacy_admin_access(tmp_path: Path) -> None:
    result = _generate(tmp_path, None)

    assert result.returncode == 0
    assert "default 1;" in (tmp_path / "admin-entry-http.conf").read_text()
    assert "default 1;" in (tmp_path / "admin-host-http.conf").read_text()
    assert (tmp_path / "admin-entry-server.conf").read_text() == ""


def test_secret_entry_requires_cookie_for_admin_and_emits_secure_cookie(tmp_path: Path) -> None:
    token = "a" * 43
    result = _generate(tmp_path, token)

    assert result.returncode == 0
    http_config = (tmp_path / "admin-entry-http.conf").read_text()
    server_config = (tmp_path / "admin-entry-server.conf").read_text()
    assert '"' + token + '" 1;' in http_config
    assert f"location = /{token}" in server_config
    assert 'if ($gugu_admin_host_ok = 0) { return 404; }' in server_config
    assert f"gugu_admin_entry={token}; Path=/; HttpOnly; Secure; SameSite=Strict" in server_config


def test_custom_short_entry_is_allowed(tmp_path: Path) -> None:
    result = _generate(tmp_path, "my-admin")

    assert result.returncode == 0
    assert "location = /my-admin" in (tmp_path / "admin-entry-server.conf").read_text()


def test_admin_host_allowlist_is_applied_to_frontend_and_entry_route(tmp_path: Path) -> None:
    result = _generate(tmp_path, "private-admin", "Admin.Example.com, ops.example.com")

    assert result.returncode == 0
    host_config = (tmp_path / "admin-host-http.conf").read_text()
    server_config = (tmp_path / "admin-entry-server.conf").read_text()
    assert 'map $host $gugu_admin_host_ok {' in host_config
    assert '"admin.example.com" 1;' in host_config
    assert '"ops.example.com" 1;' in host_config
    assert 'default 0;' in host_config
    assert 'if ($gugu_admin_host_ok = 0) { return 404; }' in server_config


@pytest.mark.parametrize(
    "allowed_hosts",
    ["admin.example.com; return 200;", "admin.example.com,,ops.example.com", "https://admin.example.com"],
)
def test_invalid_admin_host_allowlist_is_rejected_without_emitting_config(
    tmp_path: Path,
    allowed_hosts: str,
) -> None:
    result = _generate(tmp_path, "private-admin", allowed_hosts)

    assert result.returncode != 0
    assert not (tmp_path / "admin-host-http.conf").exists()
    assert not (tmp_path / "admin-entry-server.conf").exists()


@pytest.mark.parametrize("token", ["x" * 129, "custom/admin"])
def test_weak_or_unsafe_entry_path_is_rejected(tmp_path: Path, token: str) -> None:
    result = _generate(tmp_path, token)

    assert result.returncode != 0
    assert not (tmp_path / "admin-entry-server.conf").exists()
