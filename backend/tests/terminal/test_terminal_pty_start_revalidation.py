"""PTY 宣布 RUNNING 前的 server-owned 复核（_revalidate_pty_start）。

回归背景：Workspace 删除路径只对 manager 扫描一次，扫不到「删除 commit 之后
才被 WebSocket 启动」的 PTY；旧实现第二次落库只查 state_row is not None，
会把已 terminated 的终端改回 RUNNING 并继续收输入。
"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import agent.security.shell_policy as shell_policy
import agent.terminal.access as terminal_access
from app.api.v1.terminals import _revalidate_pty_start
from app.models import TerminalSessionRecord, Workspace


def _terminal(user_id, **kw):
    defaults = dict(id="term-reval", owner_id=user_id, name="测试终端",
                    source="user", status="idle", shell_mode="sandbox",
                    network_profile="none")
    defaults.update(kw)
    return TerminalSessionRecord(**defaults)


def _shell_enabled(monkeypatch):
    settings = SimpleNamespace(
        agent=SimpleNamespace(shell_enabled=True, shell_system_enabled=False),
        sandbox=SimpleNamespace(enabled=True),
    )
    for mod in (terminal_access, shell_policy):
        monkeypatch.setattr(mod, "get_settings", lambda: settings)
        monkeypatch.setattr(mod, "sandbox_readiness", lambda _s: (True, "就绪"))
        monkeypatch.setattr(mod, "effective_shell_enabled", _async_true)


async def _async_true(*_a, **_kw):
    return True


@pytest.mark.asyncio
async def test_revalidation_passes_for_open_terminal(db, user_a, monkeypatch):
    _shell_enabled(monkeypatch)
    binding = Workspace(user_id=user_a.id, name="工作区W")
    db.add(binding)
    await db.flush()
    db.add(_terminal(user_a.id, workspace_id=binding.id))
    await db.commit()

    row = await _revalidate_pty_start(db, user_a.id, "term-reval", binding.id)
    assert row.id == "term-reval"


@pytest.mark.asyncio
async def test_revalidation_rejects_terminated_terminal(db, user_a):
    """DELETE 把终端标 terminated 后 commit，随后才到的 WS 启动必须被拒。"""
    db.add(_terminal(user_a.id, status="terminated", closed_at=None))
    await db.commit()
    with pytest.raises(HTTPException) as ei:
        await _revalidate_pty_start(db, user_a.id, "term-reval", None)
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_revalidation_rejects_closed_terminal(db, user_a):
    """closed 终端必须走显式 reopen，setup 不得直接复活。"""
    from app.core.tz import now_utc
    db.add(_terminal(user_a.id, closed_at=now_utc()))
    await db.commit()
    with pytest.raises(HTTPException) as ei:
        await _revalidate_pty_start(db, user_a.id, "term-reval", None)
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_revalidation_rejects_workspace_binding_change(db, user_a):
    """auth 时授权的 workspace 与当前行的绑定不一致（如被 SET NULL）→ 拒绝。"""
    db.add(_terminal(user_a.id, workspace_id=None))
    await db.commit()
    with pytest.raises(HTTPException) as ei:
        await _revalidate_pty_start(db, user_a.id, "term-reval", 42)
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_revalidation_rejects_deleted_workspace_binding(db, user_a):
    db.add(_terminal(user_a.id, workspace_id=None))
    await db.commit()
    with pytest.raises(HTTPException) as ei:
        # 行上 workspace_id 未变但 binding 行已不存在（FK 尚未生效的测试库）也要拦。
        await _revalidate_pty_start(db, user_a.id, "term-reval", 999)
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_revalidation_rejects_missing_terminal(db, user_a):
    with pytest.raises(HTTPException) as ei:
        await _revalidate_pty_start(db, user_a.id, "term-nope", None)
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_revalidation_uses_owner_scoped_lookup(db, user_a, user_b):
    """他人不能凭 terminal_id 复核启动自己的会话。"""
    db.add(_terminal(user_b.id))
    await db.commit()
    with pytest.raises(HTTPException) as ei:
        await _revalidate_pty_start(db, user_a.id, "term-reval", None)
    assert ei.value.status_code == 404

