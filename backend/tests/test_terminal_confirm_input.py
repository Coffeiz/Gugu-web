"""终端 /input 确认码回归：三条路都必须行为正确（P0 回归）。

1. 不带 confirmCode：命令照常进入 _shell（危险命令由确认门拦截，普通命令直接执行）；
2. 合法 confirmCode：服务端兑换授权后命令执行；
3. 非法/过期 confirmCode：不执行命令，用户能看到明确错误。
"""

import uuid

import pytest

from app.api.v1 import terminals as terminals_api
from app.models import TerminalSessionRecord
from agent.interactions import confirmations


@pytest.fixture
async def terminal_row(db, user_a):
    row = TerminalSessionRecord(
        id=f"term-{uuid.uuid4().hex[:12]}", owner_id=user_a.id, name="测试终端",
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _mk_body(**kw):
    return terminals_api.TerminalInput(command="echo hi", **kw)


@pytest.fixture
def shell_spy(monkeypatch):
    """记录进入 _shell 的调用，并捕获推送给前端的事件载荷。"""
    calls = {"shell": [], "events": []}

    async def _fake_shell(db, user_id, args):
        calls["shell"].append({"user_id": user_id, **args})
        return {"ok": True, "exit_code": 0, "stdout": "hi", "stderr": "",
                "timed_out": False, "truncated": False, "cwd": "."}

    async def _fake_publish(user_id, channel, *, operation=None, entity_id=None, event_payload=None):
        calls["events"].append(event_payload)

    monkeypatch.setattr(terminals_api, "_shell", _fake_shell)
    monkeypatch.setattr(terminals_api.events, "publish", _fake_publish)
    return calls


@pytest.mark.asyncio
async def test_terminal_input_without_code_executes(db, user_a, terminal_row, shell_spy):
    """普通命令不带确认码：必须真的执行（此前这里是一条永不执行的死路）。"""
    await terminals_api._run_terminal_command(
        user_a.id, terminal_row.id, uuid.uuid4().hex, _mk_body())
    assert len(shell_spy["shell"]) == 1
    assert shell_spy["shell"][0]["command"] == "echo hi"


@pytest.mark.asyncio
async def test_terminal_input_with_valid_code_executes(db, user_a, terminal_row, shell_spy):
    """用户确认后的合法确认码：兑换授权成功，命令执行。"""
    code = confirmations._create_pending(
        user_a.id, "将在当前工作区执行危险命令：rm -rf /tmp/x", None, 5)
    assert code
    await terminals_api._run_terminal_command(
        user_a.id, terminal_row.id, uuid.uuid4().hex, _mk_body(confirmCode=code))
    assert len(shell_spy["shell"]) == 1


@pytest.mark.asyncio
async def test_terminal_input_with_invalid_code_rejected(db, user_a, terminal_row, shell_spy):
    """非法确认码：不执行命令，前端收到明确错误事件。"""
    await terminals_api._run_terminal_command(
        user_a.id, terminal_row.id, uuid.uuid4().hex, _mk_body(confirmCode="deadbeef1234"))
    assert shell_spy["shell"] == []
    errors = [
        payload for payload in shell_spy["events"]
        if isinstance(payload, dict) and "确认码无效或已过期" in str(payload.get("event", {}).get("stderr", ""))
    ]
    assert errors, f"应推送确认码无效的错误事件，实际事件：{shell_spy['events']}"
