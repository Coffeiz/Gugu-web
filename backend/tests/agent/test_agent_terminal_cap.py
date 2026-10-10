"""咕咕终端滚动保留上限回归：只保留最近 AGENT_TERMINAL_KEEP_ALIVE 个，超出直接删除。

咕咕终端只是会话 shell 输出的分组记录（命令每次独立执行），删除后旧会话再用
shell 会自动重开；用户自建终端（source=user）不参与本上限。
"""
from uuid import uuid4

from sqlalchemy import select

from app.core.tz import now_utc
from app.models import ConversationSession, TerminalSessionRecord
from app.services.terminals import (
    AGENT_TERMINAL_KEEP_ALIVE,
    enforce_agent_terminal_cap,
    ensure_agent_terminal,
)


async def _mk_session(db, user_id, key: int):
    session = ConversationSession(user_id=user_id, title=f"cap-{key}", source="web")
    db.add(session)
    await db.flush()
    return session


async def _mk_terminal(db, user_id, *, session_id=None, source="agent", closed=False):
    row = TerminalSessionRecord(
        id=f"term-cap-{uuid4().hex}", owner_id=user_id, session_id=session_id,
        name="cap 终端", source=source,
        mode="agent-events" if source == "agent" else "interactive-pty",
        status="terminated" if closed else "idle",
        shell_mode="sandbox", network_profile="default",
    )
    if closed:
        row.closed_at = now_utc()
    db.add(row)
    await db.flush()  # 逐条 flush 让 updated_at 严格递增，保证新旧顺序确定
    return row


async def _agent_terminal_ids(db, user_id) -> set[str]:
    rows = (await db.execute(
        select(TerminalSessionRecord).where(
            TerminalSessionRecord.owner_id == user_id,
            TerminalSessionRecord.source == "agent"),
    )).scalars().all()
    return {row.id for row in rows}


async def test_cap_keeps_newest_and_deletes_rest(db, user_a):
    created = []
    for key in range(7):
        session = await _mk_session(db, user_a.id, key)
        created.append((await _mk_terminal(db, user_a.id, session_id=session.id)).id)
    await db.commit()

    evicted = await enforce_agent_terminal_cap(db, user_a.id)

    remaining = await _agent_terminal_ids(db, user_a.id)
    assert evicted == 7 - AGENT_TERMINAL_KEEP_ALIVE
    assert len(remaining) == AGENT_TERMINAL_KEEP_ALIVE
    # 保留的是最新的 5 个（创建顺序即新旧顺序）
    assert remaining == set(created[-AGENT_TERMINAL_KEEP_ALIVE:])


async def test_cap_covers_closed_agent_terminals_but_not_user_terminals(db, user_a):
    # 3 个已关闭的咕咕终端（如删会话级联关闭）+ 3 个开启的 + 3 个用户自建
    closed_ids = []
    for _ in range(3):
        closed_ids.append((await _mk_terminal(db, user_a.id, closed=True)).id)
    for _ in range(3):
        await _mk_terminal(db, user_a.id)
    user_ids = [(await _mk_terminal(db, user_a.id, source="user")).id for _ in range(3)]
    await db.commit()

    evicted = await enforce_agent_terminal_cap(db, user_a.id)

    assert evicted == 1  # 6 个咕咕终端保留最新 5 个，最旧的（已关闭）被删
    remaining = await _agent_terminal_ids(db, user_a.id)
    assert len(remaining) == AGENT_TERMINAL_KEEP_ALIVE
    assert closed_ids[0] not in remaining
    user_rows = (await db.execute(
        select(TerminalSessionRecord).where(
            TerminalSessionRecord.owner_id == user_a.id,
            TerminalSessionRecord.source == "user"),
    )).scalars().all()
    assert {row.id for row in user_rows} == set(user_ids)  # 用户自建终端不受影响


async def test_reusing_terminal_does_not_evict_anything(db, user_a):
    session = await _mk_session(db, user_a.id, 0)
    own = await ensure_agent_terminal(
        db, user_a.id, session_id=session.id, workspace_id=None,
        shell_mode="sandbox", network_profile="default")
    for _ in range(AGENT_TERMINAL_KEEP_ALIVE):
        await _mk_terminal(db, user_a.id)
    await db.commit()

    again = await ensure_agent_terminal(
        db, user_a.id, session_id=session.id, workspace_id=None,
        shell_mode="sandbox", network_profile="default")

    assert again.id == own.id  # 复用，不新建、不触发裁剪
    assert len(await _agent_terminal_ids(db, user_a.id)) == AGENT_TERMINAL_KEEP_ALIVE + 1


async def test_evicted_session_reopens_fresh_terminal(db, user_a):
    old_session = await _mk_session(db, user_a.id, 0)
    old = await ensure_agent_terminal(
        db, user_a.id, session_id=old_session.id, workspace_id=None,
        shell_mode="sandbox", network_profile="default")
    for _ in range(AGENT_TERMINAL_KEEP_ALIVE):
        await _mk_terminal(db, user_a.id)  # 同会话之外再压入 5 个更新的
    await db.commit()
    # 现实触发点：其他会话新建终端或用户打开终端页（列表接口挂了裁剪）
    await enforce_agent_terminal_cap(db, user_a.id)

    reopened = await ensure_agent_terminal(
        db, user_a.id, session_id=old_session.id, workspace_id=None,
        shell_mode="sandbox", network_profile="default")

    assert reopened.id != old.id  # 旧终端已被驱逐，本会话自动重开新终端
    assert old.id not in await _agent_terminal_ids(db, user_a.id)
    assert len(await _agent_terminal_ids(db, user_a.id)) == AGENT_TERMINAL_KEEP_ALIVE
