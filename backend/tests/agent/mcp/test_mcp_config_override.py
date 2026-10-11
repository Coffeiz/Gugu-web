"""MCP 配置覆盖应保持为强类型设置对象（Admin 开关 MCP 写 override 后不得退化成 dict）。"""
import json

from app.core import config


def test_mcp_override_is_parsed_as_settings_model(tmp_path, monkeypatch):
    override = tmp_path / "config.override.json"
    override.write_text(json.dumps({"mcp": {"enabled": False}}), encoding="utf-8")
    monkeypatch.setattr(config, "OVERRIDE_FILE", override)

    settings = config.AppSettings().apply_override()

    assert isinstance(settings.mcp, config.McpSettings)
    assert settings.mcp.enabled is False
    # 其余字段保留模型默认值，而不是整段被原始 dict 顶掉
    assert settings.mcp.max_servers_per_user == 10


def test_mcp_override_defaults_untouched_without_section(tmp_path, monkeypatch):
    override = tmp_path / "config.override.json"
    override.write_text(json.dumps({"security": {}}), encoding="utf-8")
    monkeypatch.setattr(config, "OVERRIDE_FILE", override)

    settings = config.AppSettings().apply_override()

    assert isinstance(settings.mcp, config.McpSettings)
    assert settings.mcp.enabled is True
