"""Node 只读工具迁移的 Python 业务基准；经过实际注册器与隔离 SQLite。"""
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import json

import pytest

from agent.tools import base, overview
from app.models import CalendarEvent, File, Folder, Project


@pytest.fixture
def dispatch(db, monkeypatch):
    import app.db.session as sessions
    from agent.im import imctx

    @asynccontextmanager
    async def session():
        yield db

    monkeypatch.setattr(sessions, "_engine", object())
    monkeypatch.setattr(sessions, "_SessionLocal", session)
    monkeypatch.setattr(imctx, "get_im", lambda: None)
    monkeypatch.setattr(base, "_log_traj", lambda *args, **kwargs: None)

    async def call(owner, name, args):
        raw, artifact = await base.registry.dispatch(owner.id, name, args)
        assert artifact is None
        return json.loads(raw)

    return call


async def test_registered_upcoming_uses_context_day_and_scoped_live_resources(db, user_a, user_b, dispatch, monkeypatch):
    current = datetime(2026, 12, 31, 22, 30, tzinfo=timezone(timedelta(hours=-3, minutes=-30)))
    monkeypatch.setattr(overview, "now_ctx", lambda: current)
    db.add_all([
        Project(user_id=user_a.id, name="范围起点", deadline="2026-12-31", status="active"),
        Project(user_id=user_a.id, name="范围终点", deadline="2027-01-07"),
        Project(user_id=user_a.id, name="范围外", deadline="2027-01-08"),
        Project(user_id=user_a.id, name="已完成", deadline="2027-01-01", status="done"),
        Project(user_id=user_a.id, name="已归档", deadline="2027-01-01", archived=True),
        Project(user_id=user_b.id, name="他人项目", deadline="2027-01-01"),
        CalendarEvent(user_id=user_a.id, title="起点事件", date="2026-12-31"),
        CalendarEvent(user_id=user_a.id, title="终点事件", date="2027-01-07"),
        CalendarEvent(user_id=user_a.id, title="已删事件", date="2027-01-01", deleted_at=current),
        CalendarEvent(user_id=user_b.id, title="他人事件", date="2027-01-01"),
    ])
    await db.commit()
    result = await dispatch(user_a, "get_upcoming", {})
    assert (result["from"], result["to"], result["count"]) == ("2026-12-31", "2027-01-07", 4)
    assert [item["title"] for item in result["items"]] == ["范围起点", "起点事件", "范围终点", "终点事件"]
    result = await dispatch(user_b, "get_upcoming", {"days": "1"})
    assert {item["title"] for item in result["items"]} == {"他人项目", "他人事件"}
    assert "error" in await dispatch(user_a, "get_upcoming", {"days": 0})


async def test_registered_trash_keeps_top_level_microseconds_and_limit_warning(db, user_a, user_b, dispatch):
    root = Folder(user_id=user_a.id, name="合成根目录", deleted_at=datetime(2026, 11, 15, microsecond=2))
    db.add(root)
    await db.flush()
    db.add_all([
        File(user_id=user_a.id, display_name="独立文件", ext="txt", storage_key="synthetic-one", size=1,
             deleted_at=datetime(2026, 11, 15, microsecond=1)),
        File(user_id=user_a.id, display_name="目录内文件", ext="txt", storage_key="synthetic-nested", size=1, folder_id=root.id,
             deleted_at=datetime(2026, 11, 15, microsecond=999999)),
        File(user_id=user_b.id, display_name="他人文件", ext="txt", storage_key="synthetic-other", size=1,
             deleted_at=datetime(2026, 11, 15, microsecond=999999)),
    ])
    await db.commit()
    result = await dispatch(user_a, "list_trash", {})
    assert [item["name"] for item in result] == ["合成根目录", "独立文件.txt"]
    assert result[0]["deleted_at"].endswith(".000002")
    result = await dispatch(user_a, "list_trash", {"limit": "１"})
    assert [item["name"] for item in result["items"]] == ["合成根目录"]
    assert "仅列出最近 1 个" in result["note"]


async def test_registered_calendar_preserves_reminders_filters_and_owner(db, user_a, user_b, dispatch):
    from app.models import ScheduledTask

    own = CalendarEvent(user_id=user_a.id, title="自有活动", date="2026-11-15", time="09:00")
    foreign = CalendarEvent(user_id=user_b.id, title="他人活动", date="2026-11-15")
    db.add_all([own, foreign, CalendarEvent(user_id=user_a.id, title="范围外", date="2026-11-16")])
    await db.flush()
    for index, seconds in enumerate([30, 90, 30.000001]):
        db.add(ScheduledTask(
            user_id=user_a.id, event_id=own.id, name="合成提醒", payload="不进入工具结果",
            cron=f"@once:synthetic-{index}", schedule_kind="once",
            start_at=datetime(2026, 11, 15, 1, tzinfo=timezone.utc) - timedelta(seconds=seconds),
            channels="qq", enabled=False, delivery_targets={"qq": {"chat_type": "group"}},
        ))
    db.add(ScheduledTask(user_id=user_b.id, event_id=own.id, name="他人提醒", cron="@once:foreign",
                         schedule_kind="once", reminder_lead_minutes=99, channels="web"))
    await db.commit()
    rows = await dispatch(user_a, "list_events", {"from": "2026-11-15", "to": "2026-11-15", "type": ""})
    assert [row["title"] for row in rows] == ["自有活动"]
    assert rows[0]["reminders"] == [
        {"lead_minutes": value, "channels": ["qq"], "enabled": False, "delivery_mode": "current_group"}
        for value in [0, 2, 1]
    ]
    assert "不进入工具结果" not in json.dumps(rows, ensure_ascii=False)
    assert await dispatch(user_a, "list_events", {"type": "deadline"}) == []
    assert "error" in await dispatch(user_a, "list_events", {"type": "invalid"})
    assert await dispatch(user_a, "list_events", {"limit": 0}) == []


async def test_registered_workspaces_keep_disabled_order_and_safe_related_names(db, user_a, user_b, dispatch):
    from app.models import ConversationSession, Workspace, WorkspaceDirectory

    project = Project(user_id=user_b.id, name="他人项目")
    directory = WorkspaceDirectory(user_id=user_a.id, name="自有目录", directory_name="synthetic")
    db.add_all([project, directory])
    await db.flush()
    older = Workspace(user_id=user_a.id, name="停用绑定", kind="project", enabled=False,
                      project_id=project.id, updated_at=datetime(2026, 11, 15))
    newer = Workspace(user_id=user_a.id, name="目录绑定", kind="directory", directory_id=directory.id,
                      updated_at=datetime(2026, 11, 15))
    foreign = Workspace(user_id=user_b.id, name="他人绑定")
    db.add_all([older, newer, foreign])
    await db.flush()
    db.add_all([
        ConversationSession(user_id=user_a.id, workspace_id=newer.id),
        ConversationSession(user_id=user_b.id, workspace_id=newer.id),
    ])
    await db.commit()
    rows = await dispatch(user_a, "list_workspaces", {})
    assert [row["workspace_id"] for row in rows] == [newer.id, older.id]
    assert rows[0]["bound_session_count"] == 1
    assert rows[0]["directory_name"] == "自有目录"
    assert rows[1]["enabled"] is False and rows[1]["project_name"] is None
    assert "directory_id" not in rows[1]
    assert await dispatch(user_a, "get_workspace", {"workspace_id": newer.id}) == rows[0]
    assert "不存在" in (await dispatch(user_a, "get_workspace", {"workspace_id": foreign.id}))["error"]


async def test_registered_dashboard_counts_all_live_files_and_unbounded_future(db, user_a, user_b, dispatch, monkeypatch):
    from app.models import Client

    monkeypatch.setattr(overview, "now_ctx", lambda: datetime(2026, 11, 15, tzinfo=timezone.utc))
    db.add_all([
        Project(user_id=user_a.id, name="待办"), Project(user_id=user_a.id, name="进行", status="active"),
        Project(user_id=user_a.id, name="完成", status="done"),
        Project(user_id=user_a.id, name="归档", archived=True),
        Project(user_id=user_b.id, name="他人项目"),
        CalendarEvent(user_id=user_a.id, title="遥远未来", date="2030-01-01"),
        CalendarEvent(user_id=user_a.id, title="过去", date="2026-11-14"),
        CalendarEvent(user_id=user_b.id, title="他人事件", date="2030-01-01"),
        File(user_id=user_a.id, display_name="文件", ext="txt", storage_key="synthetic-dashboard", size=1),
        File(user_id=user_a.id, display_name="已删文件", ext="txt", storage_key="synthetic-deleted", size=1,
             deleted_at=datetime(2026, 11, 15)),
        File(user_id=user_b.id, display_name="他人文件", ext="txt", storage_key="synthetic-foreign", size=1),
        Client(user_id=user_a.id, name="合成联系人"), Client(user_id=user_b.id, name="他人联系人"),
    ])
    await db.commit()
    expected = {"projects": {"pending": 1, "active": 1, "done": 1, "total": 3},
                "upcoming_events": 1, "files": 1, "clients": 1}
    assert await dispatch(user_a, "get_dashboard_stats", {}) == expected
    injected = await dispatch(user_a, "get_dashboard_stats", {"owner_id": str(user_b.id)})
    assert injected == {**expected, "ignored_fields": ["owner_id"],
                       "hint": "以下字段不在 get_dashboard_stats 的当前 schema 中，已被忽略：owner_id。参数形状与预期不符时，先调用 get_tool_schema 确认最新参数再重试。"}


async def test_registered_project_intents_keep_completion_and_owner(db, user_a, user_b, dispatch):
    project = Project(user_id=user_a.id, name="待处理", stages=[
        {"key": "s0", "label": "计划", "todos": [{"id": "one", "text": "未完成", "done": False}]},
        {"key": "s1", "label": "交付", "todos": [{"id": "two", "text": "已完成", "done": True}]},
    ])
    foreign = Project(user_id=user_b.id, name="他人项目")
    db.add_all([project, foreign])
    await db.commit()
    result = await dispatch(user_a, "update_project", {"project_id": project.id, "status": "done", "priority": "high"})
    # 旧适配器跨映射 UPDATE 后回执仍可能读到旧 ORM priority；持久化才是写入事实。
    assert result == {"success": True, "project_id": project.id, "name": "待处理", "priority": None}
    await db.refresh(project)
    assert project.progress == 100 and project.current_stage == "s1" and project.priority == "high"
    assert project.stages[0]["todos"][0] == {"id": "one", "text": "未完成", "done": True, "_savedDone": False, "autoCompleted": True}
    assert project.stages[1]["todos"][0] == {"id": "two", "text": "已完成", "done": True}
    assert (await dispatch(user_a, "set_color", {"project_id": project.id, "color": "teal"}))["color"] == "teal"
    assert (await dispatch(user_a, "archive_project", {"project_id": project.id}))["archived"] is True
    assert (await dispatch(user_a, "archive_project", {"project_id": project.id, "archived": False}))["archived"] is False
    assert "error" in await dispatch(user_a, "update_project", {"project_id": foreign.id, "summary": "不能修改"})
    await db.refresh(foreign)
    assert foreign.summary is None


async def test_registered_stage_lifecycle_and_batch_destination_failure(db, user_a, user_b, dispatch):
    project = Project(user_id=user_a.id, name="阶段项目", current_stage="s0", stages=[
        {"key": "s0", "label": "计划", "todos": [{"id": "t0", "text": "原待办", "done": False}]},
        {"key": "s1", "label": "执行", "todos": []},
    ])
    foreign = Project(user_id=user_b.id, name="他人阶段项目")
    db.add_all([project, foreign])
    await db.commit()
    result = await dispatch(user_a, "add_stage", {"project_id": project.id, "label": "  验收  ", "position": 0})
    assert result == {"success": True, "project_id": project.id, "stage_key": "s2", "label": "验收"}
    assert (await dispatch(user_a, "rename_stage", {"project_id": project.id, "stage": "s2", "new_label": "交付"}))["label"] == "交付"
    result = await dispatch(user_a, "update_stage", {"project_id": project.id, "stage": "s0", "add": ["新增"],
        "todos": [{"text": "t0", "new_text": "不得生效", "done": True, "to_stage": "missing"},
                  {"text": "t1", "done": True, "to_stage": "s1"}]})
    assert result["success"] is True
    assert result["results"][1]["error"] == "目标阶段不存在: missing"
    await db.refresh(project)
    stages = {stage["key"]: stage for stage in project.stages}
    assert stages["s0"]["todos"] == [{"id": "t0", "text": "原待办", "done": False}]
    assert stages["s1"]["todos"] == [{"id": "t1", "text": "新增", "done": True}]
    assert project.current_stage == "s0"
    result = await dispatch(user_a, "set_stages", {"project_id": project.id, "stages": [
        {"key": "s1", "label": "执行"}, {"key": "s0", "label": "计划", "todos": ["重建"]}]})
    assert result["stage_details"] == [{"key": "s1", "label": "执行", "todo_count": 1},
                                      {"key": "s0", "label": "计划", "todo_count": 1}]
    assert result["current_stage"] == "s0"
    names = await dispatch(user_a, "set_stages", {"project_id": project.id, "stages": ["执行", "计划"]})
    assert names["input_adaptations"] == ["stages:stage_names_to_objects"]
    result = await dispatch(user_a, "remove_stage", {"project_id": project.id, "stage": "s0"})
    assert (result["current_stage_key"], result["current_stage"]) == ("s1", "执行")
    assert "error" in await dispatch(user_a, "remove_stage", {"project_id": project.id, "stage": "s1"})
    assert "error" in await dispatch(user_a, "add_stage", {"project_id": foreign.id, "label": "越权"})
    assert "error" in await dispatch(user_a, "update_stage", {"project_id": project.id, "todos": [{"text": "t1", "invented": True}]})
    await db.refresh(project)
    assert project.stages[0]["todos"] == [{"id": "t1", "text": "新增", "done": True}]


async def test_registered_note_reads_filter_relations_and_body_references(db, user_a, user_b, dispatch):
    from app.models import MindNode, MindRelation

    project = Project(user_id=user_a.id, name="当前项目名")
    foreign_project = Project(user_id=user_b.id, name="他人项目名")
    db.add_all([project, foreign_project])
    await db.flush()
    markdown = (f"# 重构😀\r\n正文 [[project:{project.id}|旧名称]]\n"
                f"{chr(96)}[[project:{foreign_project.id}|代码]]{chr(96)}\n~~~\n[[file:99|示例]]\n~~~\n"
                f"[[project:{foreign_project.id}|不可读]]")
    own = MindNode(user_id=user_a.id, kind="note", title="重构笔记", content_md=markdown,
                   content_plain="重构 词甲", captured_at=datetime(2026, 11, 15, microsecond=1))
    neighbor = MindNode(user_id=user_a.id, kind="canvas_note", title="重构便签", content_md="全文",
                        content_plain="重构 词乙", captured_at=datetime(2026, 11, 14))
    foreign = MindNode(user_id=user_b.id, kind="note", title="他人重构", content_md="不泄漏", content_plain="重构")
    deleted = MindNode(user_id=user_a.id, kind="note", title="已删重构", content_md="不出现", content_plain="重构",
                       deleted_at=datetime(2026, 11, 15))
    db.add_all([own, neighbor, foreign, deleted])
    await db.flush()
    db.add_all([
        MindRelation(user_id=user_a.id, src_node_id=own.id, dst_node_id=neighbor.id, rel_type="related"),
        MindRelation(user_id=user_a.id, src_node_id=own.id, dst_node_id=foreign.id, rel_type="related"),
        MindRelation(user_id=user_a.id, src_node_id=own.id, dst_node_id=deleted.id, rel_type="related"),
    ])
    await db.commit()
    result = await dispatch(user_a, "note_search", {"query": "重构", "limit": 1})
    assert [row["node_id"] for row in result["matches"]] == [own.id]
    assert [row["node"]["node_id"] for row in result["related"]] == [neighbor.id]
    assert result["references"] == [{"from_node_id": own.id, "ref_type": "project", "ref_id": project.id, "label": "当前项目名"}]
    assert "content_md" not in result["matches"][0]
    detail = await dispatch(user_a, "note_get", {"node_id": own.id})
    assert detail["node"]["content_md"] == markdown
    assert detail["node"]["numbered_content"].startswith("1: # 重构😀\n2: 正文")
    assert "from_node_id" not in detail["related"][0]
    result = await dispatch(user_a, "note_search", {"queries": ["重构", "词乙"], "mode": "AND", "include_content": True})
    assert [row["node_id"] for row in result["matches"]] == [neighbor.id]
    assert result["matches"][0]["content_md"] == "全文"
    assert "error" in await dispatch(user_a, "note_get", {"node_id": foreign.id})
    assert "error" in await dispatch(user_a, "note_get", {"node_id": deleted.id})
    assert "error" in await dispatch(user_a, "note_search", {})
    assert "error" in await dispatch(user_a, "note_search", {"query": "重构", "mode": "invalid"})


async def test_registered_schema_discovery_does_not_execute_requested_tool(db, user_a, dispatch):
    result = await dispatch(user_a, "get_tool_schema", {"tools": ["note_get", "note_get", "missing"]})
    assert result == {"tool_schemas": ["note_get"], "rejected": ["note_get", "missing"]}
    assert "error" in await dispatch(user_a, "get_tool_schema", {"tools": []})
    assert "error" in await dispatch(user_a, "get_tool_schema", {"tools": ["missing"]})


async def test_registered_workspace_update_keeps_physical_segment_and_owner(db, user_a, user_b, dispatch):
    from app.models import Workspace, WorkspaceDirectory
    from types import SimpleNamespace
    directory = WorkspaceDirectory(user_id=user_a.id, name="旧目录", directory_name="fixed-segment")
    db.add(directory)
    await db.flush()
    own = Workspace(user_id=user_a.id, name="旧目录", kind="directory", directory_id=directory.id)
    other = Workspace(user_id=user_b.id, name="他人", kind="directory", directory_id=directory.id)
    db.add_all([own, other])
    await db.commit()
    actor = SimpleNamespace(id=user_a.id)
    own_id, other_id = own.id, other.id
    result = await dispatch(actor, "update_workspace", {"workspace_id": own_id, "workspace_name": " 新名 ", "enabled": False})
    assert result["success"] is True
    assert result["workspace"]["name"] == result["workspace"]["directory_name"] == "新名"
    assert result["workspace"]["enabled"] is False
    await db.refresh(directory)
    await db.refresh(other)
    assert directory.directory_name == "fixed-segment" and other.name == "他人"
    assert "error" in await dispatch(actor, "update_workspace", {"workspace_id": own_id})
    assert "error" in await dispatch(actor, "update_workspace", {"workspace_id": other_id, "enabled": False})
    assert (await dispatch(actor, "update_workspace", {"workspace_id": own_id, "workspace_name": ""}))["error"] == "工作区名称不能为空"
