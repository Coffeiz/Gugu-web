"""终端保留策略：孤儿终端清理、输出滚动上限、会话删除级联关闭。"""

from datetime import timedelta

import pytest
from sqlalchemy import select

import app.services.terminals as terminals_service
from app.models import ConversationSession, TerminalEventRecord, TerminalSessionRecord
from app.services.conversation_cleanup import remove_session_with_attachments
from app.services.terminals import (
    append_shell_result,
    prune_terminals,
    terminal_events,
)
from app.core.tz import now_utc


def _aged_terminal(**kwargs) -> TerminalSessionRecord:
    defaults = dict(
        id=kwargs.pop("id"), owner_id=kwargs.pop("owner_id"),
        name="终端", source="agent", status="idle",
        shell_mode="sandbox", network_profile="none",
        updated_at=now_utc() - timedelta(days=40),
    )
    defaults.update(kwargs)
    return TerminalSessionRecord(**defaults)


@pytest.mark.asyncio
async def test_prune_removes_orphan_agent_terminal_and_events(db, user_a):
    """会话删除后 session_id 被 SET NULL 的孤儿咕咕终端，超期必须被清理。"""
    orphan = _aged_terminal(id="term-orphan", owner_id=user_a.id, session_id=None)
    db.add(orphan)
    await db.flush()
    db.add(TerminalEventRecord(
        terminal_id=orphan.id, sequence=1, event_type="command",
        source="agent", command="ls", stdout="out", stderr="",
    ))
    await db.flush()

    removed = await prune_terminals(db, user_a.id)
    await db.commit()

    assert removed == 1
    assert await db.get(TerminalSessionRecord, "term-orphan") is None
    assert (await db.execute(select(TerminalEventRecord))).scalars().all() == []


@pytest.mark.asyncio
async def test_prune_keeps_recent_orphan_and_session_bound_agent_terminal(db, user_a):
    session = ConversationSession(user_id=user_a.id)
    db.add(session)
    await db.flush()
    bound = _aged_terminal(id="term-bound", owner_id=user_a.id, session_id=session.id)
    recent_orphan = TerminalSessionRecord(
        id="term-fresh", owner_id=user_a.id, session_id=None,
        name="终端", source="agent", status="idle",
        shell_mode="sandbox", network_profile="none",
    )
    db.add_all([bound, recent_orphan])
    await db.flush()

    removed = await prune_terminals(db, user_a.id)

    assert removed == 0
    assert await db.get(TerminalSessionRecord, "term-bound") is not None
    assert await db.get(TerminalSessionRecord, "term-fresh") is not None


@pytest.mark.asyncio
async def test_prune_keeps_unclosed_user_terminal_without_session(db, user_a):
    """孤儿规则只针对 agent 终端；用户自建终端仍由用户手动管理。"""
    user_terminal = _aged_terminal(
        id="term-user", owner_id=user_a.id, session_id=None, source="user",
    )
    db.add(user_terminal)
    await db.flush()

    removed = await prune_terminals(db, user_a.id)

    assert removed == 0
    assert await db.get(TerminalSessionRecord, "term-user") is not None


@pytest.mark.asyncio
async def test_prune_still_removes_closed_terminal_past_retention(db, user_a):
    closed = _aged_terminal(
        id="term-closed", owner_id=user_a.id, source="user",
        status="terminated", closed_at=now_utc() - timedelta(days=40),
    )
    db.add(closed)
    await db.flush()

    removed = await prune_terminals(db, user_a.id)

    assert removed == 1
    assert await db.get(TerminalSessionRecord, "term-closed") is None


@pytest.mark.asyncio
async def test_append_shell_result_trims_oldest_events_beyond_retention_cap(db, user_a, monkeypatch):
    monkeypatch.setattr(terminals_service, "TERMINAL_OUTPUT_RETENTION_CHARS", 100)
    terminal = TerminalSessionRecord(
        id="term-cap", owner_id=user_a.id, session_id=None,
        name="咕咕终端", source="agent", status="idle",
        shell_mode="sandbox", network_profile="none",
    )
    db.add(terminal)
    await db.flush()

    for index in range(1, 4):
        await append_shell_result(
            db, terminal, command=f"cmd-{index}", stdout="x" * 60, stderr="",
            exit_code=0, ok=True,
        )

    # 累计 180 > 上限 100：最老两条被滚动删除，只留最新一条。
    sequences = [row.sequence for row in (await db.execute(
        select(TerminalEventRecord).order_by(TerminalEventRecord.sequence.asc())
    )).scalars()]
    assert sequences == [3]
    assert terminal.output_chars == 60
    assert terminal.last_sequence == 3

    # 裁剪后 sequence 不回退，增量回放游标仍兼容。
    replay = await terminal_events(db, terminal, after=2)
    assert [event.sequence for event in replay] == [3]

    await append_shell_result(
        db, terminal, command="cmd-4", stdout="y" * 10, stderr="",
        exit_code=0, ok=True,
    )
    assert terminal.last_sequence == 4
    assert terminal.output_chars == 70


@pytest.mark.asyncio
async def test_append_shell_result_never_deletes_newest_event(db, user_a, monkeypatch):
    monkeypatch.setattr(terminals_service, "TERMINAL_OUTPUT_RETENTION_CHARS", 10)
    terminal = TerminalSessionRecord(
        id="term-cap-keep", owner_id=user_a.id, session_id=None,
        name="咕咕终端", source="agent", status="idle",
        shell_mode="sandbox", network_profile="none",
    )
    db.add(terminal)
    await db.flush()

    await append_shell_result(
        db, terminal, command="big", stdout="z" * 200, stderr="",
        exit_code=0, ok=True,
    )

    event = (await db.execute(select(TerminalEventRecord))).scalar_one()
    assert event.sequence == 1
    assert terminal.output_chars == 200


@pytest.mark.asyncio
async def test_remove_session_closes_agent_terminal_but_keeps_user_terminal(db, user_a):
    session = ConversationSession(user_id=user_a.id)
    db.add(session)
    await db.flush()
    agent_terminal = TerminalSessionRecord(
        id="term-agent", owner_id=user_a.id, session_id=session.id,
        name="咕咕终端", source="agent", status="running",
        shell_mode="sandbox", network_profile="none",
    )
    user_terminal = TerminalSessionRecord(
        id="term-keep", owner_id=user_a.id, session_id=session.id,
        name="用户终端", source="user", status="idle",
        shell_mode="sandbox", network_profile="none",
    )
    already_closed = TerminalSessionRecord(
        id="term-closed-early", owner_id=user_a.id, session_id=session.id,
        name="早停终端", source="agent", status="terminated",
        shell_mode="sandbox", network_profile="none",
        closed_at=now_utc() - timedelta(days=1),
    )
    db.add_all([agent_terminal, user_terminal, already_closed])
    await db.flush()

    await remove_session_with_attachments(db, session)

    # 清理函数里是 core 层 UPDATE + commit，必须先过期身份映射再读新状态。
    db.expire_all()

    closed_row = await db.get(TerminalSessionRecord, "term-agent")
    assert closed_row.status == "terminated"
    assert closed_row.closed_at is not None
    kept_row = await db.get(TerminalSessionRecord, "term-keep")
    assert kept_row.closed_at is None
    assert kept_row.status == "idle"
    untouched = await db.get(TerminalSessionRecord, "term-closed-early")
    assert untouched.closed_at is not None
