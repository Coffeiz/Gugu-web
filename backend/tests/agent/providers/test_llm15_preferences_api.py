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
        self.sessions = []

    async def execute(self, _query):
        class _Result:
            def __init__(self, sessions):
                self.sessions = sessions

            def scalars(self):
                return self

            def all(self):
                return self.sessions

        return _Result(self.sessions)

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
        ("unknown", "full"),
        (None, "description"),
    ],
)
def test_tool_injection_mode_response_uses_only_canonical_values(monkeypatch, stored, expected):
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=False),
    ))

    result = preferences_api._to_response({"tool_injection_mode": stored})

    assert result.toolInjectionMode == expected


def test_tool_injection_mode_defaults_to_description(monkeypatch):
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=False),
    ))

    result = preferences_api._to_response({})

    assert result.toolInjectionMode == "description"


def test_im_tool_display_mode_response_uses_unified_preference(monkeypatch):
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=False),
    ))

    defaults = preferences_api._to_response({})
    assert defaults.imToolDisplayMode == "all"
    assert defaults.showIntermediateReplies is False

    saved = preferences_api._to_response({
        "im_tool_display_mode": "off",
        "show_intermediate_replies": True,
    })
    assert saved.imToolDisplayMode == "off"
    assert saved.showIntermediateReplies is True


@pytest.mark.asyncio
async def test_update_preferences_persists_intermediate_reply_preference(monkeypatch):
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=False),
    ))
    prefs = _Prefs()

    async def fake_get_or_create(_user, _db):
        return prefs

    monkeypatch.setattr(preferences_api, "_get_or_create", fake_get_or_create)
    monkeypatch.setattr(preferences_api, "read_personality_file", lambda _user_id: None)

    result = await preferences_api.update_preferences(
        PreferencesUpdate(showIntermediateReplies=False),
        SimpleNamespace(id="synthetic-user"),
        _Db(),
    )

    assert prefs.data["show_intermediate_replies"] is False
    assert result.showIntermediateReplies is False


def test_decision_guard_preference_defaults_to_disabled(monkeypatch):
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=False),
    ))

    result = preferences_api._to_response({})

    assert result.decisionGuardEnabled is False


@pytest.mark.asyncio
async def test_update_preferences_persists_decision_guard_preference(monkeypatch):
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=False),
    ))
    prefs = _Prefs()

    async def fake_get_or_create(_user, _db):
        return prefs

    monkeypatch.setattr(preferences_api, "_get_or_create", fake_get_or_create)
    monkeypatch.setattr(preferences_api, "read_personality_file", lambda _user_id: None)

    result = await preferences_api.update_preferences(
        PreferencesUpdate(decisionGuardEnabled=True),
        SimpleNamespace(id="synthetic-user"),
        _Db(),
    )

    assert prefs.data["decision_guard_enabled"] is True
    assert result.decisionGuardEnabled is True


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
async def test_update_preferences_can_disable_personality_and_expire_snapshots(monkeypatch, tmp_path):
    prefs = _Prefs()
    prefs.data = {"personality_preference_enabled": True}
    db = _Db()
    db.sessions = [SimpleNamespace(snapshot_expires_at=None)]
    user = SimpleNamespace(id="user-1")
    bumped = []

    async def get_or_create(_user, _db):
        return prefs

    async def bump(user_id, resource):
        bumped.append((user_id, resource))

    settings = SimpleNamespace(
        agent=SimpleNamespace(personality_preference_enabled=True),
        storage=SimpleNamespace(local_path=str(tmp_path)),
    )
    monkeypatch.setattr(preferences_api, "_get_or_create", get_or_create)
    monkeypatch.setattr(preferences_api, "get_settings", lambda: settings)
    monkeypatch.setattr("app.services.personality_preferences.get_settings", lambda: settings)
    monkeypatch.setattr("app.core.events.bump_context_revision", bump)

    result = await preferences_api.update_preferences(
        PreferencesUpdate(personalityPreferenceEnabled=False), user, db,
    )

    assert result.personalityPreferenceEnabled is False
    assert db.sessions[0].snapshot_expires_at is not None
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


@pytest.mark.asyncio
async def test_custom_reply_style_is_saved_and_can_be_disabled(monkeypatch):
    prefs = _Prefs()
    db = _Db()
    async def get_prefs(*_args):
        return prefs
    async def bump(*_args):
        pass
    monkeypatch.setattr(preferences_api, "_get_or_create", get_prefs)
    monkeypatch.setattr(preferences_api, "read_personality_file", lambda _user: None)
    monkeypatch.setattr(preferences_api, "read_reply_style_file", lambda _user: "先给结论")
    monkeypatch.setattr(preferences_api, "write_reply_style_file", lambda _user, _content: True)
    monkeypatch.setattr(preferences_api, "invalidate_personality_snapshots", bump)
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(agent=SimpleNamespace(personality_preference_enabled=True)))
    from app.core import events
    monkeypatch.setattr(events, "bump_context_revision", bump)
    user = SimpleNamespace(id="synthetic-user")
    from app.schemas import ReplyStyleUpdate
    result = await preferences_api.update_reply_style(ReplyStyleUpdate(content="  先给结论  "), user, db)
    assert "custom_reply_style" not in prefs.data
    result = await preferences_api.update_preferences(PreferencesUpdate(customReplyStyleEnabled=True), user, db)
    assert result.customReplyStyle == "先给结论"
    assert result.customReplyStyleEnabled is True
    result = await preferences_api.update_preferences(PreferencesUpdate(customReplyStyleEnabled=False), user, db)
    assert result.customReplyStyle == "先给结论"
    assert result.customReplyStyleEnabled is False


@pytest.mark.asyncio
async def test_legacy_reply_style_is_written_to_file_before_database_key_is_removed(monkeypatch):
    prefs = _Prefs()
    prefs.data = {"custom_reply_style": "  先给结论  ", "theme": "dark"}
    db = _Db()
    stored = {}

    async def get_prefs(*_args):
        return prefs

    def read_style(_user):
        return stored.get("style")

    def write_style(_user, content):
        stored["style"] = content.strip() if content else None
        return True

    monkeypatch.setattr(preferences_api, "_get_or_create", get_prefs)
    monkeypatch.setattr(preferences_api, "read_reply_style_file", read_style)
    monkeypatch.setattr(preferences_api, "write_reply_style_file", write_style)
    monkeypatch.setattr(preferences_api, "read_personality_file", lambda _user: None)
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(agent=SimpleNamespace(personality_preference_enabled=False)))

    result = await preferences_api.get_preferences(SimpleNamespace(id="synthetic-user"), db)

    assert result.customReplyStyle == "先给结论"
    assert prefs.data == {"theme": "dark"}
    assert stored["style"] == "先给结论"
    assert db.commits == 1


@pytest.mark.asyncio
async def test_legacy_reply_style_is_preserved_when_file_migration_fails(monkeypatch):
    prefs = _Prefs()
    prefs.data = {"custom_reply_style": "先给结论", "theme": "dark"}

    async def get_prefs(*_args):
        return prefs

    def fail_write(*_args):
        raise OSError("synthetic write failure")

    monkeypatch.setattr(preferences_api, "_get_or_create", get_prefs)
    monkeypatch.setattr(preferences_api, "read_reply_style_file", lambda _user: None)
    monkeypatch.setattr(preferences_api, "write_reply_style_file", fail_write)

    with pytest.raises(OSError, match="synthetic write failure"):
        await preferences_api.get_preferences(SimpleNamespace(id="synthetic-user"), _Db())

    assert prefs.data == {"custom_reply_style": "先给结论", "theme": "dark"}


@pytest.mark.asyncio
async def test_reply_style_txt_upload_imports_plain_text_into_canonical_file(monkeypatch):
    prefs = _Prefs()
    db = _Db()
    stored = {}

    async def get_prefs(*_args):
        return prefs

    def write_style(_user, content):
        stored["style"] = content
        return True

    monkeypatch.setattr(preferences_api, "_get_or_create", get_prefs)
    monkeypatch.setattr(preferences_api, "write_reply_style_file", write_style)
    monkeypatch.setattr(preferences_api, "read_reply_style_file", lambda _user: stored.get("style"))
    monkeypatch.setattr(preferences_api, "read_personality_file", lambda _user: None)
    monkeypatch.setattr(preferences_api, "invalidate_personality_snapshots", lambda *_args: _noop())
    monkeypatch.setattr(preferences_api, "get_settings", lambda: SimpleNamespace(agent=SimpleNamespace(personality_preference_enabled=False)))

    upload = UploadFile(filename="reply.txt", file=BytesIO("先给结论，再解释。".encode("utf-8")))
    result = await preferences_api.upload_reply_style(upload, SimpleNamespace(id="synthetic-user"), db)

    assert stored["style"] == "先给结论，再解释。"
    assert result.customReplyStyle == stored["style"]
    assert "custom_reply_style" not in prefs.data


async def _noop():
    return None
