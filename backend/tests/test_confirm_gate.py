"""删除确认门测试：destructive 工具「缺 confirm 必被拒、资源必须还在」。

三层验证（商用就绪评审 P0-3）：
1. 全部 5 个 destructive 工具：不带 confirm 调用 → 返回 needs_confirm 拦截、资源原封不动；
2. 单带 confirm=true 仍须拒绝；仅携带上一轮凭证时才真正执行；
3. dispatch 层绊线：假造一个漏接确认门的 destructive 工具，无 confirm 的调用返回了
   "成功执行" → 必须触发 confirm-gate.bypassed CRITICAL 日志（运行时兜底的行为契约）。
4. 静态守卫 scripts/check_confirm_gate.py 对当前代码库必须全绿（AST 校验回归）。
"""
import json
from datetime import timedelta
from app.core.tz import now_utc
import logging

from app.models import CalendarEvent, Client, File, Project, ScheduledTask

from agent.tools.calendar import _delete_event
from agent.tools.clients import _delete_client
from agent.tools.projects import _delete_project
from agent.tools.scheduled_tasks import _delete_scheduled_task
from agent.tools.trash import _permanent_delete


def _blocked(res) -> bool:
    from agent.security import confirm
    return confirm.is_block(res)


def _confirm_token(res) -> str:
    payload = json.loads(res) if isinstance(res, str) else res
    return payload["confirm_token"]


async def _mk(db, obj):
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


# ── 1. 五个 destructive 工具：缺 confirm 必被拒 ────────────────────────────────

async def test_delete_project_requires_confirm(db, user_a):
    p = await _mk(db, Project(user_id=user_a.id, name="要删的项目"))
    res = await _delete_project(db, user_a.id, {"project_id": p.id})
    assert _blocked(res)
    assert await db.get(Project, p.id) is not None


async def test_delete_event_requires_confirm(db, user_a):
    e = await _mk(db, CalendarEvent(user_id=user_a.id, title="要删的活动", date="2026-07-02"))
    res = await _delete_event(db, user_a.id, {"event_id": e.id})
    assert _blocked(res)
    assert await db.get(CalendarEvent, e.id) is not None


async def test_delete_client_requires_confirm(db, user_a):
    c = await _mk(db, Client(user_id=user_a.id, name="要删的客户"))
    res = await _delete_client(db, user_a.id, {"client_id": c.id})
    assert _blocked(res)
    assert await db.get(Client, c.id) is not None


async def test_delete_scheduled_task_requires_confirm(db, user_a):
    t = await _mk(db, ScheduledTask(user_id=user_a.id, name="要删的任务", cron="0 9 * * *"))
    res = await _delete_scheduled_task(db, user_a.id, {"task_id": t.id})
    assert _blocked(res)
    assert await db.get(ScheduledTask, t.id) is not None


async def test_permanent_delete_requires_confirm(db, user_a):
    from datetime import datetime
    f = await _mk(db, File(user_id=user_a.id, display_name="del", ext="md",
                           storage_key="k", deleted_at=now_utc()))
    res = await _permanent_delete(db, user_a.id, {"file_id": f.id})
    assert _blocked(res)
    assert await db.get(File, f.id) is not None


# ── 2. confirm 必须带上一轮凭证，防模型自行补 confirm=true ───────────────────

async def test_delete_client_rejects_confirm_without_prior_token(db, user_a):
    c = await _mk(db, Client(user_id=user_a.id, name="确认后删"))
    res = await _delete_client(db, user_a.id, {"client_id": c.id, "confirm": True})
    assert _blocked(res)
    assert await db.get(Client, c.id) is not None


async def test_delete_client_with_prior_token_executes(db, user_a):
    c = await _mk(db, Client(user_id=user_a.id, name="确认后删"))
    blocked = await _delete_client(db, user_a.id, {"client_id": c.id})
    res = await _delete_client(db, user_a.id, {
        "client_id": c.id,
        "confirm": True,
        "confirm_token": _confirm_token(blocked),
    })
    assert isinstance(res, dict) and res.get("success")
    assert await db.get(Client, c.id) is None


def test_confirmation_lease_can_use_explicit_ttl(user_a):
    from agent.security import confirm
    from app.core.config import get_settings
    from jose import jwt

    blocked = confirm.needs_confirmation(
        {},
        "允许当前会话执行只读网络请求",
        user_a.id,
        identity="shell:network-read:1:sandbox",
        ttl_minutes=30,
    )
    payload = jwt.decode(
        json.loads(blocked)["confirm_token"],
        get_settings().secret_key,
        algorithms=["HS256"],
    )
    remaining = payload["exp"] - now_utc().timestamp()
    assert 29 * 60 < remaining <= 30 * 60
    assert json.loads(blocked)["authorization_ttl_minutes"] == 30


async def test_batch_delete_client_uses_one_target_bound_confirmation(db, user_a):
    first = await _mk(db, Client(user_id=user_a.id, name="批量客户一"))
    second = await _mk(db, Client(user_id=user_a.id, name="批量客户二"))
    args = {"client_ids": [first.id, second.id]}
    blocked = await _delete_client(db, user_a.id, args)
    assert _blocked(blocked)
    token = _confirm_token(blocked)

    # 确认凭证不能被换成另一组目标复用。
    wrong = await _delete_client(db, user_a.id, {
        "client_ids": [first.id], "confirm": True, "confirm_token": token,
    })
    assert _blocked(wrong)
    result = await _delete_client(db, user_a.id, {
        **args, "confirm": True, "confirm_token": token,
    })
    assert result["success"] and result["deleted_count"] == 2
    assert await db.get(Client, first.id) is None
    assert await db.get(Client, second.id) is None


# ── 3. dispatch 绊线：漏接确认门的 destructive 工具必须触发 CRITICAL ──────────

async def test_dispatch_tripwire_fires_on_gate_bypass(user_a, monkeypatch, caplog):
    from agent.tools import base as base_mod
    import app.db.session as sess_mod

    # dispatch 会自开 DB 会话——测试里替换成假会话（假工具不用 db），保持封闭
    class _FakeSession:
        async def __aenter__(self):
            return None
        async def __aexit__(self, *a):
            return False
    monkeypatch.setattr(sess_mod, "_engine", object())
    monkeypatch.setattr(sess_mod, "_SessionLocal", lambda: _FakeSession())

    async def _bad_handler(db, user_id, args):   # 漏接确认门：无 confirm 也直接"执行成功"
        return {"success": True, "deleted": 1}

    bad = base_mod.Tool(name="_test_bad_delete", label="测试假删除",
                        description="test", input_schema={"type": "object", "properties": {}},
                        handler=_bad_handler, destructive=True)
    base_mod.registry._tools[bad.name] = bad
    try:
        with caplog.at_level(logging.CRITICAL, logger="agent.traj"):
            res, _ = await base_mod.registry.dispatch(user_a.id, bad.name, {})
        assert json.loads(res).get("success")
        assert any("confirm-gate.bypassed" in r.message for r in caplog.records)
    finally:
        base_mod.registry._tools.pop(bad.name, None)


async def test_dispatch_tripwire_silent_when_gated(user_a, monkeypatch, caplog):
    """正确接了门的工具（返回 needs_confirm）不该触发绊线——信号不掺水。"""
    from agent.tools import base as base_mod
    import app.db.session as sess_mod
    from agent.security import confirm

    class _FakeSession:
        async def __aenter__(self):
            return None
        async def __aexit__(self, *a):
            return False
    monkeypatch.setattr(sess_mod, "_engine", object())
    monkeypatch.setattr(sess_mod, "_SessionLocal", lambda: _FakeSession())

    async def _good_handler(db, user_id, args):
        blocked = confirm.needs_confirmation(args, "将删除测试资源", user_id)
        if blocked is not None:
            return blocked
        return {"success": True}

    good = base_mod.Tool(name="_test_good_delete", label="测试真删除",
                         description="test", input_schema={"type": "object", "properties": {}},
                         handler=_good_handler, destructive=True)
    base_mod.registry._tools[good.name] = good
    try:
        with caplog.at_level(logging.CRITICAL, logger="agent.traj"):
            res, _ = await base_mod.registry.dispatch(user_a.id, good.name, {})
        assert json.loads(res).get("needs_confirm")
        assert not any("confirm-gate.bypassed" in r.message for r in caplog.records)
    finally:
        base_mod.registry._tools.pop(good.name, None)


# ── 4. 静态守卫对当前代码库必须全绿 ───────────────────────────────────────────

def test_static_confirm_gate_guard_passes():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
    try:
        import check_confirm_gate
        assert check_confirm_gate.check() == []
    finally:
        sys.path.pop(0)
