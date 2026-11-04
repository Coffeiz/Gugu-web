"""并发输入和 Run 输出按平台事件时间恢复顺序。"""

import pytest
from sqlalchemy import select
from datetime import datetime, timezone

from agent.context.display_checkpoint import resequence_checkpoint
from agent.context.session_history import load_session_history
from app.models import ConversationMessage, ConversationSession


@pytest.mark.asyncio
async def test_late_group_messages_precede_completed_run_output(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="并发群聊")
    db.add(session)
    await db.flush()
    first = ConversationMessage(session_id=session.id, role="user", content="A")
    db.add(first)
    await db.commit()

    # run1 运行期间，其他群消息提前入库；其事件序号立即推进。
    late = [ConversationMessage(session_id=session.id, role="user", content=value) for value in "BCD"]
    db.add_all(late)
    await db.commit()

    # run1 的工具和最终输出在收尾时才写入 canonical history。
    output = [
        ConversationMessage(session_id=session.id, role="assistant", content="tool result"),
        ConversationMessage(session_id=session.id, role="assistant", content="run1 完成"),
    ]
    db.add_all(output)
    await db.commit()

    history = await load_session_history(db, session.id)
    assert [row.content for row in history] == ["A", "B", "C", "D", "tool result", "run1 完成"]


@pytest.mark.asyncio
async def test_history_follows_platform_time_when_run_output_was_persisted_first(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="平台时间顺序", source="telegram")
    db.add(session)
    await db.flush()

    def instant(milliseconds: int):
        return datetime.fromtimestamp(milliseconds / 1000, timezone.utc)

    rows = [
        ConversationMessage(
            session_id=session.id, role="user", content="触发消息",
            im_platform_sent_ms=1_790_000_000_000,
            created_at=instant(1_790_000_001_000),
        ),
        # 模拟旧恢复路径将助手输出先落库、后补入 Run 期间收到的消息。
        ConversationMessage(
            session_id=session.id, role="assistant", content="Run 完成回复",
            created_at=instant(1_790_000_004_000),
        ),
        ConversationMessage(
            session_id=session.id, role="user", content="Run 中到达的群消息一",
            im_platform_sent_ms=1_790_000_002_000,
            created_at=instant(1_790_000_002_100),
        ),
        ConversationMessage(
            session_id=session.id, role="user", content="Run 中到达的群消息二",
            im_platform_sent_ms=1_790_000_003_000,
            created_at=instant(1_790_000_003_100),
        ),
    ]
    db.add_all(rows)
    await db.commit()

    history = await load_session_history(db, session.id)

    assert [row.content for row in history] == [
        "触发消息", "Run 中到达的群消息一", "Run 中到达的群消息二", "Run 完成回复",
    ]


@pytest.mark.asyncio
async def test_checkpoint_is_resequenced_after_late_input_before_output(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="检查点顺序")
    db.add(session)
    await db.flush()
    first = ConversationMessage(session_id=session.id, role="user", content="A")
    checkpoint = ConversationMessage(
        session_id=session.id, role="assistant", content="", content_json=[],
        run_id="display-user:1",
    )
    db.add_all([first, checkpoint])
    await db.commit()

    late = ConversationMessage(session_id=session.id, role="user", content="B")
    db.add(late)
    await db.commit()

    await resequence_checkpoint(db, checkpoint)
    output = ConversationMessage(session_id=session.id, role="assistant", content="run1 完成")
    checkpoint.content_json = None
    checkpoint.content = "run1 展示"
    db.add(output)
    await db.commit()

    rows = list((await db.execute(
        select(ConversationMessage)
        .where(ConversationMessage.session_id == session.id)
        .order_by(ConversationMessage.conversation_seq)
    )).scalars())
    assert [row.content for row in rows] == ["A", "B", "run1 展示", "run1 完成"]


@pytest.mark.asyncio
async def test_conversation_sequences_are_independent_per_session(db, user_a):
    sessions = [ConversationSession(user_id=user_a.id, title=f"会话 {index}") for index in range(2)]
    db.add_all(sessions)
    await db.flush()
    db.add_all([
        ConversationMessage(session_id=sessions[0].id, role="user", content="A1"),
        ConversationMessage(session_id=sessions[1].id, role="user", content="B1"),
        ConversationMessage(session_id=sessions[0].id, role="user", content="A2"),
    ])
    await db.commit()

    rows = list((await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.session_id.in_([item.id for item in sessions])
        ).order_by(ConversationMessage.session_id, ConversationMessage.conversation_seq)
    )).scalars())
    assert [row.conversation_seq for row in rows if row.session_id == sessions[0].id] == [1, 2]
    assert [row.conversation_seq for row in rows if row.session_id == sessions[1].id] == [1]
