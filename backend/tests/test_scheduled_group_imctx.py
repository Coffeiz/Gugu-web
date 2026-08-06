"""群定时任务 imctx + 群 memory 注入测试（PRD-IM-7）。

覆盖：
- _detect_group_target 三种场景（群 / 私聊 / 空）
- 群定时任务执行时 imctx 正确（set_im 参数）
- 私聊/网页任务不调 set_im
- 群定时任务 user prompt 包含群 memory 段
- 群定时任务 message_id=None
- 无群目标时 prompt 不被注入群 memory（兜底）
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest


# ── _detect_group_target ────────────────────────────────────────────────────

def test_detect_group_target_picks_group():
    """delivery_targets 里 chat_type=group 且有 chat_id 的目标被识别。"""
    from app.scheduled_tasks import _detect_group_target
    target_map = {
        "qq": {
            "platform": "qq",
            "chat_type": "group",
            "chat_id": "group_abc123",
            "channel_id": "bot_1",
            "puid": "owner_puid",
        }
    }
    assert _detect_group_target(target_map) == target_map["qq"]


def test_detect_group_target_skips_private():
    """chat_type=c2c 的私聊目标不被识别。"""
    from app.scheduled_tasks import _detect_group_target
    target_map = {
        "qq": {
            "platform": "qq",
            "chat_type": "c2c",
            "chat_id": None,
            "channel_id": "bot_1",
            "puid": "owner_puid",
        }
    }
    assert _detect_group_target(target_map) is None


def test_detect_group_target_none():
    """空 / 非法 target_map 返回 None。"""
    from app.scheduled_tasks import _detect_group_target
    assert _detect_group_target(None) is None
    assert _detect_group_target({}) is None
    # 群目标但缺 chat_id
    assert _detect_group_target({"qq": {"chat_type": "group", "chat_id": None}}) is None


# ── _run_agent 群 imctx + 群 memory 注入 ────────────────────────────────────

@pytest.mark.asyncio
async def test_run_agent_group_target_sets_imctx(monkeypatch, db, user_a):
    """群定时任务执行：set_im 被调，参数正确（chat_type=group, message_id=None, 群 id 透传）。"""
    import app.scheduled_tasks as scheduled

    captured = {}

    def fake_set_im(platform, message_id, channel_id, chat_id, puid=None,
                    chat_type=None, context_token="", allowed_tool_names=None,
                    im_role=None):
        captured["platform"] = platform
        captured["message_id"] = message_id
        captured["channel_id"] = channel_id
        captured["chat_id"] = chat_id
        captured["puid"] = puid
        captured["chat_type"] = chat_type
        return "token"

    # set_im 是 _inject_group_context 函数体内 from agent.imctx import set_im 局部 import，
    # monkeypatch 改 agent.imctx.set_im 才能拦截。
    monkeypatch.setattr("agent.imctx.set_im", fake_set_im)
    # preview_scope 同理。
    monkeypatch.setattr(
        "agent.memory.scope_lifecycle.preview_scope",
        AsyncMock(return_value={}),
    )

    execution = AsyncMock(return_value=("执行结果", False, {"tool_names": [], "mutated": False}))
    report = AsyncMock()
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", report)

    target_map = {
        "qq": {
            "platform": "qq",
            "chat_type": "group",
            "chat_id": "group_xyz",
            "channel_id": "bot_42",
            "puid": "owner_puid",
        }
    }

    await scheduled._run_agent(user_a.id, "原 prompt", target_map=target_map, trial=True)

    assert captured == {
        "platform": "qq",
        "message_id": None,
        "channel_id": "bot_42",
        "chat_id": "group_xyz",
        "puid": "owner_puid",
        "chat_type": "group",
    }


@pytest.mark.asyncio
async def test_run_agent_private_target_no_imctx(monkeypatch, db, user_a):
    """私聊/Web 任务：不调 set_im，prompt 不被注入群 memory。"""
    import app.scheduled_tasks as scheduled

    set_im_called = {"count": 0}

    def fake_set_im(*args, **kwargs):
        set_im_called["count"] += 1
        return "token"

    monkeypatch.setattr("agent.imctx.set_im", fake_set_im)

    execution = AsyncMock(return_value=("ok", False, {"tool_names": [], "mutated": False}))
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", AsyncMock())

    # 私聊目标
    target_map = {
        "qq": {
            "platform": "qq",
            "chat_type": "c2c",
            "chat_id": None,
            "channel_id": "bot_1",
            "puid": "owner_puid",
        }
    }
    await scheduled._run_agent(user_a.id, "原 prompt", target_map=target_map, trial=True)
    assert set_im_called["count"] == 0

    # 无 target_map
    set_im_called["count"] = 0
    await scheduled._run_agent(user_a.id, "原 prompt", trial=True)
    assert set_im_called["count"] == 0


@pytest.mark.asyncio
async def test_run_agent_group_injects_group_memory(monkeypatch, db, user_a):
    """群定时任务：execution 阶段的 prompt 包含群 memory 段（format_im_memory 输出）。"""
    import app.scheduled_tasks as scheduled

    monkeypatch.setattr("agent.imctx.set_im", lambda *a, **kw: "token")
    monkeypatch.setattr(
        "agent.memory.scope_lifecycle.preview_scope",
        AsyncMock(return_value={"profile": "群简介：测试群", "summary": "群近况：稳定"}),
    )

    # 抓取 execution 阶段收到的 prompt
    captured_prompts = {}

    async def fake_execution(user_id, user_name, prompt):
        captured_prompts["execution"] = prompt
        return ("执行结果", False, {"tool_names": [], "mutated": False})

    monkeypatch.setattr("agent.runner.run_scheduled_execution", fake_execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", AsyncMock())

    target_map = {
        "qq": {
            "platform": "qq",
            "chat_type": "group",
            "chat_id": "group_xyz",
            "channel_id": "bot_42",
            "puid": "owner_puid",
        }
    }

    await scheduled._run_agent(user_a.id, "原 prompt", target_map=target_map, trial=True)

    # execution 阶段拿到的 prompt 应该以群 memory 开头
    p = captured_prompts["execution"]
    assert "## 当前群组记忆" in p
    assert "群简介：测试群" in p
    assert "原 prompt" in p
    # 群 memory 段应该在原 prompt 之前
    assert p.index("## 当前群组记忆") < p.index("原 prompt")


@pytest.mark.asyncio
async def test_run_agent_group_message_id_none(monkeypatch, db, user_a):
    """群定时任务 set_im 的 message_id 必须是 None（定时任务无具体触发的 IM 消息）。"""
    import app.scheduled_tasks as scheduled

    captured = {}

    def fake_set_im(platform, message_id, channel_id, chat_id, puid=None, **kw):
        captured["message_id"] = message_id
        return "token"

    monkeypatch.setattr("agent.imctx.set_im", fake_set_im)
    monkeypatch.setattr(
        "agent.memory.scope_lifecycle.preview_scope",
        AsyncMock(return_value={}),
    )
    execution = AsyncMock(return_value=("ok", False, {"tool_names": [], "mutated": False}))
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", AsyncMock())

    target_map = {
        "qq": {
            "platform": "qq",
            "chat_type": "group",
            "chat_id": "g1",
            "channel_id": "bot_1",
            "puid": "p1",
        }
    }
    await scheduled._run_agent(user_a.id, "prompt", target_map=target_map, trial=True)
    assert captured["message_id"] is None


@pytest.mark.asyncio
async def test_run_agent_no_group_memory_when_no_target(monkeypatch, db, user_a):
    """兜底：无群目标时，execution 拿到的 prompt 完全等于入参（不注入群 memory）。"""
    import app.scheduled_tasks as scheduled

    captured_prompts = {}

    async def fake_execution(user_id, user_name, prompt):
        captured_prompts["execution"] = prompt
        return ("ok", False, {"tool_names": [], "mutated": False})

    monkeypatch.setattr("agent.runner.run_scheduled_execution", fake_execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", AsyncMock())

    # 不传 target_map
    await scheduled._run_agent(user_a.id, "原始 prompt", trial=True)
    assert captured_prompts["execution"] == "原始 prompt"

    # 私聊 target_map
    captured_prompts.clear()
    target_map = {
        "qq": {"platform": "qq", "chat_type": "c2c", "chat_id": None, "channel_id": "b1", "puid": "p1"}
    }
    await scheduled._run_agent(user_a.id, "原始 prompt", target_map=target_map, trial=True)
    assert captured_prompts["execution"] == "原始 prompt"


@pytest.mark.asyncio
async def test_run_agent_group_missing_bot_id_skips_memory(monkeypatch, db, user_a):
    """群目标但缺 channel_id（bot_id）：set_im 仍调（让 group_context_search 可用），但 preview_scope 跳过。"""
    import app.scheduled_tasks as scheduled

    set_im_called = {"count": 0}
    preview_called = {"count": 0}

    def fake_set_im(*a, **kw):
        set_im_called["count"] += 1
        return "token"

    async def fake_preview(*a, **kw):
        preview_called["count"] += 1
        return {}

    monkeypatch.setattr("agent.imctx.set_im", fake_set_im)
    monkeypatch.setattr("agent.memory.scope_lifecycle.preview_scope", fake_preview)

    captured_prompts = {}

    async def fake_execution(user_id, user_name, prompt):
        captured_prompts["execution"] = prompt
        return ("ok", False, {"tool_names": [], "mutated": False})

    monkeypatch.setattr("agent.runner.run_scheduled_execution", fake_execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", AsyncMock())

    target_map = {
        "qq": {
            "platform": "qq",
            "chat_type": "group",
            "chat_id": "g1",
            "channel_id": None,   # 缺
            "puid": "p1",
        }
    }
    await scheduled._run_agent(user_a.id, "原 prompt", target_map=target_map, trial=True)
    # set_im 仍调
    assert set_im_called["count"] == 1
    # preview_scope 跳过（没 bot_id）
    assert preview_called["count"] == 0
    # prompt 不含群 memory 段
    assert "## 当前群组记忆" not in captured_prompts["execution"]
