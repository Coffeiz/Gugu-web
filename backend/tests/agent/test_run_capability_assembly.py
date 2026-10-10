"""各入口共用 run 组装：Shell 状态留在 system，任务授权不冒充会话。"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.run import preparation
from agent.run.preparation import prepare_scheduled_context


@pytest.mark.asyncio
@pytest.mark.parametrize("subject", [
    {"session_id": 7, "session": SimpleNamespace(id=7)},
    {"session_id": None, "subject_type": "scheduled_task", "subject_id": 9, "workspace_id": 3},
])
@pytest.mark.parametrize("use_anthropic", [False, True])
async def test_run_shell_state_is_system_only_and_keeps_authorization_subject(monkeypatch, subject, use_anthropic):
    prompt = "合成本轮 Shell 状态"
    filter_tools = AsyncMock(return_value=["shell"])
    build_prompt = AsyncMock(return_value=prompt)
    monkeypatch.setattr(preparation, "_filter_shell_tool", filter_tools)
    monkeypatch.setattr(preparation, "_capability_context", AsyncMock(return_value=None))
    monkeypatch.setattr("agent.security.shell_policy.build_dynamic_prompt", build_prompt)
    session_id = subject["session_id"]
    authorization = {key: value for key, value in subject.items() if key != "session_id"}
    names, system, snapshot, _ = await preparation.prepare_run_capabilities(
        None, "synthetic-user", session_id, ["shell"], SimpleNamespace(), "静态系统", "冻结快照",
        **authorization,
    )
    assert names == ["shell"]
    assert system.count(prompt) == 1
    assert snapshot == "冻结快照"
    for key, value in authorization.items():
        assert filter_tools.call_args.kwargs[key] == value
        assert build_prompt.call_args.kwargs[key] == value
    assert build_prompt.call_args.args[2] == session_id
    messages = prepare_scheduled_context(
        system, snapshot, None, "合成任务", {}, use_anthropic=use_anthropic,
    )
    messages = messages.provider_projection()
    # Chat 的 system 消息可以含状态；Anthropic 的 system 由单独参数传递。
    assert all(prompt not in str(message["content"]) for message in messages if message["role"] != "system")


@pytest.mark.asyncio
async def test_run_removes_shell_when_live_policy_cannot_supply_state(monkeypatch):
    monkeypatch.setattr(preparation, "_filter_shell_tool", AsyncMock(return_value=["shell", "read_file"]))
    capability = AsyncMock(return_value=None)
    monkeypatch.setattr(preparation, "_capability_context", capability)
    monkeypatch.setattr("agent.security.shell_policy.build_dynamic_prompt", AsyncMock(return_value=None))
    names, system, snapshot, _ = await preparation.prepare_run_capabilities(
        None, "synthetic-user", 7, ["shell", "read_file"], SimpleNamespace(), "静态系统", "冻结快照",
    )
    assert names == ["read_file"]
    assert capability.call_args.args[0] == names
    assert system == "静态系统"
    assert snapshot == "冻结快照"


@pytest.mark.asyncio
@pytest.mark.parametrize(("source", "expected_present"), [("telegram", False), ("web", True)])
async def test_present_file_is_available_by_current_entry_not_session_origin(
    monkeypatch, source, expected_present,
):
    """IM 入站不暴露网页播放器工具；网页继续 IM 历史会话仍保留该能力。"""
    monkeypatch.setattr(preparation, "_filter_shell_tool", AsyncMock(side_effect=lambda _db, _user, _session_id, names, **_kwargs: names))
    monkeypatch.setattr(preparation, "_capability_context", AsyncMock(return_value=None))
    names, *_ = await preparation.prepare_run_capabilities(
        None, "synthetic-user", 7, ["read_file", "present_file"], SimpleNamespace(),
        "静态系统", "冻结快照", source=source,
        session=SimpleNamespace(source="telegram"),
    )
    assert ("present_file" in names) is expected_present
