"""存量 LLM 预设不合规时，不得让整份 config.override.json 回落默认值。

回归背景：1.2.3 给 AIPresetItem 加了「max_tokens < context_tokens」校验，而 1.2.2 及更早
写下的预设没有这条约束。升级后加载期硬校验失败 → 整份 override 被丢弃 → 模型配置回落
默认云端地址，内网部署（如本地 vLLM）每次调用都报错，回退 1.2.2 才恢复。
"""
import json

import pytest

from app.core import config

LOCAL_BASE_URL = "http://10.0.0.8:8000/v1"
LEGACY_PRESET = {
    "id": "legacy", "name": "内网模型", "provider": "local", "api_key": "sk-legacy-secret",
    "base_url": LOCAL_BASE_URL, "model": "local-model",
    "max_tokens": 8000, "context_tokens": 8000,
}
VALID_PRESET = {
    "id": "valid", "name": "合规预设", "provider": "local",
    "base_url": LOCAL_BASE_URL, "model": "local-model",
    "max_tokens": 4000, "context_tokens": 32000,
}


def _apply(tmp_path, monkeypatch, override: dict):
    path = tmp_path / "config.override.json"
    path.write_text(json.dumps(override, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(config, "OVERRIDE_FILE", path)
    return config.AppSettings().apply_override()


def test_legacy_invalid_preset_does_not_discard_whole_override(tmp_path, monkeypatch):
    """升级后原样不动的旧文件：ai 段和其他段必须照常生效，运行时仍指向用户配置的地址。"""
    settings = _apply(tmp_path, monkeypatch, {
        "ai": {"provider": "local", "base_url": LOCAL_BASE_URL, "model": "local-model",
               "max_tokens": 8000, "context_tokens": 8000},
        "ai_presets": {"active_id": "legacy", "items": [LEGACY_PRESET]},
        "mcp": {"enabled": False},
    })

    assert settings.ai.provider == "local"
    assert settings.ai.base_url == LOCAL_BASE_URL
    assert settings.mcp.enabled is False


def test_legacy_invalid_preset_is_kept_with_original_values(tmp_path, monkeypatch):
    """不合规预设按原值保留（不静默钳制、不丢弃），留给用户在后台修正。"""
    settings = _apply(tmp_path, monkeypatch, {
        "ai_presets": {"active_id": "legacy", "items": [LEGACY_PRESET]},
    })

    (item,) = settings.ai_presets.items
    assert isinstance(item, config.AIPresetItem)
    assert (item.id, item.max_tokens, item.context_tokens) == ("legacy", 8000, 8000)


def test_invalid_preset_does_not_block_valid_presets(tmp_path, monkeypatch):
    """「新建合规预设并激活、旧预设留着」是用户最自然的自救路径，不得因旧预设而失效。"""
    settings = _apply(tmp_path, monkeypatch, {
        "ai_presets": {"active_id": "valid", "items": [LEGACY_PRESET, VALID_PRESET]},
    })

    assert [item.id for item in settings.ai_presets.items] == ["legacy", "valid"]
    assert settings.ai_presets.active_id == "valid"


def test_invalid_preset_warning_names_preset_without_leaking_key(tmp_path, monkeypatch, capsys):
    """不合规必须响亮可见，但输出里只能有预设 id 和校验消息，不得带出 api_key。"""
    _apply(tmp_path, monkeypatch, {
        "ai_presets": {"active_id": "legacy", "items": [LEGACY_PRESET]},
    })

    out = capsys.readouterr().out
    assert "LLM 预设 'legacy' 未通过校验，已按原值加载" in out
    assert "最大输出 token 数必须小于模型总上下文窗口" in out
    assert "sk-legacy-secret" not in out


def test_save_path_validation_is_unchanged():
    """容错只发生在加载存量数据时；新建/保存路径的强校验不得被一并放宽。"""
    with pytest.raises(ValueError):
        config.AIPresetItem(id="new", max_tokens=8000, context_tokens=8000)
