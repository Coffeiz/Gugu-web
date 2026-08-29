from types import SimpleNamespace

from agent.context.audit import session_scope, summary_change


def test_summary_audit_scope_does_not_duplicate_event_source(caplog):
    session = SimpleNamespace(
        id=388,
        source="qq",
        chat_type="c2c",
        chat_id="private-chat",
        bot_id="bot",
        user_id="user",
    )
    scope = session_scope(session)
    scope.pop("source", None)

    with caplog.at_level("INFO", logger="agent.context.audit"):
        summary_change(source="persistent_compaction", old="旧", new="新", **scope)

    assert "persistent_compaction" in caplog.text
