"""Admin API 的域名限制应精确生效且不影响普通用户 API。"""

import json

import pytest

from app.core.admin_access import is_admin_api_host_allowed
from app.core import config
from app.core.config import AppSettings


@pytest.mark.parametrize(
    ("path", "host", "configured", "expected"),
    [
        ("/api/v1/admin/auth/login", "admin.example.com", "admin.example.com", True),
        ("/api/v1/admin/users", "ADMIN.EXAMPLE.COM.", " admin.example.com ", True),
        ("/api/v1/admin/users", "app.example.com", "admin.example.com", False),
        ("/api/v1/admin/auth/login", "admin.example.com", "https://admin.example.com", False),
        ("/api/v1/admin/auth/login", None, "admin.example.com", False),
        ("/api/v1/projects", "app.example.com", "admin.example.com", True),
        ("/api/v1/admin/auth/login", "app.example.com", "", True),
    ],
)
def test_admin_host_allowlist_is_exact_and_scoped_to_admin_api(
    path, host, configured, expected,
):
    assert is_admin_api_host_allowed(path, host, configured) is expected


def test_admin_host_allowlist_supports_idn_equivalent_hostnames():
    assert is_admin_api_host_allowed(
        "/api/v1/admin/auth/login",
        "xn--bcher-kva.example",
        "bücher.example",
    )


def test_admin_host_allowlist_reads_from_application_environment(monkeypatch):
    monkeypatch.setenv("ADMIN_ALLOWED_HOSTS", "admin.example.com, ops.example.com")

    settings = AppSettings(_env_file=None)

    assert settings.admin_allowed_hosts == "admin.example.com, ops.example.com"


def test_admin_host_allowlist_cannot_be_overridden_by_runtime_config(tmp_path, monkeypatch):
    override_file = tmp_path / "config.override.json"
    override_file.write_text(
        json.dumps({"admin_allowed_hosts": "untrusted.example.com"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "OVERRIDE_FILE", override_file)

    settings = AppSettings(_env_file=None, admin_allowed_hosts="admin.example.com")

    assert settings.apply_override().admin_allowed_hosts == "admin.example.com"


def test_admin_api_rejects_requests_on_non_admin_host(monkeypatch):
    from fastapi.testclient import TestClient

    from app import main

    monkeypatch.setattr(main.settings, "admin_allowed_hosts", "admin.example.com")
    client = TestClient(main.app, raise_server_exceptions=False)

    denied = client.get(
        "/api/v1/admin/auth/me",
        headers={"host": "app.example.com"},
    )
    allowed = client.get(
        "/api/v1/admin/auth/me",
        headers={"host": "admin.example.com"},
    )

    assert denied.status_code == 404
    assert allowed.status_code == 401
