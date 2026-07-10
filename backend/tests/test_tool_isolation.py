"""工具层越权测试：A 拿着 B 的资源 id 调工具，必须得到「不存在」，绝不能拿到数据。

覆盖策略：不逐一打 60 个工具，而是打它们的**共用资源解析漏斗**——每个领域的
_resolve_* / 带归属校验的 handler。几乎所有按 id 操作的工具都经过这些漏斗，
漏斗安全 = 该领域按 id 的路径安全（按名字定位的路径查询本身就 where user_id，
由各自实现分别保证）。每个领域同时配一条「本人能正常访问」的正向对照，防止
隔离层写得过严把自己人也挡了。

新增领域/工具时：给它的 resolver 补一组 A→B 用例是**默认动作**（商用就绪评审
P0-2 的 CI 红线，scripts/check_ownership.py 静态守卫 + 本文件动态验证成对出现）。
"""
import json
from app.core.tz import now_utc

from app.models import (
    CalendarEvent, Client, ConversationSession, ConversationMessage,
    File, Folder, Project, ScheduledTask,
)

from agent.tools.files import _resolve_file, _resolve_key, _resolve_target
from agent.tools.projects import _resolve_project
from agent.tools.calendar import _resolve_event, _remove_event_reminder
from agent.tools.clients import _resolve_client
from agent.tools.scheduled_tasks import _resolve_task
from agent.tools.conversations import _read_conversation
from agent.tools.trash import _restore_file, _permanent_delete


def _is_err(res) -> bool:
    """handler 的错误路径返回 JSON 字符串 {"error": ...}。"""
    if isinstance(res, str):
        try:
            return "error" in json.loads(res)
        except Exception:
            return False
    return False


# ── fixtures 辅助：给 owner 造各领域资源 ──────────────────────────────────────

async def _mk(db, obj):
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


# ── files ─────────────────────────────────────────────────────────────────────

async def test_file_resolve_cross_user(db, user_a, user_b):
    f = await _mk(db, File(user_id=user_b.id, display_name="secret", ext="md", storage_key="k"))
    got, err = await _resolve_file(db, user_a.id, {"file_id": f.id})
    assert got is None and _is_err(err)


async def test_file_resolve_owner_ok(db, user_b):
    f = await _mk(db, File(user_id=user_b.id, display_name="mine", ext="md", storage_key="k"))
    got, err = await _resolve_file(db, user_b.id, {"file_id": f.id})
    assert err is None and got.id == f.id


async def test_resolve_key_cross_user_project(db, user_a, user_b):
    p = await _mk(db, Project(user_id=user_b.id, name="B的项目"))
    import pytest
    with pytest.raises(ValueError):
        await _resolve_key(db, user_a.id, "project", "doc", "md", project_id=p.id)


async def test_resolve_target_cross_user_folder(db, user_a, user_b):
    fo = await _mk(db, Folder(user_id=user_b.id, name="B的文件夹"))
    space, pid, fid, err = await _resolve_target(db, user_a.id, {"folder_id": fo.id})
    assert err is not None and "error" in err


# ── projects ──────────────────────────────────────────────────────────────────

async def test_project_resolve_cross_user(db, user_a, user_b):
    p = await _mk(db, Project(user_id=user_b.id, name="B的项目"))
    got, err = await _resolve_project(db, user_a.id, {"project_id": p.id})
    assert got is None and _is_err(err)


async def test_project_resolve_owner_ok(db, user_b):
    p = await _mk(db, Project(user_id=user_b.id, name="我的项目"))
    got, err = await _resolve_project(db, user_b.id, {"project_id": p.id})
    assert err is None and got.id == p.id


# ── calendar ──────────────────────────────────────────────────────────────────

async def test_event_resolve_cross_user(db, user_a, user_b):
    e = await _mk(db, CalendarEvent(user_id=user_b.id, title="B的活动", date="2026-07-02"))
    got, err = await _resolve_event(db, user_a.id, {"event_id": e.id})
    assert got is None and _is_err(err)


async def test_event_resolve_owner_ok(db, user_b):
    e = await _mk(db, CalendarEvent(user_id=user_b.id, title="我的活动", date="2026-07-02"))
    got, err = await _resolve_event(db, user_b.id, {"event_id": e.id})
    assert err is None and got.id == e.id


async def test_remove_event_reminder_cross_user(db, user_a, user_b):
    t = await _mk(db, ScheduledTask(user_id=user_b.id, event_id=1, name="B的提醒", cron="0 9 * * *"))
    res = await _remove_event_reminder(db, user_a.id, {"reminder_id": t.id})
    assert _is_err(res)
    assert await db.get(ScheduledTask, t.id) is not None   # B 的提醒必须还在


# ── clients ───────────────────────────────────────────────────────────────────

async def test_client_resolve_cross_user(db, user_a, user_b):
    c = await _mk(db, Client(user_id=user_b.id, name="B的客户"))
    got, err = await _resolve_client(db, user_a.id, {"client_id": c.id})
    assert got is None and _is_err(err)


async def test_client_resolve_owner_ok(db, user_b):
    c = await _mk(db, Client(user_id=user_b.id, name="我的客户"))
    got, err = await _resolve_client(db, user_b.id, {"client_id": c.id})
    assert err is None and got.id == c.id


# ── scheduled_tasks ───────────────────────────────────────────────────────────

async def test_task_resolve_cross_user(db, user_a, user_b):
    t = await _mk(db, ScheduledTask(user_id=user_b.id, name="B的任务", cron="0 9 * * *"))
    got, err = await _resolve_task(db, user_a.id, {"task_id": t.id})
    assert got is None and _is_err(err)


async def test_task_resolve_owner_ok(db, user_b):
    t = await _mk(db, ScheduledTask(user_id=user_b.id, name="我的任务", cron="0 9 * * *"))
    got, err = await _resolve_task(db, user_b.id, {"task_id": t.id})
    assert err is None and got.id == t.id


# ── conversations ─────────────────────────────────────────────────────────────

async def test_read_conversation_cross_user(db, user_a, user_b):
    s = await _mk(db, ConversationSession(user_id=user_b.id, title="B的私聊"))
    await _mk(db, ConversationMessage(session_id=s.id, role="user", content="B的秘密"))
    res = await _read_conversation(db, user_a.id, {"session_id": s.id})
    assert _is_err(res)
    assert "B的秘密" not in str(res)   # 内容一个字都不能漏


async def test_read_conversation_owner_ok(db, user_b):
    s = await _mk(db, ConversationSession(user_id=user_b.id, title="我的对话"))
    await _mk(db, ConversationMessage(session_id=s.id, role="user", content="hello"))
    res = await _read_conversation(db, user_b.id, {"session_id": s.id})
    assert not _is_err(res)


# ── trash ─────────────────────────────────────────────────────────────────────

async def test_restore_cross_user(db, user_a, user_b):
    from datetime import datetime
    f = await _mk(db, File(user_id=user_b.id, display_name="del", ext="md",
                           storage_key="k", deleted_at=now_utc()))
    res = await _restore_file(db, user_a.id, {"file_id": f.id})
    assert _is_err(res)
    await db.refresh(f)
    assert f.deleted_at is not None   # B 的文件必须还在回收站，没被 A 动过


async def test_permanent_delete_cross_user(db, user_a, user_b):
    from datetime import datetime
    f = await _mk(db, File(user_id=user_b.id, display_name="del", ext="md",
                           storage_key="k", deleted_at=now_utc()))
    res = await _permanent_delete(db, user_a.id, {"file_id": f.id, "confirm": True})
    assert _is_err(res)
    assert await db.get(File, f.id) is not None   # 即便带了 confirm 也删不掉别人的
