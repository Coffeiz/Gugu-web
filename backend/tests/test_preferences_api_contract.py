"""PRD-LLM-15 Phase 1：人格偏好后端边界与 snapshot 注入。"""

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from agent.context import builder
from app.schemas import PreferencesUpdate
from app.services import personality_preferences as service


def test_personality_preference_is_bounded_and_normalized():
    assert PreferencesUpdate(personalityPreference="  叫我小北  ").personalityPreference == "叫我小北"
    assert len(PreferencesUpdate(personalityPreference="x" * 10000).personalityPreference) == 10000
    with pytest.raises(ValidationError):
        PreferencesUpdate(personalityPreference="x" * 10001)
    with pytest.raises(ValidationError):
        PreferencesUpdate(personalityPreference="正常\x01文本")


def test_personality_file_is_user_scoped_and_written_atomically(tmp_path, monkeypatch):
    monkeypatch.setattr(
        service,
        "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path))),
    )
    assert service.write_personality_file(7, "叫我小北") is True
    path = tmp_path / "7" / ".agent" / "prompt" / "persona.md"
    assert path.read_text(encoding="utf-8") == "叫我小北"
    assert service.read_personality_file(7) == "叫我小北"
    assert service.read_personality_file(8) is None
    assert service.write_personality_file(7, None) is True
    assert not path.exists()


def test_personality_is_in_static_prompt_only_when_enabled(monkeypatch):
    monkeypatch.setattr(
        service,
        "get_settings",
        lambda: SimpleNamespace(agent=SimpleNamespace(personality_preference_enabled=True)),
    )
    static, dynamic, _ = builder.build_split(
        "default",
        "测试用户",
        [],
        [],
        style_prefs={
            "personality_preference": "称呼我为小北，回答先给结论。",
            "personality_preference_enabled": True,
        },
    )

    assert static.startswith("## 当前交流语言")
    assert "称呼我为小北，回答先给结论。" in static
    assert "<user-preference>" not in static
    assert "## 咕咕人格（用户自定义）" not in static
    assert "## 你能做什么" not in static
    assert "用户人格偏好" not in dynamic

    disabled_static, _, _ = builder.build_split(
        "default",
        "测试用户",
        [],
        [],
        style_prefs={
            "personality_preference": "称呼我为小北",
            "personality_preference_enabled": False,
        },
    )
    assert "称呼我为小北" not in disabled_static


def test_empty_personality_keeps_default_persona(monkeypatch):
    monkeypatch.setattr(
        service,
        "get_settings",
        lambda: SimpleNamespace(agent=SimpleNamespace(personality_preference_enabled=True)),
    )
    static, _, _ = builder.build_split(
        "default", "测试用户", [], [],
        style_prefs={"personality_preference": "", "personality_preference_enabled": True},
    )
    assert "## 你能做什么" in static
