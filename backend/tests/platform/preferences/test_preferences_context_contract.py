"""PRD-LLM-15：用户风格与跨渠道提示词组装回归测试。"""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from agent.context import builder
from agent.context.session_snapshot import ensure_snapshot
from agent.context.loaders import load_style_prefs
from app.models import UserPreferences
from app.services import personality_preferences


def test_legacy_style_preferences_do_not_affect_static_prompt_across_channels():
    outputs = [
        builder.build_split(
            "default", "测试用户", [], [],
            style_prefs={"reply_tone": "formal", "reply_length": "short"},
            source=source, im_channels={"qq": True, "feishu": True},
        )
        for source in ("web", "qq", "feishu", "wechat")
    ]
    assert len({static for static, _, _ in outputs}) == 1
    assert all("## 用户回复风格要求" not in static for static, _, _ in outputs)


def test_locale_rule_is_first_and_uses_the_selected_language():
    static, _, _ = builder.build_split(
        "default", "测试用户", [], [], style_prefs={"locale": "en-US"}
    )

    assert static.startswith("现在是 ")
    assert static.index("现在是 ") < static.index("## 当前交流语言")
    assert "当前用户界面语言为「English」" in static
    assert "除非用户明确要求使用其他语言" in static


@pytest.mark.asyncio
async def test_english_locale_reaches_the_session_prompt_used_for_reply():
    """选择 English 后，实际会话快照必须把英文规则传给模型。"""

    class Db:
        async def flush(self):
            return None

    class Session:
        context_epoch = 0
        session_context = None
        snapshot_expires_at = None
        user_id = "synthetic-user"
        baseline_message_seq = 0

    session = Session()
    loaded = 0

    async def load_context():
        nonlocal loaded
        loaded += 1
        static, dynamic, _ = builder.build_split(
            "default",
            "Synthetic User",
            [],
            [],
            style_prefs={"locale": "en-US"},
            source="web",
            user_msg="What did I ask you to remember?",
        )
        return {
            "system_prompt": static,
            "snapshot_context": dynamic,
            "session_info": {"source": "web"},
            "user_tz": timezone.utc,
            "locale": "en-US",
        }

    snapshot = await ensure_snapshot(
        Db(),
        session,
        load_context=load_context,
        locale="en-US",
        now=datetime(2026, 8, 30, tzinfo=timezone.utc),
    )

    assert loaded == 1
    assert session.session_context["locale"] == "en-US"
    assert snapshot["system_prompt"].startswith("现在是 ")
    assert "## 当前交流语言" in snapshot["system_prompt"]
    assert "当前用户界面语言为「English」" in snapshot["system_prompt"]
    assert "请始终使用「English」与用户交流" in snapshot["system_prompt"]

    # 下一轮使用相同语言时复用同一快照，避免回退到默认中文规则。
    reused = await ensure_snapshot(
        Db(),
        session,
        load_context=load_context,
        locale="en-US",
        now=datetime(2026, 8, 30, 0, 1, tzinfo=timezone.utc),
    )
    assert loaded == 1
    assert reused == snapshot


def test_default_prompt_does_not_inject_removed_style_preferences():
    static, _, _ = builder.build_split("default", "测试用户", [], [])
    assert "## 用户回复风格要求" not in static


def test_custom_reply_style_is_independent_of_persona_and_can_be_disabled():
    prefs = {"personality_preference_enabled": True, "personality_preference": "测试人格设定", "custom_reply_style": "先给出结论", "custom_reply_style_enabled": True}
    static, _, _ = builder.build_split("default", "测试用户", [], [], style_prefs=prefs)
    assert "测试人格设定" in static
    assert "先给出结论" in static
    prefs["custom_reply_style_enabled"] = False
    disabled, _, _ = builder.build_split("default", "测试用户", [], [], style_prefs=prefs)
    assert "测试人格设定" in disabled
    assert "先给出结论" not in disabled


def test_group_persona_is_used_only_in_group_prompt_and_never_leaks_personal_persona():
    personal_static, _, _ = builder.build_split(
        "default", "测试用户", [], [],
        style_prefs={
            "personality_preference": "个人专属人格",
            "personality_preference_enabled": True,
        },
    )
    group_static, _, _ = builder.build_split(
        "default", "测试用户", [], [],
        style_prefs={
            "group_chat": True,
            "personality_preference": "个人专属人格",
            "personality_preference_enabled": True,
            "group_personality_preference": "群聊专属人格",
            "group_personality_preference_enabled": True,
        },
    )
    group_default_static, _, _ = builder.build_split(
        "default", "测试用户", [], [],
        style_prefs={
            "group_chat": True,
            "personality_preference": "个人专属人格",
            "personality_preference_enabled": True,
            "group_personality_preference": "群聊专属人格",
            "group_personality_preference_enabled": False,
        },
    )

    assert "个人专属人格" in personal_static
    assert "群聊专属人格" in group_static
    assert "个人专属人格" not in group_static
    assert "群聊专属人格" not in group_default_static
    assert "个人专属人格" not in group_default_static
    assert "## 1. 做事" in group_default_static


@pytest.mark.asyncio
async def test_style_loader_selects_group_persona_only_for_group_scope(db, user_a, tmp_path, monkeypatch):
    monkeypatch.setattr(
        personality_preferences,
        "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path))),
    )
    await db.merge(UserPreferences(
        user_id=user_a.id,
        data_json=(
            '{"personality_preference_enabled":true,'
            '"group_personality_preference_enabled":true,'
            '"reply_tone":"formal","reply_length":"short"}'
        ),
    ))
    await db.flush()
    personality_preferences.write_personality_file(user_a.id, "个人设定")
    personality_preferences.write_group_personality_file(user_a.id, "群聊设定")

    private_prefs = await load_style_prefs(db, user_a.id)
    group_prefs = await load_style_prefs(db, user_a.id, group_chat=True)

    assert private_prefs["personality_preference"] == "个人设定"
    assert "reply_tone" not in private_prefs
    assert "reply_length" not in private_prefs
    assert "group_personality_preference" not in private_prefs
    assert group_prefs["group_personality_preference"] == "群聊设定"
    assert group_prefs["group_chat"] is True
    assert "personality_preference" not in group_prefs
