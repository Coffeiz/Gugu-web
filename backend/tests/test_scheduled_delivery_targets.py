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
async def test_legacy_task_never_uses_recent_group_reach(monkeypatch):
    import app.scheduled_tasks as scheduled

    send = AsyncMock(return_value=False)
    monkeypatch.setattr(scheduled, "_deliver_im", send)
    monkeypatch.setattr(scheduled, "_legacy_private_target", AsyncMock(return_value=None))

    result = await scheduled.deliver_to_channels(
        "user-1", "旧任务", "正文", {"qq"}, delivery_targets=None
    )

    assert result == {"QQ": "无可触达地址（先给该 bot 发条消息）"}
    send.assert_awaited_once_with("user-1", "⏰ 旧任务\n\n正文", "qqbot", None)


@pytest.mark.asyncio
async def test_legacy_task_uses_owner_private_target(monkeypatch):
    import app.scheduled_tasks as scheduled

    send = AsyncMock(return_value=True)
    persist = AsyncMock()
    target = {
        "chat_type": "c2c",
        "chat_id": None,
        "puid": "owner-1",
        "channel_id": "bot-1",
    }
    monkeypatch.setattr(scheduled, "_deliver_im", send)
    monkeypatch.setattr(scheduled, "_legacy_private_target", AsyncMock(return_value=target))
    monkeypatch.setattr(scheduled, "_persist_push_im", persist)

    result = await scheduled.deliver_to_channels(
        "user-1", "旧任务", "正文", {"qq"}, delivery_targets=None
    )

    assert result == {"QQ": "已发送"}
    send.assert_awaited_once_with("user-1", "⏰ 旧任务\n\n正文", "qqbot", target)
    persist.assert_awaited_once_with("user-1", "qqbot", "旧任务", "正文", target)


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


@pytest.mark.asyncio
async def test_ephemeral_trial_does_not_wait_for_background_retry(monkeypatch):
    import agent.runner as runner

    once = AsyncMock(return_value=("模型暂时不可用", True))
    sleep = AsyncMock()
    monkeypatch.setattr(runner, "_run_ephemeral_once", once)
    monkeypatch.setattr(runner.asyncio, "sleep", sleep)

    result = await runner.run_ephemeral(
        "user-1", "测试用户", "测试任务", retry=False
    )

    assert result == "模型暂时不可用"
    once.assert_awaited_once()
    sleep.assert_not_awaited()


@pytest.mark.asyncio
async def test_trial_does_not_hold_request_db_session_during_agent(monkeypatch):
    from types import SimpleNamespace

    import app.api.v1.scheduled_tasks as scheduled_api
    import app.scheduled_tasks as scheduled

    events = []
    db = SimpleNamespace(
        close=AsyncMock(side_effect=lambda: events.append("close")),
    )
    user = SimpleNamespace(id="user-1")
    monkeypatch.setattr(scheduled_api, "_owned", AsyncMock())
    execute = AsyncMock(
        side_effect=lambda *args, **kwargs: events.append("execute") or {"网页通知": "已发送"}
    )
    monkeypatch.setattr(scheduled, "execute_task", execute)

    result = await scheduled_api.run_now(42, user, db)

    assert result["ok"] is True
    assert events == ["close", "execute"]
    execute.assert_awaited_once_with(42, is_trial=True)


@pytest.mark.asyncio
async def test_trial_does_not_update_last_run_at(monkeypatch, db, user_a):
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask

    task = ScheduledTask(
        user_id=user_a.id,
        name="试运行不计入正式执行",
        payload="只测试一次",
        cron="0 9 * * *",
        channels="web",
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    monkeypatch.setattr(scheduled, "_run_agent", AsyncMock(return_value="测试正文"))
    monkeypatch.setattr(
        scheduled,
        "deliver_to_channels",
        AsyncMock(return_value={"web 通知": "已发送"}),
    )

    result = await scheduled.execute_task(task.id, is_trial=True)

    assert result == {"web 通知": "已发送"}
    await db.refresh(task)
    assert task.last_run_at is None
