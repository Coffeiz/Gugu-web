"""PRD-LLM-15 Phase 0：用户风格与跨渠道提示词组装基线。"""

from agent.context import builder


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
