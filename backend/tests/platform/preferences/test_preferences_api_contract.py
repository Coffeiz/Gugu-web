"""PRD-LLM-15 Phase 1：人格偏好后端边界与 snapshot 注入。"""

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from agent.context import builder
from app.schemas import PreferencesUpdate, ReplyStyleUpdate
from app.services import personality_preferences as service


def test_personality_preference_is_bounded_and_normalized():
    assert PreferencesUpdate(personalityPreference="  叫我小北  ").personalityPreference == "叫我小北"
    assert len(PreferencesUpdate(personalityPreference="x" * 10000).personalityPreference) == 10000
    with pytest.raises(ValidationError):
        PreferencesUpdate(personalityPreference="x" * 10001)
    with pytest.raises(ValidationError):
        PreferencesUpdate(personalityPreference="正常\x01文本")
    assert PreferencesUpdate(groupPersonalityPreference="  群聊人格  ").groupPersonalityPreference == "群聊人格"
    with pytest.raises(ValidationError):
        PreferencesUpdate(groupPersonalityPreference="x" * 10001)
    assert ReplyStyleUpdate(content="  先给结论  ").content == "先给结论"
    with pytest.raises(ValidationError):
        ReplyStyleUpdate(content="正常\x01文本")


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


def test_reply_style_file_sits_beside_persona_and_is_user_scoped(tmp_path, monkeypatch):
    monkeypatch.setattr(
        service,
        "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path))),
    )
    assert service.write_reply_style_file(7, "先给结论") is True
    path = tmp_path / "7" / ".agent" / "prompt" / "reply-style.md"
    assert path.read_text(encoding="utf-8") == "先给结论"
    assert path.parent == service.personality_file_path(7).parent
    assert service.read_reply_style_file(7) == "先给结论"
    assert service.read_reply_style_file(8) is None
    assert service.write_reply_style_file(7, None) is True
    assert not path.exists()


def test_group_personality_file_is_separate_and_user_scoped(tmp_path, monkeypatch):
    monkeypatch.setattr(
        service,
        "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path))),
    )
    assert service.write_personality_file(7, "个人只在私聊使用") is True
    assert service.write_group_personality_file(7, "群聊使用的设定") is True
    group_path = tmp_path / "7" / ".agent" / "prompt" / "group-persona.md"
    assert group_path.read_text(encoding="utf-8") == "群聊使用的设定"
    assert group_path != service.personality_file_path(7)
    assert service.read_group_personality_file(7) == "群聊使用的设定"
    assert service.read_group_personality_file(8) is None
    assert service.write_group_personality_file(7, None) is True
    assert not group_path.exists()


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

    assert "## 当前交流语言" in static
    assert "称呼我为小北，回答先给结论。" in static
    assert "<user-preference>" not in static
    assert "## 咕咕人格（用户自定义）" not in static
    assert "## 1. 做事" not in static
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
    assert "## 1. 做事" in static
