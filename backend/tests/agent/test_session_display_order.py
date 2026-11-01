"""会话时间线按平台消息发生时间分页，而不是按入库先后分页。"""

from datetime import datetime, timezone

import pytest

from app.models import ConversationMessage, ConversationSession
from app.services.conversations import load_display_message_page


@pytest.mark.asyncio
async def test_display_message_pages_are_ordered_by_platform_timestamp(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="展示时间顺序", source="telegram")
    db.add(session)
    await db.flush()

    def instant(milliseconds: int):
        return datetime.fromtimestamp(milliseconds / 1000, timezone.utc)

    older = ConversationMessage(
        session_id=session.id, role="user", content="较早消息",
        im_platform_sent_ms=1_790_000_000_000,
        created_at=instant(1_790_000_000_100),
    )
    latest = ConversationMessage(
        session_id=session.id, role="user", content="最后发生",
        im_platform_sent_ms=1_790_000_003_000,
        created_at=instant(1_790_000_003_100),
    )
    middle = ConversationMessage(
        session_id=session.id, role="user", content="中间消息",
        im_platform_sent_ms=1_790_000_002_000,
        created_at=instant(1_790_000_002_100),
    )
    db.add_all([older, latest, middle])
    await db.commit()

    recent_page = await load_display_message_page(db, session.id, 2)
    assert [row.content for row in recent_page["messages"]] == ["中间消息", "最后发生"]
    assert recent_page["has_more"] is True

    older_page = await load_display_message_page(
        db, session.id, 2, before_id=recent_page["messages"][0].id,
    )
    assert [row.content for row in older_page["messages"]] == ["较早消息"]


def test_session_message_api_exposes_effective_platform_timestamp():
    from app.api.v1.agent_routes.sessions import _message_occurred_at

    row = ConversationMessage(
        role="user", content="合成消息", created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        im_platform_sent_ms=1_790_000_000_000,
    )

    assert _message_occurred_at(row) == "2026-09-21T14:13:20Z"
