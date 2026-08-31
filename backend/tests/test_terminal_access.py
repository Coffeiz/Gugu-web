"""共享协作终端 Phase 0：契约和访问边界。"""

from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.api.v1.terminals import stream_terminal_events
from agent.terminal.access import TerminalOperation, authorize_operation, page_access
from agent.terminal.contracts import (
    TerminalEvent,
    TerminalShellMode,
    TerminalSource,
    TerminalStatus,
)
from app.models import ConversationSession, TerminalEventRecord, TerminalSessionRecord
from app.services.terminals import (
    append_shell_result,
    get_terminal,
    reopen_terminal,
    reset_terminal,
    rename_terminal,
    terminal_events,
    terminate_terminal,
)
import agent.terminal.access as terminal_access


def test_terminal_contract_has_stable_source_and_status_values():
    assert TerminalSource.AGENT.value == "agent"
    assert TerminalStatus.WAITING_CONFIRM.value == "waiting_confirm"
    assert TerminalShellMode.SANDBOX.value == "sandbox"
    assert TerminalEvent.__dataclass_fields__["sequence"].type == "int"


@pytest.mark.asyncio
async def test_terminal_page_hidden_when_admin_shell_is_disabled(db, user_a, monkeypatch):
    monkeypatch.setattr(
        terminal_access,
        "get_settings",
        lambda: SimpleNamespace(agent=SimpleNamespace(shell_enabled=False, shell_system_enabled=True)),
    )
    decision = await page_access(db, user_a.id)
    assert not decision.allowed
    assert decision.operation is TerminalOperation.VIEW


@pytest.mark.asyncio
async def test_terminal_page_can_show_without_workspace_when_shell_is_enabled(db, user_a, monkeypatch):
    monkeypatch.setattr(
        terminal_access,
        "get_settings",
        lambda: SimpleNamespace(agent=SimpleNamespace(shell_enabled=True, shell_system_enabled=False)),
    )
    monkeypatch.setattr(terminal_access, "effective_shell_enabled", _async_true)
    decision = await page_access(db, user_a.id)
    assert decision.allowed


@pytest.mark.asyncio
async def test_terminal_operations_reject_foreign_session(db, user_a, user_b):
    session = ConversationSession(user_id=user_b.id, title="他人的会话", source="web")
    db.add(session)
    await db.flush()

    decision = await authorize_operation(
        db, user_a.id, owner_id=user_a.id, session_id=session.id,
        operation=TerminalOperation.INPUT,
    )
    assert not decision.allowed
    assert decision.reason == "终端会话不存在"


@pytest.mark.asyncio
async def test_terminal_owner_can_terminate_or_close_after_permission_revoked(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="我的会话", source="web")
    db.add(session)
    await db.flush()

    for operation in (TerminalOperation.TERMINATE, TerminalOperation.DELETE, TerminalOperation.RESET):
        decision = await authorize_operation(
            db, user_a.id, owner_id=user_a.id, session_id=session.id,
            operation=operation,
        )
        assert decision.allowed


@pytest.mark.asyncio
async def test_terminal_events_preserve_user_source_and_sequence(db, user_a):
    terminal = TerminalSessionRecord(
        id="term-test-user", owner_id=user_a.id, name="测试终端",
        source="user", status="idle", shell_mode="sandbox", network_profile="none",
    )
    db.add(terminal)
    await db.flush()

    await append_shell_result(
        db, terminal, command="printf hello", stdout="hello", stderr="",
        exit_code=0, ok=True, source="user",
        run_id="run-test-001",
    )
    assert terminal.last_sequence == 1
    assert terminal.status == "idle"
    event = (await db.execute(select(TerminalEventRecord))).scalar_one()
    assert event.source == "user"
    assert event.run_id == "run-test-001"
    assert event.sequence == 1
    assert event.command == "printf hello"

    await terminate_terminal(db, terminal)
    status_event = (await terminal_events(db, terminal, after=1))[0]
    assert status_event.event_type == "status"
    assert terminal.status == "terminated"

    await rename_terminal(db, terminal, "用户终端")
    assert terminal.name == "用户终端"


@pytest.mark.asyncio
async def test_reset_terminal_keeps_history_but_clears_runtime_state(db, user_a):
    terminal = TerminalSessionRecord(
        id="term-reset", owner_id=user_a.id, name="重置终端", source="user",
        status="running", shell_mode="sandbox", network_profile="none",
        pty_pid=123, pty_sandbox_id="sandbox-test", pty_cols=120, pty_rows=32,
        output_chars=12, last_sequence=1,
    )
    db.add(terminal)
    await db.flush()

    await reset_terminal(db, terminal)

    assert terminal.status == "idle"
    assert terminal.closed_at is None
    assert terminal.pty_pid is None
    assert terminal.pty_sandbox_id is None
    assert terminal.pty_cols is None
    assert terminal.pty_rows is None
    assert terminal.output_chars == 12
    assert terminal.last_sequence == 1


@pytest.mark.asyncio
async def test_terminal_event_replay_is_ordered_and_respects_cursor(db, user_a):
    """防止重连从错误游标回放，导致旧输出重复或事件顺序错乱。"""
    terminal = TerminalSessionRecord(
        id="term-replay", owner_id=user_a.id, name="回放终端",
        source="user", status="idle", shell_mode="sandbox", network_profile="none",
    )
    db.add(terminal)
    await db.flush()

    await append_shell_result(
        db, terminal, command="printf one", stdout="one", stderr="",
        exit_code=0, ok=True, source=TerminalSource.USER.value,
        run_id="run-user-001",
    )
    await append_shell_result(
        db, terminal, command="printf two", stdout="two", stderr="",
        exit_code=0, ok=True, source=TerminalSource.AGENT.value,
        run_id="run-agent-002",
    )

    all_events = await terminal_events(db, terminal, after=0)
    resumed_events = await terminal_events(db, terminal, after=1)

    assert [event.sequence for event in all_events] == [1, 2]
    assert [event.source for event in all_events] == ["user", "agent"]
    assert all_events[0].run_id == "run-user-001"
    assert all_events[1].command == "printf two"
    assert [event.sequence for event in resumed_events] == [2]


@pytest.mark.asyncio
async def test_multiple_terminals_keep_event_streams_isolated(db, user_a):
    """防止切换终端后把另一终端的命令输出混入当前事件流。"""
    first = TerminalSessionRecord(
        id="term-isolated-a", owner_id=user_a.id, name="终端 A",
        source="user", status="idle", shell_mode="sandbox", network_profile="none",
    )
    second = TerminalSessionRecord(
        id="term-isolated-b", owner_id=user_a.id, name="终端 B",
        source="user", status="idle", shell_mode="sandbox", network_profile="none",
    )
    db.add_all([first, second])
    await db.flush()

    await append_shell_result(
        db, first, command="printf a", stdout="a", stderr="",
        exit_code=0, ok=True, source=TerminalSource.USER.value,
    )
    await append_shell_result(
        db, second, command="printf b", stdout="b", stderr="",
        exit_code=0, ok=True, source=TerminalSource.AGENT.value,
    )

    first_events = await terminal_events(db, first)
    second_events = await terminal_events(db, second)

    assert [(event.terminal_id, event.command) for event in first_events] == [(first.id, "printf a")]
    assert [(event.terminal_id, event.command) for event in second_events] == [(second.id, "printf b")]


@pytest.mark.asyncio
async def test_failed_terminal_command_persists_failure_feedback(db, user_a):
    """防止异常命令只更新页面错误而没有持久化失败状态和 stderr。"""
    terminal = TerminalSessionRecord(
        id="term-failed", owner_id=user_a.id, name="失败终端",
        source="user", status="idle", shell_mode="sandbox", network_profile="none",
    )
    db.add(terminal)
    await db.flush()

    await append_shell_result(
        db, terminal, command="false", stdout="", stderr="permission denied",
        exit_code=126, ok=False, source=TerminalSource.USER.value,
    )

    events = await terminal_events(db, terminal)
    assert terminal.status == TerminalStatus.FAILED.value
    assert terminal.output_chars == len("permission denied")
    assert len(events) == 1
    assert events[0].stderr == "permission denied"
    assert events[0].exit_code == 126
    assert events[0].source == TerminalSource.USER.value


@pytest.mark.asyncio
async def test_reopen_preserves_command_and_status_history(db, user_a):
    """防止关闭后重开终端清空既有输出，刷新页面也应继续从历史游标恢复。"""
    terminal = TerminalSessionRecord(
        id="term-history-reopen", owner_id=user_a.id, name="历史终端",
        source="user", status="idle", shell_mode="sandbox", network_profile="none",
    )
    db.add(terminal)
    await db.flush()
    await append_shell_result(
        db, terminal, command="printf keep", stdout="keep", stderr="",
        exit_code=0, ok=True, source=TerminalSource.USER.value,
    )
    await terminate_terminal(db, terminal)
    await reopen_terminal(db, terminal)

    events = await terminal_events(db, terminal, after=0)
    assert terminal.status == TerminalStatus.IDLE.value
    assert terminal.closed_at is None
    assert [event.sequence for event in events] == [1, 2]
    assert events[0].stdout == "keep"
    assert events[1].event_type == "status"


@pytest.mark.asyncio
async def test_terminal_sse_replays_closed_terminal_until_end_marker(db, user_a, monkeypatch):
    """防止刷新时 SSE 漏掉已持久化事件，或在终端已关闭时无法结束连接。"""
    monkeypatch.setattr(
        terminal_access,
        "get_settings",
        lambda: SimpleNamespace(agent=SimpleNamespace(shell_enabled=True, shell_system_enabled=False)),
    )
    monkeypatch.setattr(terminal_access, "effective_shell_enabled", _async_true)
    terminal = TerminalSessionRecord(
        id="term-sse-replay", owner_id=user_a.id, name="SSE 终端",
        source="user", status="idle", shell_mode="sandbox", network_profile="none",
    )
    db.add(terminal)
    await db.flush()
    await append_shell_result(
        db, terminal, command="printf sse", stdout="sse", stderr="",
        exit_code=0, ok=True, source=TerminalSource.USER.value,
    )
    await terminate_terminal(db, terminal)
    await db.commit()

    response = await stream_terminal_events(terminal.id, after=0, user=user_a)
    chunks = [chunk async for chunk in response.body_iterator]
    body = "".join(chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in chunks)

    assert '"sequence": 1' in body
    assert '"stdout": "sse"' in body
    assert '"type": "status"' in body
    assert "event: end\ndata: {}" in body


@pytest.mark.asyncio
async def test_terminal_lookup_is_owner_scoped(db, user_a, user_b):
    """防止拿到其他用户的 terminal_id 后读取或复用对方终端。"""
    terminal = TerminalSessionRecord(
        id="term-owner-only", owner_id=user_b.id, name="隔离终端",
        source="user", status="idle", shell_mode="sandbox", network_profile="none",
    )
    db.add(terminal)
    await db.flush()

    assert await get_terminal(db, user_a.id, terminal.id) is None
    assert await get_terminal(db, user_b.id, terminal.id) is not None


@pytest.mark.asyncio
async def test_exited_terminal_can_reopen_without_losing_history(db, user_a):
    terminal = TerminalSessionRecord(
        id="term-reopen", owner_id=user_a.id, name="可恢复终端",
        source="user", status="exited", shell_mode="sandbox", network_profile="none",
        closed_at=__import__("app.core.tz", fromlist=["now_utc"]).now_utc(),
    )
    db.add(terminal)
    await db.flush()

    await reopen_terminal(db, terminal)

    assert terminal.status == "idle"
    assert terminal.closed_at is None


@pytest.mark.asyncio
async def test_terminated_terminal_can_reopen(db, user_a):
    terminal = TerminalSessionRecord(
        id="term-reopen-terminated", owner_id=user_a.id, name="已终止终端",
        source="user", status="terminated", shell_mode="sandbox", network_profile="none",
        closed_at=__import__("app.core.tz", fromlist=["now_utc"]).now_utc(),
    )
    db.add(terminal)
    await db.flush()

    await reopen_terminal(db, terminal)

    assert terminal.status == "idle"
    assert terminal.closed_at is None


@pytest.mark.asyncio
async def test_terminal_input_allows_user_terminal_without_session(db, user_a, monkeypatch):
    monkeypatch.setattr(
        terminal_access,
        "get_settings",
        lambda: SimpleNamespace(agent=SimpleNamespace(shell_enabled=True, shell_system_enabled=False)),
    )
    monkeypatch.setattr(terminal_access, "effective_shell_enabled", _async_true)
    monkeypatch.setattr(terminal_access, "evaluate", _async_allowed_decision)
    terminal = TerminalSessionRecord(
        id="term-no-session", owner_id=user_a.id, name="观察终端",
        source="user", status="idle", shell_mode="sandbox", network_profile="none",
    )
    db.add(terminal)
    await db.flush()

    decision = await authorize_operation(
        db, user_a.id, owner_id=user_a.id, session_id=None,
        operation=TerminalOperation.INPUT,
    )
    assert decision.allowed
    assert decision.reason == "允许向终端输入"


async def _async_true(*_args, **_kwargs):
    return True


def _allowed_decision():
    from agent.security.shell_policy import ShellDecision, ShellRisk, ShellScope
    return ShellDecision(True, "允许", ShellRisk.SAFE, scope=ShellScope.SANDBOX)


async def _async_allowed_decision(*_args, **_kwargs):
    return _allowed_decision()
