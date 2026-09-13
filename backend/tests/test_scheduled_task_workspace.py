"""定时任务 workspace 根目录与任务级完整沙箱授权。"""

from unittest.mock import AsyncMock
import json

import pytest
from sqlalchemy import select

from agent.tools.scheduled_tasks import _update_scheduled_task
from app.models import FilesystemAuthorizationGrant, ScheduledTask, Workspace
from app.services.filesystem_authorization import (
    resolve_filesystem_policy,
    grant_scheduled_task_filesystem_access,
    revoke_scheduled_task_filesystem_access,
)
from app.services.scheduled_tasks import normalize_script_authorization, validate_task_workspace


def test_scheduled_task_contract_uses_workspace_root_without_cwd():
    from app.api.v1.scheduled_tasks import TaskCreate, TaskUpdate

    assert "cwd" not in TaskCreate.model_fields
    assert "cwd" not in TaskUpdate.model_fields
    assert not hasattr(ScheduledTask, "cwd")


def test_scheduled_script_authorization_is_exact_and_relative():
    value = normalize_script_authorization({
        "root": "workspace", "script_path": "jobs/report.py",
        "interpreter": "python3",
    })
    assert value == {
        "root": "workspace", "script_path": "jobs/report.py",
        "interpreter": "python3",
    }
    with pytest.raises(ValueError, match="相对路径"):
        normalize_script_authorization({
            "root": "workspace", "script_path": "../report.py", "interpreter": "python3",
        })
    with pytest.raises(ValueError, match="args 已移除"):
        normalize_script_authorization({
            "root": "workspace", "script_path": "jobs/report.py",
            "interpreter": "python3", "args": ["--daily"],
        })


@pytest.mark.asyncio
async def test_task_workspace_requires_owned_enabled_workspace(db, user_a, user_b):
    workspace = Workspace(user_id=user_a.id, name="脚本工作区", kind="folder", enabled=True)
    db.add(workspace)
    await db.commit()
    await db.refresh(workspace)

    assert await validate_task_workspace(db, user_a.id, workspace.id) == workspace.id
    assert await validate_task_workspace(db, user_a.id, None) is None

    with pytest.raises(LookupError, match="工作区不存在或已停用"):
        await validate_task_workspace(db, user_b.id, workspace.id)

    workspace.enabled = False
    await db.commit()
    with pytest.raises(LookupError, match="工作区不存在或已停用"):
        await validate_task_workspace(db, user_a.id, workspace.id)


@pytest.mark.asyncio
async def test_task_grant_isolated_from_other_tasks_and_users(db, user_a, user_b, enable_filesystem_authorization):
    workspace = Workspace(user_id=user_a.id, name="任务工作区", kind="folder", enabled=True)
    task_a = ScheduledTask(user_id=user_a.id, name="任务 A", payload="", cron="0 9 * * *", workspace_id=None)
    task_b = ScheduledTask(user_id=user_a.id, name="任务 B", payload="", cron="0 10 * * *", workspace_id=None)
    db.add_all([workspace, task_a, task_b])
    await db.commit()
    await db.refresh(task_a)
    await db.refresh(task_b)

    grant = await grant_scheduled_task_filesystem_access(db, user_a.id, task_b.id, granted_by="user")
    await db.commit()

    policy_a = await resolve_filesystem_policy(
        db, user_a.id, subject_type="scheduled_task", subject_id=task_a.id,
    )
    policy_b = await resolve_filesystem_policy(
        db, user_a.id, subject_type="scheduled_task", subject_id=task_b.id,
    )
    policy_other_user = await resolve_filesystem_policy(
        db, user_b.id, subject_type="scheduled_task", subject_id=task_b.id,
    )

    assert not policy_a.full_user_sandbox
    assert policy_b.full_user_sandbox
    assert policy_b.grant_id == grant.id
    assert not policy_other_user.full_user_sandbox

    assert await revoke_scheduled_task_filesystem_access(db, user_a.id, task_b.id) is True
    await db.commit()
    policy_after_revoke = await resolve_filesystem_policy(
        db, user_a.id, subject_type="scheduled_task", subject_id=task_b.id,
    )
    assert not policy_after_revoke.full_user_sandbox
    assert task_b.filesystem_authorization_grant_id is None

    stored = await db.get(FilesystemAuthorizationGrant, grant.id)
    assert stored is not None and stored.revoked_at is not None


@pytest.mark.asyncio
async def test_batch_task_filesystem_authorization_confirms_once_and_grants_only_targets(
    db, user_a, enable_filesystem_authorization,
):
    from agent.interactions.confirmations import redeem_confirmation

    tasks = [
        ScheduledTask(user_id=user_a.id, name=f"批量任务 {index}", payload="", cron="0 9 * * *")
        for index in range(3)
    ]
    db.add_all(tasks)
    await db.commit()
    for task in tasks:
        await db.refresh(task)
    target_ids = [tasks[0].id, tasks[1].id]
    args = {"task_ids": target_ids, "filesystem_authorized": True}

    blocked = await _update_scheduled_task(db, user_a.id, args)
    payload = blocked if isinstance(blocked, dict) else json.loads(blocked)
    assert payload["needs_confirm"] is True
    assert all(task.filesystem_authorization_grant_id is None for task in tasks)

    assert redeem_confirmation(user_a.id, payload["confirm_code"]) is not None
    result = await _update_scheduled_task(db, user_a.id, {**args, "task_ids": list(reversed(target_ids))})
    assert result["success"] is True
    await db.commit()

    policies = [
        await resolve_filesystem_policy(
            db, user_a.id, subject_type="scheduled_task", subject_id=task.id,
        )
        for task in tasks
    ]
    assert [policy.full_user_sandbox for policy in policies] == [True, True, False]
    grants = (await db.execute(
        select(FilesystemAuthorizationGrant).where(
            FilesystemAuthorizationGrant.user_id == user_a.id,
        )
    )).scalars().all()
    assert {grant.subject_id for grant in grants} == {str(task_id) for task_id in target_ids}

    for task in tasks[:2]:
        assert await revoke_scheduled_task_filesystem_access(db, user_a.id, task.id) is True
    await db.commit()

    reauthorization = await _update_scheduled_task(db, user_a.id, args)
    reauthorization_payload = (
        reauthorization if isinstance(reauthorization, dict) else json.loads(reauthorization)
    )
    assert reauthorization_payload["needs_confirm"] is True


@pytest.mark.asyncio
async def test_batch_task_authorization_consumes_confirmation_when_targets_became_active_before_replay(
    db, user_a, enable_filesystem_authorization,
):
    from agent.interactions.confirmations import redeem_confirmation

    tasks = [
        ScheduledTask(user_id=user_a.id, name=f"并发授权任务 {index}", payload="", cron="0 9 * * *")
        for index in range(2)
    ]
    db.add_all(tasks)
    await db.commit()
    for task in tasks:
        await db.refresh(task)

    task_ids = [task.id for task in tasks]
    args = {"task_ids": task_ids, "filesystem_authorized": True}
    blocked = await _update_scheduled_task(db, user_a.id, args)
    payload = blocked if isinstance(blocked, dict) else json.loads(blocked)
    assert payload["needs_confirm"] is True

    # 模拟用户确认前，另一路已完成同一批任务的授权。
    for task in tasks:
        await grant_scheduled_task_filesystem_access(db, user_a.id, task.id)
    await db.commit()
    assert redeem_confirmation(user_a.id, payload["confirm_code"]) is not None

    replay = await _update_scheduled_task(db, user_a.id, args)
    assert replay["success"] is True
    assert replay["unchanged"] is True
    await db.commit()

    for task in tasks:
        assert await revoke_scheduled_task_filesystem_access(db, user_a.id, task.id) is True
    await db.commit()

    reauthorization = await _update_scheduled_task(db, user_a.id, args)
    reauthorization_payload = (
        reauthorization if isinstance(reauthorization, dict) else json.loads(reauthorization)
    )
    assert reauthorization_payload["needs_confirm"] is True


@pytest.mark.asyncio
async def test_batch_task_authorization_does_not_accept_legacy_reusable_confirmation(
    db, user_a, enable_filesystem_authorization,
):
    from agent.interactions.confirmations import (
        grant_confirmation,
        target_confirmation_identity,
    )

    tasks = [
        ScheduledTask(user_id=user_a.id, name=f"旧授权任务 {index}", payload="", cron="0 9 * * *")
        for index in range(2)
    ]
    db.add_all(tasks)
    await db.commit()
    for task in tasks:
        await db.refresh(task)

    task_ids = [task.id for task in tasks]
    summary = (
        f"允许以下定时任务读写整个用户沙箱：{'、'.join(task.name for task in tasks)}"
        f"（共 {len(tasks)} 个，包含 /workspace、/personal、/project）"
    )
    old_identity = target_confirmation_identity(
        "authorize_scheduled_task_filesystem",
        {"task_id": task_ids},
    )
    assert grant_confirmation(user_a.id, summary, identity=old_identity, ttl_minutes=10)

    result = await _update_scheduled_task(db, user_a.id, {
        "task_ids": task_ids,
        "filesystem_authorized": True,
    })
    payload = result if isinstance(result, dict) else json.loads(result)
    assert payload["needs_confirm"] is True
    assert all(task.filesystem_authorization_grant_id is None for task in tasks)


@pytest.mark.asyncio
async def test_batch_task_filesystem_authorization_prevalidates_all_targets(
    db, user_a, user_b, enable_filesystem_authorization,
):
    own_task = ScheduledTask(user_id=user_a.id, name="自己的任务", payload="", cron="0 9 * * *")
    other_task = ScheduledTask(user_id=user_b.id, name="其他人的任务", payload="", cron="0 10 * * *")
    db.add_all([own_task, other_task])
    await db.commit()
    await db.refresh(own_task)
    await db.refresh(other_task)

    result = await _update_scheduled_task(db, user_a.id, {
        "task_ids": [own_task.id, other_task.id],
        "filesystem_authorized": True,
    })

    payload = result if isinstance(result, dict) else json.loads(result)
    assert "不存在" in payload["error"]
    assert own_task.filesystem_authorization_grant_id is None
    assert other_task.filesystem_authorization_grant_id is None


@pytest.mark.asyncio
async def test_batch_task_filesystem_authorization_revokes_only_requested_tasks(
    db, user_a, enable_filesystem_authorization,
):
    tasks = [
        ScheduledTask(user_id=user_a.id, name=f"撤销任务 {index}", payload="", cron="0 9 * * *")
        for index in range(3)
    ]
    db.add_all(tasks)
    await db.commit()
    for task in tasks:
        await db.refresh(task)
    for task in tasks[:2]:
        await grant_scheduled_task_filesystem_access(db, user_a.id, task.id)
    await db.commit()

    result = await _update_scheduled_task(db, user_a.id, {
        "task_ids": [tasks[0].id, tasks[1].id],
        "filesystem_authorized": False,
    })
    await db.commit()

    assert result["success"] is True
    assert result["changed_count"] == 2
    policies = [
        await resolve_filesystem_policy(
            db, user_a.id, subject_type="scheduled_task", subject_id=task.id,
        )
        for task in tasks
    ]
    assert [policy.full_user_sandbox for policy in policies] == [False, False, False]


@pytest.mark.asyncio
async def test_scheduled_agent_receives_task_filesystem_subject(monkeypatch, user_a):
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=(
        '{"summary":"已执行","context":"","status":"success"}',
        False,
        {"tool_names": [], "mutated": False},
    ))
    monkeypatch.setattr(scheduled, "_run_agent_execution", execution)

    result, _files, _status = await scheduled._run_agent(
        user_a.id,
        "测试任务",
        trial=True,
        filesystem_subject={
            "subject_type": "scheduled_task",
            "subject_id": 42,
            "workspace_id": 7,
        },
        allow_shell=True,
    )

    assert result == '{"summary":"已执行","context":"","status":"success"}'
    execution.assert_awaited_once()
    assert execution.await_args.kwargs["filesystem_subject"] == {
        "subject_type": "scheduled_task",
        "subject_id": 42,
        "workspace_id": 7,
    }
    assert execution.await_args.kwargs["allow_shell"] is True


@pytest.mark.asyncio
async def test_deleting_workspace_disables_bound_scheduled_tasks(db, user_a):
    from app.services.workspaces import delete_workspace

    workspace = Workspace(user_id=user_a.id, name="将删除", kind="folder", enabled=True)
    db.add(workspace)
    await db.flush()
    task = ScheduledTask(
        user_id=user_a.id, name="绑定任务", payload="", cron="0 9 * * *",
        workspace_id=workspace.id,
    )
    db.add(task)
    await db.commit()

    await delete_workspace(db, user_a.id, workspace.id)
    await db.commit()
    await db.refresh(task)

    assert task.enabled is False
    assert task.workspace_id is None
