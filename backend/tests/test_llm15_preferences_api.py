"""PRD-LLM-15 Phase 1：偏好 API 的开关和 revision 行为。"""

from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.datastructures import UploadFile

from app.api.v1 import preferences as preferences_api
from app.schemas import PreferencesUpdate


class _Prefs:
    def __init__(self):
        self.data_json = "{}"

    @property
    def data(self):
        import json
        return json.loads(self.data_json)

    @data.setter
    def data(self, value):
        import json
        self.data_json = json.dumps(value, ensure_ascii=False)


class _Db:
    def __init__(self):
        self.commits = 0

    async def commit(self):
        self.commits += 1


@pytest.mark.parametrize(
    ("stored", "expected"),
    [
        ("description", "description"),
        ("full", "full"),
        ("catalog", "description"),
        ("compact_schema", "full"),
        ("full_schema", "full"),
        ("unknown", "description"),
        (None, "description"),
    ],
)
def test_tool_injection_mode_response_uses_only_canonical_values(monkeypatch, stored, expected):
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=False),
    ))

    result = preferences_api._to_response({"tool_injection_mode": stored})

    assert result.toolInjectionMode == expected


@pytest.mark.asyncio
async def test_update_preferences_persists_personality_and_invalidates_snapshot(monkeypatch):
    prefs = _Prefs()
    db = _Db()
    user = SimpleNamespace(id="user-1")
    invalidated = []
    bumped = []

    async def get_or_create(_user, _db):
        return prefs

    async def invalidate(_db, user_id):
        invalidated.append(user_id)

    async def bump(user_id, resource):
        bumped.append((user_id, resource))

    monkeypatch.setattr(preferences_api, "_get_or_create", get_or_create)
    monkeypatch.setattr(preferences_api, "invalidate_personality_snapshots", invalidate)
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=True),
    ))
    monkeypatch.setattr("app.core.events.bump_context_revision", bump)

    result = await preferences_api.update_preferences(
        PreferencesUpdate(personalityPreference="  叫我小北  ", personalityPreferenceEnabled=True),
        user,
        db,
    )

    assert result.personalityPreference == "叫我小北"
    assert result.personalityPreferenceEnabled is True
    assert result.personalityPreferenceRevision == 1
    assert invalidated == ["user-1"]
    assert bumped == [("user-1", "preferences")]
    assert db.commits == 1


@pytest.mark.asyncio
async def test_update_preferences_rejects_personality_when_global_switch_is_off(monkeypatch):
    monkeypatch.setattr(preferences_api, "_get_or_create", lambda _user, _db: _never())
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=False),
    ))

    with pytest.raises(Exception) as exc_info:
        await preferences_api.update_preferences(
            PreferencesUpdate(personalityPreference="叫我小北"),
            SimpleNamespace(id="user-1"),
            _Db(),
        )

    assert getattr(exc_info.value, "status_code", None) == 403


def _upload(content: bytes, filename: str = "persona.md") -> UploadFile:
    return UploadFile(file=BytesIO(content), filename=filename)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "filename, content, status",
    [
        ("persona.txt", b"text", 415),
        ("persona.md", b"x" * 40_001, 413),
        ("persona.md", b"\xff", 400),
        ("persona.md", b"bad\x01text", 400),
    ],
)
async def test_upload_personality_rejects_invalid_input(monkeypatch, filename, content, status):
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=True),
    ))
    with pytest.raises(Exception) as exc_info:
        await preferences_api.upload_personality(
            _upload(content, filename), SimpleNamespace(id="user-1"), _Db(),
        )
    assert getattr(exc_info.value, "status_code", None) == status


@pytest.mark.asyncio
async def test_upload_personality_is_user_scoped_and_invalidates_snapshot(monkeypatch, tmp_path):
    prefs = _Prefs()
    db = _Db()
    user = SimpleNamespace(id="user-1")
    invalidated = []
    bumped = []

    async def get_or_create(_user, _db):
        return prefs

    async def invalidate(_db, user_id):
        invalidated.append(user_id)

    async def bump(user_id, resource):
        bumped.append((user_id, resource))

    monkeypatch.setattr(preferences_api, "_get_or_create", get_or_create)
    monkeypatch.setattr(preferences_api, "invalidate_personality_snapshots", invalidate)
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=True),
        storage=SimpleNamespace(local_path=str(tmp_path)),
    ))
    monkeypatch.setattr("app.services.personality_preferences.get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
    ))
    monkeypatch.setattr("app.core.events.bump_context_revision", bump)

    result = await preferences_api.upload_personality(
        _upload("称呼我为小北\n".encode()), user, db,
    )

    path = Path(tmp_path) / "user-1" / ".agent" / "prompt" / "persona.md"
    assert result.personalityPreference == "称呼我为小北"
    assert path.read_text(encoding="utf-8") == "称呼我为小北"
    assert not (Path(tmp_path) / "user-2" / ".agent").exists()
    assert invalidated == ["user-1"]
    assert bumped == [("user-1", "preferences")]
    assert db.commits == 1


async def _never():
    raise AssertionError("开关关闭时不应读取或创建用户偏好")
