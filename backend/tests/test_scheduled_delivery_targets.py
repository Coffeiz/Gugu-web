from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_group_delivery_mode_captures_current_qq_group():
    from agent import imctx
    from agent.tools.scheduled_tasks import _resolve_delivery_targets

    imctx.set_im(
        "qqbot",
        "message-1",
        "bot-1",
        "group-1",
        "owner-1",
        "group",
    )
    try:
        targets, error = await _resolve_delivery_targets(
            None, "user-1", ["qq"], "current_group"
        )
    finally:
        imctx.clear()

    assert error is None
    assert targets == {
        "qq": {
            "chat_type": "group",
            "chat_id": "group-1",
            "puid": "owner-1",
            "channel_id": "bot-1",
        }
    }


@pytest.mark.asyncio
async def test_group_delivery_mode_rejects_web_context():
    from agent.tools.scheduled_tasks import _resolve_delivery_targets

    targets, error = await _resolve_delivery_targets(
        None, "user-1", ["qq"], "current_group"
    )

    assert targets is None
    assert "只有在 QQ 群聊中" in error


@pytest.mark.asyncio
async def test_group_delivery_mode_requires_confirmation_when_omitted():
    from agent import imctx
    from agent.tools.scheduled_tasks import (
        _delivery_mode_confirmation_error,
        _group_delivery_mode_required,
    )

    imctx.set_im(
        "qqbot",
        "message-2",
        "bot-2",
        "group-2",
        "member-2",
        "group",
    )
    try:
        assert _group_delivery_mode_required(["qq"], None)
        assert not _group_delivery_mode_required(["qq"], "owner_private")
        assert not _group_delivery_mode_required(["qq"], "current_group")
        assert "请先确认投递位置" in _delivery_mode_confirmation_error()
    finally:
        imctx.clear()


@pytest.mark.asyncio
async def test_delivery_uses_task_target_instead_of_recent_reach(monkeypatch):
    import app.scheduled_tasks as scheduled

    send = AsyncMock(return_value=True)
    persist = AsyncMock()
    monkeypatch.setattr(scheduled, "_deliver_im", send)
    monkeypatch.setattr(scheduled, "_persist_push_im", persist)

    target = {
        "chat_type": "group",
        "chat_id": "group-1",
        "puid": "owner-1",
        "channel_id": "bot-1",
    }
    result = await scheduled.deliver_to_channels(
        "user-1", "任务", "正文", {"qq"}, {"qq": target}
    )

    assert result == {"QQ": "已发送"}
    assert send.await_args.args == ("user-1", "⏰ 任务\n\n正文", "qqbot", target)
    persist.assert_awaited_once_with("user-1", "qqbot", "任务", "正文", target)


@pytest.mark.asyncio
async def test_execute_task_passes_structured_target_to_delivery(monkeypatch, db, user_a):
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask

    target = {
        "qq": {
            "chat_type": "group",
            "chat_id": "group-1",
            "puid": "owner-1",
            "channel_id": "bot-1",
        }
    }
    task = ScheduledTask(
        user_id=user_a.id,
        name="群提醒",
        payload="提醒我检查群消息",
        cron="0 9 * * *",
        channels="qq",
        delivery_targets=target,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    run_agent = AsyncMock(return_value="提醒正文")
    deliver = AsyncMock(return_value={"QQ": "已发送"})
    monkeypatch.setattr(scheduled, "_run_agent", run_agent)
    monkeypatch.setattr(scheduled, "deliver_to_channels", deliver)

    result = await scheduled.execute_task(task.id)

    assert result == {"QQ": "已发送"}
    assert deliver.await_args.args == (user_a.id, "群提醒", "提醒正文", {"qq"}, target)


@pytest.mark.asyncio
async def test_update_group_target_confirmation_does_not_mutate_task(monkeypatch):
    from agent import imctx
    import agent.tools.scheduled_tasks as skill

    task = SimpleNamespace(
        channels="qq",
        payload="旧指令",
        name="任务",
        cron="0 9 * * *",
        context_config=None,
    )
    monkeypatch.setattr(
        skill,
        "_resolve_task",
        AsyncMock(return_value=(task, None)),
    )
    db = SimpleNamespace(commit=AsyncMock(), refresh=AsyncMock())
    imctx.set_im(
        "qqbot",
        "message-3",
        "bot-3",
        "group-3",
        "member-3",
        "group",
    )
    try:
        result = await skill._update_scheduled_task(
            db,
            "user-1",
            {"task": "任务", "instruction": "新指令", "channels": ["qq"]},
        )
    finally:
        imctx.clear()

    assert "确认投递位置" in result
    assert task.payload == "旧指令"
    db.commit.assert_not_awaited()
