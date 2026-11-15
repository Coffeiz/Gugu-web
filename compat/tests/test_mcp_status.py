"""MCP入口状态实际Python handler和动态配置对照，不连接server。"""
import asyncio
from app.core import config
from app.api.v1 import mcp_settings


def test_mcp_status_settings_priority_and_reload(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setattr(config, "OVERRIDE_FILE", path)
    monkeypatch.setattr(mcp_settings, "get_settings", lambda: config.AppSettings().apply_override())
    for key in ["MCP", "MCP__ENABLED"]:
        monkeypatch.delenv(key, raising=False)

    def read():
        return asyncio.run(mcp_settings.mcp_status(None))

    path.write_text("{}")
    assert read() == {"enabled": True}
    monkeypatch.setenv("MCP", '{"enabled":false}')
    assert read() == {"enabled": False}
    monkeypatch.setenv("MCP__ENABLED", "true")
    assert read() == {"enabled": True}
    path.write_text('{"mcp":{"enabled":false}}')
    assert read() == {"enabled": False}
    path.write_text('{"mcp":{"enabled":true}}')
    assert read() == {"enabled": True}
