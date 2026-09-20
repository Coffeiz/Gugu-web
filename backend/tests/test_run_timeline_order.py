"""取消收尾晚于后续输入提交时，历史时间线仍按 run 发起顺序恢复。"""

import pytest

from app.api.v1 import agent as agent_api
from app.models import ConversationMessage, ConversationSession


@pytest.mark.asyncio
async def test_late_cancelled_run_timeline_stays_before_continue_after_reload(db, user_a, monkeypatch):
    async def noop(*args, **kwargs):
        return None

    monkeypatch.setattr("agent.context.compress_conv.recover_orphaned_session", noop)
    monkeypatch.setattr(agent_api, "filesystem_authorization_enabled", lambda: False)

    session = ConversationSession(user_id=user_a.id)
    db.add(session)
    await db.flush()

    first_message = ConversationMessage(session_id=session.id, role="user", content="先看项目详情")
    continuation = ConversationMessage(session_id=session.id, role="user", content="继续")
    db.add_all([first_message, continuation])
    await db.flush()

    # 取消收尾在「继续」已提交后才插入旧 run 的展示行；order 必须锚定原问题。
    late_timeline = ConversationMessage(
        session_id=session.id,
        role="assistant",
        content="",
        display_timeline=[{
            "kind": "tool",
            "toolCallId": "project-details-1",
            "toolName": "project_details",
            "timelineOrder": first_message.id * 1000 + 1,
        }],
    )
    db.add(late_timeline)
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)

    tool_event = payload["timelineEvents"][0]
    assert late_timeline.id > continuation.id
    assert tool_event["timelineOrder"] == first_message.id * 1000 + 1
    assert tool_event["timelineOrder"] < continuation.id * 1000
