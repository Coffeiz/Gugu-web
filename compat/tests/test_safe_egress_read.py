"""安全出站读取的配置优先级对照，使用临时配置且禁用 dotenv。"""
import json

from app.core import config


def test_nested_environment_then_override_and_explicit_empty_secret(tmp_path, monkeypatch):
    monkeypatch.setenv("SAFE_EGRESS", json.dumps({"enabled": True, "proxy_url": "http://proxy.example.test:8080", "proxy_auth_secret": "synthetic-env-secret"}))
    monkeypatch.setenv("SAFE_EGRESS__ENABLED", "false")
    override = tmp_path / "config.json"
    monkeypatch.setattr(config, "OVERRIDE_FILE", override)
    before_override = config.AppSettings(_env_file=None).apply_override()
    assert before_override.safe_egress.enabled is False
    override.write_text(json.dumps({"safe_egress": {"enabled": True}}))
    merged = config.AppSettings(_env_file=None).apply_override()
    assert merged.safe_egress.enabled is True
    assert merged.safe_egress.proxy_url == "http://proxy.example.test:8080"
    assert merged.safe_egress.proxy_auth_secret == "synthetic-env-secret"
    override.write_text(json.dumps({"safe_egress": {"proxy_auth_secret": ""}}))
    assert config.AppSettings(_env_file=None).apply_override().safe_egress.proxy_auth_secret == ""


def test_read_preserves_legacy_url_path_query_and_fragment(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from app.api.v1 import safe_egress_admin
    proxy_url = "http://proxy.example.test:8080/status?mode=legacy#health"
    monkeypatch.setattr(safe_egress_admin, "get_settings", lambda: SimpleNamespace(
        safe_egress=config.SafeEgressSettings(enabled=False, proxy_url=proxy_url)))
    assert asyncio.run(safe_egress_admin.get_safe_egress_config()) == {
        "enabled": False, "proxy_url": proxy_url, "has_auth": False,
    }
