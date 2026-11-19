from agent.im.context_loader import format_group_message


def test_mention_only_group_message_is_distinguishable_from_empty_message():
    rendered = format_group_message({
        "speaker": {"platform_user_id": "member-synthetic", "display_name": "小北"},
        "body": "",
        "mention_only": True,
    })

    assert "仅提及咕咕，没有附加文字" in rendered


def test_regular_empty_group_message_does_not_gain_mention_semantics():
    rendered = format_group_message({
        "speaker": {"platform_user_id": "member-synthetic", "display_name": "小北"},
        "body": "",
    })

    assert "仅提及咕咕" not in rendered
