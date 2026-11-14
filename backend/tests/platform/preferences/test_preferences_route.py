from sqlalchemy import select
from types import SimpleNamespace

import pytest

from app.api.v1 import preferences as preferences_api
from app.models import UserPreferences
from app.schemas import PreferencesUpdate


def isolate_preference_files(monkeypatch):
    monkeypatch.setattr(
        preferences_api,
        "get_settings",
        lambda: SimpleNamespace(agent=SimpleNamespace(personality_preference_enabled=False)),
    )
    monkeypatch.setattr(preferences_api, "is_system_email_available", lambda: False)
    monkeypatch.setattr(preferences_api, "read_reply_style_file", lambda _user_id: None)
    monkeypatch.setattr(preferences_api, "read_personality_file", lambda _user_id: None)
    monkeypatch.setattr(preferences_api, "read_group_personality_file", lambda _user_id: None)


@pytest.mark.asyncio
async def test_preferences_route_returns_defaults_and_partially_updates_owner_json(db, user_a, monkeypatch):
    isolate_preference_files(monkeypatch)

    defaults = await preferences_api.get_preferences(user=user_a, db=db)
    assert defaults.locale is None
    assert defaults.theme == "light"
    assert defaults.themeFamily == "glass"
    assert defaults.palette == "neutral"
    assert defaults.lastStages == []
    assert defaults.stageTemplates == []
    assert defaults.automaticModeEnabled is False
    assert defaults.personalityPreferenceAvailable is False
    assert defaults.emailChangeEnabled is False

    changed = await preferences_api.update_preferences(
        body=PreferencesUpdate(
            locale="ja-JP",
            theme="dark",
            automaticModeEnabled=True,
            stageTemplates=[{"name": "合成模板"}],
        ),
        user=user_a,
        db=db,
    )
    assert changed.locale == "ja-JP"
    assert changed.theme == "dark"
    assert changed.automaticModeEnabled is True
    assert changed.stageTemplates == [{"name": "合成模板"}]

    partial = await preferences_api.update_preferences(
        body=PreferencesUpdate(palette="blue"), user=user_a, db=db,
    )
    assert partial.locale == "ja-JP"
    assert partial.theme == "dark"
    assert partial.palette == "blue"
    assert partial.automaticModeEnabled is True

    stored = await db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_a.id))
    assert stored is not None
    assert stored.data["locale"] == "ja-JP"
    assert stored.data["theme"] == "dark"
    assert stored.data["automatic_mode_enabled"] is True
    assert stored.data["stage_templates"] == [{"name": "合成模板"}]
