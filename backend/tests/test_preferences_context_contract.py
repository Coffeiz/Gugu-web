"""PRD-LLM-15：用户风格与跨渠道提示词组装回归测试。"""

from datetime import datetime, timezone

import pytest

from agent.context import builder
from agent.context.session_snapshot import ensure_snapshot


def test_style_preference_static_prefix_is_stable_across_channels():
    outputs = [
        builder.build_split(
            "default",
            "测试用户",
            [],
            [],
            style_prefs={"reply_tone": "formal", "reply_length": "short"},
            source=source,
            im_channels={"qq": True, "feishu": True},
        )
        for source in ("web", "qq", "feishu", "wechat")
    ]

    static_parts = [static for static, _, _ in outputs]
    dynamic_parts = [dynamic for _, dynamic, _ in outputs]

    assert len(set(static_parts)) == 1
    static = static_parts[0]
    assert static.index("## 风格偏好") > static.index("当前、最新、最近")
    assert all("## 风格偏好" not in dynamic for dynamic in dynamic_parts)


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
        baseline_message_id = 0

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


def test_phase0_keeps_controlled_style_preferences_distinct_from_personality_text():
    static, dynamic, _ = builder.build_split(
        "default",
        "测试用户",
        [],
        [],
        style_prefs={"reply_tone": "lively", "reply_length": "detailed"},
    )

    assert "偏活泼" in static
    assert "详细" in static
    assert "personality_preference" not in static
    assert "personality_preference" not in dynamic
