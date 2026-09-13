"""确认门测试：不可逆工具与批量操作必须遵守目标范围确认。

三层验证（商用就绪评审 P0-3）：
1. 关键 destructive 工具：不带 confirm 调用 → 返回 needs_confirm 拦截、资源原封不动；
2. 单带 confirm=true 仍须拒绝；用户确认（确认码兑换出服务端授权）后，运行侧按原参数
   重投这次调用即可执行——模型不携带、不复述凭证，也不必自己再调用一次；
3. dispatch 层绊线：假造一个漏接确认门的 destructive 工具，无 confirm 的调用返回了
   "成功执行" → 必须触发 confirm-gate.bypassed CRITICAL 日志（运行时兜底的行为契约）。
4. 静态守卫 scripts/check_confirm_gate.py 对当前代码库必须全绿（AST 校验回归）。
"""
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from app.core.tz import now_utc
from app.models import CalendarEvent, Client, File, Folder, Project, ScheduledTask

from agent.tools.calendar import _delete_event
from agent.tools.clients import _delete_client
from agent.tools.projects import _delete_project
from agent.tools.scheduled_tasks import _delete_scheduled_task
from agent.tools.trash import _permanent_delete


def _blocked(res) -> bool:
    from agent.security import confirm
    return confirm.is_block(res)


def _confirm_code(res) -> str:
    payload = json.loads(res) if isinstance(res, str) else res
    return payload["confirm_code"]


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


async def test_permanent_delete_all_confirms_when_trash_contains_only_files(db, user_a):
    file = await _mk(db, File(
        user_id=user_a.id, display_name="仅文件", ext="md",
        storage_key="trash/only-file.md", deleted_at=now_utc(),
    ))

    result = await _permanent_delete(db, user_a.id, {"all": True})

    assert _blocked(result)
    assert await db.get(File, file.id) is not None


async def test_permanent_delete_all_confirms_when_trash_contains_only_folders(db, user_a):
    folder = await _mk(db, Folder(
        user_id=user_a.id, name="仅文件夹", deleted_at=now_utc(),
    ))

    result = await _permanent_delete(db, user_a.id, {"all": True})

    assert _blocked(result)
    assert await db.get(Folder, folder.id) is not None


# ── 2. 单带 confirm=true 必拒；服务端授权命中后才放行（凭证不经过模型）────────

async def test_delete_client_rejects_confirm_without_grant(db, user_a):
    c = await _mk(db, Client(user_id=user_a.id, name="确认后删"))
    res = await _delete_client(db, user_a.id, {"client_id": c.id, "confirm": True})
    assert _blocked(res)
    assert await db.get(Client, c.id) is not None


async def test_delete_client_executes_after_grant_without_credentials(db, user_a):
    from agent.interactions import confirmations

    c = await _mk(db, Client(user_id=user_a.id, name="确认后删"))
    blocked = await _delete_client(db, user_a.id, {"client_id": c.id})
    code = _confirm_code(blocked)

    # 用户点击确认：确认码兑换成服务端授权（一次性）。
    ttl = confirmations.redeem_confirmation(user_a.id, code)
    assert ttl is not None

    # 运行侧按原参数重投这次调用：授权命中自动注入 confirm 后放行（模型不参与）。
    res = await _delete_client(db, user_a.id, {"client_id": c.id})
    assert isinstance(res, dict) and res.get("success")
    assert await db.get(Client, c.id) is None

    # 摘要里含具体影响范围（目标名），换个目标就是新摘要：必须重新确认。
    c2 = await _mk(db, Client(user_id=user_a.id, name="授权期内再删"))
    res = await _delete_client(db, user_a.id, {"client_id": c2.id})
    assert _blocked(res)
    assert await db.get(Client, c2.id) is not None


def test_confirmation_uses_explicit_ttl(user_a):
    from agent.interactions import confirmations

    blocked = confirmations.needs_confirmation(
        {},
        "允许当前会话执行只读网络请求",
        user_a.id,
        identity="shell:network-read:1:sandbox",
        ttl_minutes=30,
    )
    payload = json.loads(blocked)
    assert payload["authorization_ttl_minutes"] == 30
    # 同一请求重复被拦截复用同一确认码，用户端不会看到码反复变化。
    again = confirmations.needs_confirmation(
        {}, "允许当前会话执行只读网络请求", user_a.id,
        identity="shell:network-read:1:sandbox", ttl_minutes=30,
    )
    assert _confirm_code(again) == payload["confirm_code"]
    assert confirmations.redeem_confirmation(user_a.id, payload["confirm_code"]) == 30
    assert confirmations.redeem_confirmation(user_a.id, payload["confirm_code"]) is None


def test_one_shot_confirmation_grant_is_consumed_atomically(user_a):
    from agent.interactions import confirmations

    summary = "允许任务读写用户沙箱"
    identity = "target:one-shot-test"
    assert confirmations.grant_confirmation(user_a.id, summary, identity)
    barrier = Barrier(3)

    def consume():
        barrier.wait()
        return confirmations.consume_confirmation(user_a.id, summary, identity)

    with ThreadPoolExecutor(max_workers=2) as executor:
        calls = [executor.submit(consume) for _ in range(2)]
        barrier.wait()
        outcomes = [call.result() for call in calls]

    assert sorted(outcomes) == [False, True]


def test_one_shot_confirmation_gate_consumes_before_replay(user_a):
    from agent.interactions import confirmations

    summary = "允许任务读写用户沙箱"
    identity = "target:one-shot-gate"
    assert confirmations.grant_confirmation(user_a.id, summary, identity)

    first_args = {}
    assert confirmations.needs_confirmation(
        first_args, summary, user_a.id, identity=identity, consume_grant=True,
    ) is None
    assert first_args["confirm"] is True

    second = confirmations.needs_confirmation(
        {}, summary, user_a.id, identity=identity, consume_grant=True,
    )
    assert _blocked(second)


def test_one_shot_confirmation_fails_closed_when_redis_is_unavailable(user_a, monkeypatch):
    from agent.interactions import confirmations

    class UnavailableRedis:
        def delete(self, _key):
            raise ConnectionError("redis unavailable")

    monkeypatch.setattr(confirmations, "get_redis_sync", lambda: UnavailableRedis())
    result = confirmations.needs_confirmation(
        {}, "允许任务读写用户沙箱", user_a.id,
        identity="target:redis-unavailable", consume_grant=True,
    )
    payload = json.loads(result)

    assert payload["status"] == "confirmation_unavailable"
    assert payload["needs_confirm"] is True


def test_revoking_confirmation_allows_reauthorization(user_a):
    from agent.interactions import confirmations

    summary = "允许会话「测试会话」读写整个用户沙箱（包含 /workspace、/personal、/project）"
    identity = "session:filesystem:123"
    blocked = confirmations.needs_confirmation({}, summary, user_a.id, identity=identity)
    code = _confirm_code(blocked)
    assert confirmations.redeem_confirmation(user_a.id, code) is not None
    assert confirmations.needs_confirmation({}, summary, user_a.id, identity=identity) is None

    assert confirmations.revoke_confirmation(user_a.id, summary, identity=identity)
    again = confirmations.needs_confirmation({}, summary, user_a.id, identity=identity)
    assert _blocked(again)


async def test_batch_delete_grant_is_summary_bound(db, user_a):
    from agent.interactions import confirmations

    first = await _mk(db, Client(user_id=user_a.id, name="批量客户一"))
    second = await _mk(db, Client(user_id=user_a.id, name="批量客户二"))
    args = {"client_ids": [first.id, second.id]}
    blocked = await _delete_client(db, user_a.id, args)
    code = _confirm_code(blocked)
    confirmations.redeem_confirmation(user_a.id, code)

    # 授权绑定确认时的摘要（影响范围）；换成另一组目标属于新摘要，必须重新确认。
    wrong = await _delete_client(db, user_a.id, {"client_ids": [first.id]})
    assert _blocked(wrong)

    # 目标顺序不影响同一批授权；变更目标集合则不能复用确认。
    result = await _delete_client(db, user_a.id, {"client_ids": [second.id, first.id]})
    assert result["success"] and result["deleted_count"] == 2
    assert await db.get(Client, first.id) is None
    assert await db.get(Client, second.id) is None


def test_target_confirmation_identity_is_exact_and_order_independent():
    from agent.interactions.confirmations import target_confirmation_identity

    original = target_confirmation_identity(
        "delete_scheduled_task", {"task_id": [12, 4]}, context={"scope": "user_sandbox"},
    )
    reordered = target_confirmation_identity(
        "delete_scheduled_task", {"task_id": [4, 12]}, context={"scope": "user_sandbox"},
    )
    other_target = target_confirmation_identity(
        "delete_scheduled_task", {"task_id": [4, 13]}, context={"scope": "user_sandbox"},
    )
    other_scope = target_confirmation_identity(
        "delete_scheduled_task", {"task_id": [4, 12]}, context={"scope": "workspace"},
    )

    assert original == reordered
    assert original != other_target
    assert original != other_scope


def test_target_confirmation_rejects_duplicate_targets(user_a):
    from agent.interactions.confirmations import needs_target_confirmation

    result = needs_target_confirmation(
        {}, "批量操作", user_a.id,
        action="delete_client", targets={"client_id": [1, 1]},
    )

    assert json.loads(result)["error"] == "目标集合不能包含重复 ID"


def test_target_confirmation_rejects_empty_or_invalid_target_groups():
    from agent.interactions.confirmations import target_confirmation_identity

    with pytest.raises(ValueError, match="非空 ID 列表"):
        target_confirmation_identity("delete_example", {"item_id": [], "other_id": [2]})
    with pytest.raises(ValueError, match="目标 ID 仅支持非空字符串或整数"):
        target_confirmation_identity("delete_example", {"item_id": [True]})


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


async def test_dispatch_tripwire_silent_for_server_authorized_autopilot(user_a, monkeypatch, caplog):
    """Autopilot 是服务端授权放行，不应被误记为确认门绕过。"""
    from agent.tools import base as base_mod
    import app.db.session as sess_mod

    class _FakeSession:
        async def __aenter__(self):
            return None
        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(sess_mod, "_engine", object())
    monkeypatch.setattr(sess_mod, "_SessionLocal", lambda: _FakeSession())

    async def _autopilot_handler(db, user_id, args):
        return {"success": True, "_confirm_gate_authorized": "shell_autopilot"}

    autopilot = base_mod.Tool(
        name="_test_autopilot_delete", label="测试 Autopilot 删除",
        description="test", input_schema={"type": "object", "properties": {}},
        handler=_autopilot_handler, destructive=True,
    )
    base_mod.registry._tools[autopilot.name] = autopilot
    try:
        with caplog.at_level(logging.CRITICAL, logger="agent.traj"):
            result, _ = await base_mod.registry.dispatch(user_a.id, autopilot.name, {})
        payload = json.loads(result)
        assert payload.get("success") is True
        assert "_confirm_gate_authorized" not in payload
        assert not any("confirm-gate.bypassed" in r.message for r in caplog.records)
    finally:
        base_mod.registry._tools.pop(autopilot.name, None)


async def test_dispatch_normalizes_wrapped_confirmation_result(user_a, monkeypatch):
    """工具包装层不能改变 dispatch 对外的顶层确认协议。"""
    from agent.tools import base as base_mod
    import app.db.session as sess_mod

    class _FakeSession:
        async def __aenter__(self):
            return None
        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(sess_mod, "_engine", object())
    monkeypatch.setattr(sess_mod, "_SessionLocal", lambda: _FakeSession())

    async def _wrapped_handler(db, user_id, args):
        return {
            "error": json.dumps({
                "status": "waiting_confirmation",
                "needs_confirm": True,
                "summary": "允许执行测试操作",
                "confirm_code": "opaque-confirm-code",
            }, ensure_ascii=False),
            "_audit_event": "confirmation_required",
        }

    wrapped = base_mod.Tool(
        name="_test_wrapped_confirmation", label="测试包装确认",
        description="test", input_schema={"type": "object", "properties": {}},
        handler=_wrapped_handler, destructive=True,
    )
    base_mod.registry._tools[wrapped.name] = wrapped
    try:
        result, _ = await base_mod.registry.dispatch(user_a.id, wrapped.name, {})
        payload = json.loads(result)
        assert payload["needs_confirm"] is True
        assert payload["status"] == "waiting_confirmation"
        assert payload["confirm_code"] == "opaque-confirm-code"
        assert "error" not in payload
        assert payload["_audit_event"] == "confirmation_required"
    finally:
        base_mod.registry._tools.pop(wrapped.name, None)


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
