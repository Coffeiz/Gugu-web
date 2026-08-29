from datetime import datetime, timezone

from agent.terminal.contracts import (
    TerminalMode,
    TerminalSession,
    TerminalShellMode,
    TerminalSource,
    TerminalStatus,
)


def test_terminal_modes_keep_agent_and_interactive_protocols_distinct():
    now = datetime.now(timezone.utc)
    user_terminal = TerminalSession(
        terminal_id="term-user",
        owner_id="user-a",
        session_id=None,
        workspace_id=None,
        source=TerminalSource.USER,
        mode=TerminalMode.INTERACTIVE_PTY,
        status=TerminalStatus.RUNNING,
        shell_mode=TerminalShellMode.SANDBOX,
        network_profile="none",
        created_at=now,
        updated_at=now,
        pty_cols=120,
        pty_rows=32,
    )
    agent_terminal = TerminalSession(
        terminal_id="term-agent",
        owner_id="user-a",
        session_id=7,
        workspace_id=3,
        source=TerminalSource.AGENT,
        mode=TerminalMode.AGENT_EVENTS,
        status=TerminalStatus.IDLE,
        shell_mode=TerminalShellMode.SANDBOX,
        network_profile="none",
        created_at=now,
        updated_at=now,
    )

    assert (user_terminal.source, user_terminal.mode) == (TerminalSource.USER, TerminalMode.INTERACTIVE_PTY)
    assert (agent_terminal.source, agent_terminal.mode) == (TerminalSource.AGENT, TerminalMode.AGENT_EVENTS)
    assert user_terminal.pty_cols == 120
    assert agent_terminal.pty_cols is None


def test_terminal_session_defaults_do_not_claim_a_live_pty():
    now = datetime.now(timezone.utc)
    terminal = TerminalSession(
        terminal_id="term-agent",
        owner_id="user-a",
        session_id=None,
        workspace_id=None,
        source=TerminalSource.AGENT,
        mode=TerminalMode.AGENT_EVENTS,
        status=TerminalStatus.IDLE,
        shell_mode=TerminalShellMode.SANDBOX,
        network_profile="none",
        created_at=now,
        updated_at=now,
    )

    assert terminal.pty_pid is None
    assert terminal.pty_sandbox_id is None
    assert terminal.attached_clients == 0
