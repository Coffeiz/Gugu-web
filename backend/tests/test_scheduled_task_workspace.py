"""定时任务 workspace 根目录与任务级完整沙箱授权。"""

from unittest.mock import AsyncMock

import pytest

from app.models import FilesystemAuthorizationGrant, ScheduledTask, Workspace
from app.services.filesystem_authorization import (
    resolve_filesystem_policy,
    grant_scheduled_task_filesystem_access,
    revoke_scheduled_task_filesystem_access,
)
from app.services.scheduled_tasks import validate_task_workspace


def test_scheduled_task_contract_uses_workspace_root_without_cwd():
    from app.api.v1.scheduled_tasks import TaskCreate, TaskUpdate

    assert "cwd" not in TaskCreate.model_fields
    assert "cwd" not in TaskUpdate.model_fields
    assert not hasattr(ScheduledTask, "cwd")


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
