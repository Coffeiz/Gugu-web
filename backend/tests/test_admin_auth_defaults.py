"""管理员凭据与环境变量覆盖的回归测试。"""
from __future__ import annotations

from app.core.config import AppSettings


def test_admin_password_has_no_public_default(monkeypatch):
    monkeypatch.delenv("ADMIN_USERNAME", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)

    # 默认值测试必须隔离部署目录的 .env，避免 devserver 凭据污染测试契约。
    settings = AppSettings(_env_file=None)

    assert settings.admin_username == "admin"
    assert settings.admin_password == ""


def test_admin_credentials_can_be_overridden_by_environment(monkeypatch):
    monkeypatch.setenv("ADMIN_USERNAME", "deploy-admin")
    monkeypatch.setenv("ADMIN_PASSWORD", "deployment-secret")

    settings = AppSettings()

    assert settings.admin_username == "deploy-admin"
    assert settings.admin_password == "deployment-secret"
