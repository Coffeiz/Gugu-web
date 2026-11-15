"""新增直接Web项目读取基准；不以Agent测试替代Web投影契约。"""

from datetime import datetime, timedelta, timezone
import json
import re

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import event
import pytest

from app.api.v1.projects import _to_resp, get_project, list_project_file_counts, list_projects
from app.models import File, Project, ProjectFileCount


pytestmark = pytest.mark.asyncio
_NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)


async def test_web_project_list_owner_archive_trash_and_full_dto(db, user_a, user_b, monkeypatch):
    """列表区分owner/归档/29与31天回收站，并保持完整CamelDTO。"""
    monkeypatch.setattr("app.services.projects.now_utc", lambda: _NOW)
    created = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
    updated = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)
    active = Project(user_id=user_a.id, name="完整项目", client="小北", status="active", start_date="2026-10-01",
                     deadline="2026-12-01", color="合成历史颜色", progress=25, stages_json='[{"key":"s0","label":"计划","custom":"保留"}]',
                     current_stage="s0", archived=False, priority="high", version=0, created_at=created, updated_at=updated,
                     summary="不属于Web响应的项目摘要")
    archived = Project(user_id=user_a.id, name="归档项目", archived=True)
    recent = Project(user_id=user_a.id, name="29天回收项目", deleted_at=_NOW - timedelta(days=29))
    expired = Project(user_id=user_a.id, name="31天回收项目", deleted_at=_NOW - timedelta(days=31))
    foreign = Project(user_id=user_b.id, name="其他账号项目")
    db.add_all([active, archived, recent, expired, foreign])
    await db.flush()
    db.add(ProjectFileCount(project_id=active.id, file_count=7))
    await db.commit()

    result = await list_projects(archived=False, deleted=False, current_user=user_a, db=db)
    assert [row.model_dump(by_alias=True) for row in result] == [{
        "id": active.id, "name": "完整项目", "client": "小北", "status": "active", "startDate": "2026-10-01",
        "deadline": "2026-12-01", "color": "合成历史颜色", "progress": 25,
        "stages": [{"key": "s0", "label": "计划", "custom": "保留"}], "currentStage": "s0", "archived": False,
        "priority": "high", "version": 1, "doneAt": None, "updatedAt": updated.isoformat(), "deletedAt": None,
        "createdAt": "2026-10-01", "fileCount": 7,
    }]
    assert [row.id for row in await list_projects(archived=True, deleted=False, current_user=user_a, db=db)] == [archived.id]
    trash = await list_projects(archived=False, deleted=True, current_user=user_a, db=db)
    assert [row.id for row in trash] == [recent.id]
    assert trash[0].deleted_at == recent.deleted_at.isoformat()
    assert [row.id for row in await list_projects(archived=False, deleted=False, current_user=user_b, db=db)] == [foreign.id]
    with pytest.raises(HTTPException) as error:
        await list_projects(archived=True, deleted=True, current_user=user_a, db=db)
    assert error.value.status_code == 400


async def test_web_project_detail_owner_deleted_missing_and_absent_count_projection(db, user_a, user_b):
    """实际File存在也不能替代计数投影；详情跨owner/软删与不存在均404。"""
    live = Project(user_id=user_a.id, name="无投影项目")
    foreign = Project(user_id=user_b.id, name="他人详情")
    deleted = Project(user_id=user_a.id, name="已删详情", deleted_at=_NOW)
    db.add_all([live, foreign, deleted])
    await db.flush()
    db.add(File(user_id=user_a.id, display_name="合成文件", ext="txt", space="project", project_id=live.id,
                storage_key="synthetic-project-file.txt", storage_backend="local"))
    db.add(ProjectFileCount(project_id=foreign.id, file_count=9))
    await db.commit()

    statements = []

    def capture_sql(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    # 观测真实handler执行SQL，保护“投影读取不能退回扫描files”的运行时边界。
    engine = db.bind.sync_engine
    event.listen(engine, "before_cursor_execute", capture_sql)
    try:
        assert (await get_project(pid=live.id, current_user=user_a, db=db)).file_count == 0
        listed = await list_projects(archived=False, deleted=False, current_user=user_a, db=db)
        assert [(row.id, row.file_count) for row in listed] == [(live.id, 0)]
    finally:
        event.remove(engine, "before_cursor_execute", capture_sql)
    assert statements
    assert not any(re.search(r"\b(?:FROM|JOIN)\s+files\b", statement, re.IGNORECASE) for statement in statements)
    for project_id in [foreign.id, deleted.id, 999999]:
        with pytest.raises(HTTPException) as error:
            await get_project(pid=project_id, current_user=user_a, db=db)
        assert error.value.status_code == 404
        assert error.value.detail == "项目不存在"
    assert (await get_project(pid=foreign.id, current_user=user_b, db=db)).file_count == 9


async def test_web_project_file_counts_include_archive_and_deleted_and_zero_without_projection(db, user_a, user_b):
    """计数接口覆盖owner全部项目，不能误套用看板/回收站过滤。"""
    live = Project(user_id=user_a.id, name="活动计数")
    archived = Project(user_id=user_a.id, name="归档计数", archived=True)
    expired = Project(user_id=user_a.id, name="超期已删计数", deleted_at=_NOW - timedelta(days=31))
    empty = Project(user_id=user_a.id, name="无投影计数")
    foreign = Project(user_id=user_b.id, name="他人计数")
    db.add_all([live, archived, expired, empty, foreign])
    await db.flush()
    db.add_all([ProjectFileCount(project_id=live.id, file_count=2), ProjectFileCount(project_id=archived.id, file_count=3),
                ProjectFileCount(project_id=expired.id, file_count=4), ProjectFileCount(project_id=foreign.id, file_count=8)])
    await db.commit()
    result = await list_project_file_counts(current_user=user_a, db=db)
    assert sorted(result, key=lambda row: row["projectId"]) == [
        {"projectId": live.id, "fileCount": 2}, {"projectId": archived.id, "fileCount": 3},
        {"projectId": expired.id, "fileCount": 4}, {"projectId": empty.id, "fileCount": 0},
    ]
    assert await list_project_file_counts(current_user=user_b, db=db) == [{"projectId": foreign.id, "fileCount": 8}]


async def test_web_project_stages_json_fallback_validation_and_original_storage(db, user_a):
    """损坏JSON与合法错误结构不能混淆；泛型dict未知字段保留，读取不重写历史。"""
    project = Project(user_id=user_a.id, name="历史阶段项目", stages_json="[]")
    db.add(project)
    await db.commit()
    samples = [("{损坏JSON", []),
               (json.dumps([{"key": "s0", "label": "计划", "unknown": {"keep": True}}]),
                [{"key": "s0", "label": "计划", "unknown": {"keep": True}}])]
    for raw, expected in samples:
        project.stages_json = raw
        await db.commit()
        assert _to_resp(project).stages == expected
        assert (await get_project(pid=project.id, current_user=user_a, db=db)).stages == expected
        await db.refresh(project)
        assert project.stages_json == raw
    for raw in ["null", "{}", "[1]"]:
        project.stages_json = raw
        await db.commit()
        with pytest.raises(ValidationError):
            _to_resp(project)
        with pytest.raises(ValidationError):
            await get_project(pid=project.id, current_user=user_a, db=db)
        await db.refresh(project)
        assert project.stages_json == raw


@pytest.mark.parametrize(
    ("microsecond", "offset_hours", "expected_iso", "expected_day"),
    [
        (0, 0, "2026-11-14T01:02:03+00:00", "2026-11-14"),
        (123000, 8, "2026-11-13T17:02:03.123000+00:00", "2026-11-13"),
        (123456, 0, "2026-11-14T01:02:03.123456+00:00", "2026-11-14"),
    ],
)
async def test_web_project_database_time_roundtrip_preserves_precision_and_undo(
    db, user_a, monkeypatch, microsecond, offset_hours, expected_iso, expected_day,
):
    """新增DB往返基准：公共UTC时间保留微秒，跨日不改变业务日期或内部Undo。"""
    from copy import deepcopy

    from app.models import UndoOperation
    from app.services.undo.domains import domain_ref, domain_state, project_snapshot

    monkeypatch.setattr("app.services.projects.now_utc", lambda: _NOW)
    stamp = datetime(2026, 11, 14, 1, 2, 3, microsecond, tzinfo=timezone(timedelta(hours=offset_hours)))
    live = Project(user_id=user_a.id, name="时间往返项目", created_at=stamp, updated_at=stamp, done_at=stamp,
                   start_date="2026-11-14", deadline="2026-12-01", deleted_at=None)
    trash = Project(user_id=user_a.id, name="时间往返回收项目", created_at=stamp, updated_at=stamp,
                    done_at=None, deleted_at=stamp, start_date="2026-11-14", deadline="2026-12-01")
    db.add_all([live, trash])
    await db.commit()
    # 显式刷新，不把尚未经过数据库转换的ORM属性误当实际读出契约。
    await db.refresh(live)
    await db.refresh(trash)
    before_dates = {row.id: (row.created_at, row.updated_at, row.done_at, row.deleted_at) for row in [live, trash]}
    state = domain_state({domain_ref("project", row.id): project_snapshot(row) for row in [live, trash]})
    saved_state = deepcopy(state)
    operation = UndoOperation(
        id="synthetic-time-undo", user_id=user_a.id, undo_context_id="synthetic-time-context",
        group_id="synthetic-time-group", resource="projects", action="update",
        target_refs=[{"kind": "project", "id": live.id}], before_state=state, after_state=deepcopy(state),
    )
    db.add(operation)
    await db.commit()

    detail = await get_project(pid=live.id, current_user=user_a, db=db)
    active = await list_projects(archived=False, deleted=False, current_user=user_a, db=db)
    deleted = await list_projects(archived=False, deleted=True, current_user=user_a, db=db)
    for dto in [detail, active[0], _to_resp(live)]:
        payload = dto.model_dump(by_alias=True)
        assert payload["doneAt"] == expected_iso
        assert payload["updatedAt"] == expected_iso
        assert payload["deletedAt"] is None
        assert payload["createdAt"] == expected_day
        assert payload["startDate"] == "2026-11-14"
        assert payload["deadline"] == "2026-12-01"
    assert [row.id for row in active] == [live.id]
    assert [row.id for row in deleted] == [trash.id]
    trash_payload = deleted[0].model_dump(by_alias=True)
    assert trash_payload["doneAt"] is None
    assert trash_payload["updatedAt"] == expected_iso
    assert trash_payload["deletedAt"] == expected_iso
    assert trash_payload["createdAt"] == expected_day
    for row in [live, trash]:
        await db.refresh(row)
        assert (row.created_at, row.updated_at, row.done_at, row.deleted_at) == before_dates[row.id]
        assert row.created_at.tzinfo == timezone.utc
    await db.refresh(operation)
    assert operation.before_state == saved_state
    assert operation.after_state == saved_state
    assert operation.before_state["items"][domain_ref("project", live.id)]["done_at"] == expected_iso
    assert operation.before_state["items"][domain_ref("project", trash.id)]["deleted_at"] == expected_iso
