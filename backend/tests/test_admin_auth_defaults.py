"""管理员默认凭据与环境变量覆盖的回归测试。"""
from __future__ import annotations

from app.core.config import AppSettings


def test_admin_default_credentials_are_admin_and_guguadmin(monkeypatch):
    monkeypatch.delenv("ADMIN_USERNAME", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)

    settings = AppSettings()

    assert settings.admin_username == "admin"
    assert settings.admin_password == "guguadmin"


def test_admin_credentials_can_be_overridden_by_environment(monkeypatch):
    monkeypatch.setenv("ADMIN_USERNAME", "deploy-admin")
    monkeypatch.setenv("ADMIN_PASSWORD", "deployment-secret")

    settings = AppSettings()

    assert settings.admin_username == "deploy-admin"
    assert settings.admin_password == "deployment-secret"
