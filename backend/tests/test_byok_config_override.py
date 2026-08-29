"""BYOK 配置覆盖应保持为强类型设置对象。"""

import json

from app.core import config


def test_byok_is_enabled_by_default():
    assert config.AppSettings().byok.enabled is True


def test_byok_override_is_parsed_as_settings_model(tmp_path, monkeypatch):
    override = tmp_path / "config.override.json"
    override.write_text(json.dumps({"byok": {"enabled": True}}), encoding="utf-8")
    monkeypatch.setattr(config, "OVERRIDE_FILE", override)

    settings = config.AppSettings().apply_override()

    assert settings.byok.enabled is True
    assert isinstance(settings.byok, config.BYOKSettings)
