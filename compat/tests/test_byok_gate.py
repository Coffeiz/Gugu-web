"""只读策略优先级对照；配置全部位于pytest临时目录。"""
import json

from app.core import config


def test_byok_gate_priority_and_override_reload(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setattr(config, "OVERRIDE_FILE", path)
    for name in ["BYOK", "BYOK__ENABLED", "AI", "AI__DEPLOYMENT_MODE"]:
        monkeypatch.delenv(name, raising=False)

    def read():
        value = config.AppSettings().apply_override()
        return bool(value.byok.enabled or value.ai.deployment_mode == "local")

    path.write_text("{}")
    assert read() is True
    monkeypatch.setenv("BYOK", '{"enabled":false}')
    assert read() is False
    monkeypatch.setenv("BYOK__ENABLED", "true")
    assert read() is True
    monkeypatch.setenv("BYOK__ENABLED", "false")
    monkeypatch.setenv("AI", '{"deployment_mode":"local"}')
    assert read() is True
    monkeypatch.setenv("AI__DEPLOYMENT_MODE", "cloud")
    assert read() is False
    monkeypatch.setenv("BYOK__ENABLED", "true")
    monkeypatch.setenv("AI__DEPLOYMENT_MODE", "local")
    path.write_text(json.dumps({"byok":{"enabled":False}, "ai":{"deployment_mode":"cloud"}}))
    assert read() is False
    path.write_text(json.dumps({"byok":{"enabled":False}, "ai":{"deployment_mode":"local"}}))
    assert read() is True
