from agent.selection.identity import (
    IDENTITY_REGISTER_ACTION,
    build_platform_user_registration,
)


def test_platform_user_registration_builds_confirmation_prompt():
    prompt = build_platform_user_registration({
        "platform": "qqbot",
        "chat_type": "c2c",
        "owner_user_id": "user-1",
        "platform_user_id": "qq-1",
        "channel_id": "18",
    })

    assert prompt is not None
    assert prompt.action_id == IDENTITY_REGISTER_ACTION
    assert [option.value for option in prompt.options] == ["confirm", "cancel"]
    assert prompt.context["platform_user_id"] == "qq-1"


def test_platform_user_registration_does_not_build_for_group_or_other_platform():
    assert build_platform_user_registration({
        "platform": "qqbot",
        "chat_type": "group",
        "owner_user_id": "user-1",
        "platform_user_id": "qq-1",
        "channel_id": "18",
    }) is None
    assert build_platform_user_registration({
        "platform": "feishu",
        "chat_type": "c2c",
        "owner_user_id": "user-1",
        "platform_user_id": "ou-1",
        "channel_id": "bot-1",
    }) is None
