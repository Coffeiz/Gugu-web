"""早落库的 ``im-pending:`` run_id 前缀必须与其他前缀彻底隔离。

``ConversationMessage.run_id`` 上有三类取值：

- ``display-user:{id}``      —— assistant 展示行（``display_checkpoint``）
- ``im-inbound:{batch_key}`` —— 已被某个 run 消费的用户行（``inbound_recovery``）
- ``im-pending:{hash}``      —— 早落库、还没被任何 run 消费的用户行（本轮新增）
- ``NULL``                   —— 被动记录路径写的行，以及没有批次键的普通消息

历史读取靠前缀把"早落库未消费"的行排除掉（否则同一段话在历史和当前轮各出现一次）。
这条排除只认自己的前缀，别的取值一个都不能误伤——尤其 ``NULL``：被动群消息的行
就是 ``NULL``，它们必须照常进历史（群记忆反思靠它读会话）。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from agent.im.inbound_recovery import (
    PENDING_USER_RUN_PREFIX,
    pending_user_run_key,
    user_run_key,
)
from app.models import ConversationMessage, ConversationSession


def test_pending_run_key_is_stable_and_prefixed():
    key = pending_user_run_key("stream-1234-0")
    assert key.startswith(PENDING_USER_RUN_PREFIX)
    # run_id 列是 String(128)：前缀 + 摘要必须放得下。
    assert len(key) <= 128
    assert key == pending_user_run_key("stream-1234-0")
    assert key != pending_user_run_key("stream-1234-1")


def test_pending_prefix_does_not_collide_with_batch_or_display_prefixes():
    """三个前缀互不覆盖：早落库行不会被当成已消费的行，反之亦然。"""
    pending = pending_user_run_key("stream-1234-0")
    batch = user_run_key("a" * 64)
    assert pending != batch
    assert not pending.startswith("im-inbound:")
    assert not batch.startswith(PENDING_USER_RUN_PREFIX)
    # 早落库标记只能命中自己那类行：批次键、展示键、空值都不算。
    assert pending.startswith(PENDING_USER_RUN_PREFIX)
    assert not batch.startswith(PENDING_USER_RUN_PREFIX)
    assert not "display-user:1".startswith(PENDING_USER_RUN_PREFIX)
    assert not "".startswith(PENDING_USER_RUN_PREFIX)


@pytest.mark.asyncio
async def test_history_keeps_every_run_id_except_the_pending_one(db, user_a):
    """只有 ``im-pending:`` 前缀的行被排除；NULL / 批次键 / 展示键都照常进历史。"""
    from agent.context.session_history import load_session_history

    session = ConversationSession(user_id=user_a.id, title="合成群", source="qq",
                                  bot_id="bot-synthetic", chat_id="group-synthetic", chat_type="group")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    kept = [
        ("被动记录路径写的行（run_id 为 NULL）", None),
        ("空串 run_id", ""),
        ("已被 run 消费的用户行", user_run_key("a" * 64)),
        ("assistant 展示行", "display-user:999"),
        ("其它前缀", "web-something"),
    ]
    for content, run_id in kept:
        db.add(ConversationMessage(
            session_id=session.id, role="user", content=content, run_id=run_id,
        ))
    db.add(ConversationMessage(
        session_id=session.id, role="user", content="早落库未消费的行",
        run_id=pending_user_run_key("stream-1234-0"),
    ))
    await db.commit()

    history = await load_session_history(db, session.id)
    contents = [row.content for row in history]
    assert "早落库未消费的行" not in contents
    for content, _ in kept:
        assert content in contents


@pytest.mark.asyncio
async def test_promoted_pending_row_returns_to_history(db, user_a):
    """run 消费后（run_id 改成批次键）这行重新进历史——早落库只是推迟，不是丢弃。"""
    from agent.context.session_history import load_session_history
    from agent.run.preparation import _reuse_early_user_rows

    session = ConversationSession(user_id=user_a.id, title="合成群", source="qq",
                                  bot_id="bot-synthetic", chat_id="group-synthetic", chat_type="group")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    row = ConversationMessage(
        session_id=session.id, role="user", content="早落库的一条",
        run_id=pending_user_run_key("stream-1234-0"),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    assert [r.content for r in await load_session_history(db, session.id)] == []

    await _reuse_early_user_rows(
        db, session_id=session.id, early_ids=[row.id], attach_cards=None,
        batch_key="a" * 64,
    )
    await db.commit()

    assert [r.content for r in await load_session_history(db, session.id)] == ["早落库的一条"]
