"""画布只读工具回归测试。

这些用例防止普通时间流 note 被误当成可放置画布节点，并验证画布查询和业务对象搜索
始终遵守用户归属边界。
"""
import json

from app.models import CalendarEvent, File, MindCanvasItem, MindMap, MindNode, Project
from agent.tools.mind_canvas import (
    _mind_get_canvas,
    _mind_list_canvases,
    _mind_search_canvas,
    _mind_search_placeable_nodes,
)


async def _canvas(db, user, title="测试画布", data=None):
    canvas = MindMap(user_id=user.id, title=title, data_json=json.dumps(data or {}, ensure_ascii=False))
    db.add(canvas)
    await db.commit()
    await db.refresh(canvas)
    return canvas


async def _node(db, user, *, kind="canvas_note", title="便签", content="内容", ref_type=None, ref_id=None):
    node = MindNode(
        user_id=user.id, kind=kind, title=title, content_md=content, content_plain=content,
        ref_type=ref_type, ref_id=ref_id,
    )
    db.add(node)
    await db.commit()
    await db.refresh(node)
    return node


async def _item(db, user, canvas, node, x=10, y=20):
    item = MindCanvasItem(user_id=user.id, canvas_id=canvas.id, node_id=node.id, x=x, y=y, z=100)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item


async def test_list_and_get_canvas_return_camera_and_nodes(db, user_a):
    canvas = await _canvas(db, user_a, data={"x": -120, "y": 80, "scale": 1.25})
    node = await _node(db, user_a, title="接口发布", content="当前视野便签")
    item = await _item(db, user_a, canvas, node, x=420, y=280)

    listed = await _mind_list_canvases(db, user_a.id, {})
    assert listed["total"] == 1
    assert listed["canvases"][0]["node_count"] == 1
    assert listed["canvases"][0]["view"]["camera"] == {"x": -120, "y": 80, "scale": 1.25}

    result = await _mind_get_canvas(db, user_a.id, {"canvas_id": canvas.id})
    assert result["canvas"]["view"]["camera"]["scale"] == 1.25
    assert result["nodes"][0]["item_id"] == item.id
    assert result["nodes"][0]["position"] == {"x": 420, "y": 280}


async def test_search_canvas_excludes_timeline_note_and_returns_canvas_note(db, user_a):
    canvas = await _canvas(db, user_a)
    canvas_note = await _node(db, user_a, kind="canvas_note", title="发布便签", content="接口联调")
    timeline_note = await _node(db, user_a, kind="note", title="发布日记", content="接口联调")
    await _item(db, user_a, canvas, canvas_note)
    # 数据库 API 目前可能允许历史 note item，但 Agent 搜索契约仍必须排除它。
    await _item(db, user_a, canvas, timeline_note, x=40, y=50)

    result = await _mind_search_canvas(db, user_a.id, {"canvas_id": canvas.id, "q": "接口"})

    assert result["count"] == 1
    assert result["matches"][0]["node_id"] == canvas_note.id
    assert result["matches"][0]["kind"] == "canvas_note"


async def test_search_placeable_nodes_returns_owned_project_file_event_only(db, user_a, user_b):
    project = Project(user_id=user_a.id, name="发布项目", client="内部")
    file = File(
        user_id=user_a.id, display_name="发布接口.md", ext="md", storage_key="test/publish.md",
    )
    event = CalendarEvent(
        user_id=user_a.id, title="发布联调", date="2026-08-15", time="10:00",
    )
    foreign_project = Project(user_id=user_b.id, name="发布项目")
    db.add_all([project, file, event, foreign_project])
    await db.commit()
    await db.refresh(project)
    await db.refresh(file)
    await db.refresh(event)

    result = await _mind_search_placeable_nodes(
        db, user_a.id, {"queries": ["发布"], "types": ["project", "file", "event"]},
    )

    assert {item["ref_type"] for item in result["matches"]} == {"project", "file", "event"}
    assert all(item["ref_id"] != foreign_project.id for item in result["matches"])
    assert all(item["node_id"] is None for item in result["matches"])


async def test_search_canvas_isolates_other_user_canvas(db, user_a, user_b):
    foreign_canvas = await _canvas(db, user_b, title="私有画布")

    result = await _mind_search_canvas(db, user_a.id, {"canvas_id": foreign_canvas.id, "q": "私有"})
    assert result == {"error": "画布不存在"}


async def test_search_placeable_marks_existing_ref_and_item(db, user_a):
    canvas = await _canvas(db, user_a)
    project = Project(user_id=user_a.id, name="已放置项目")
    db.add(project)
    await db.commit()
    await db.refresh(project)
    ref = await _node(db, user_a, kind="ref", title=project.name, content="", ref_type="project", ref_id=project.id)
    await _item(db, user_a, canvas, ref)

    result = await _mind_search_placeable_nodes(
        db, user_a.id, {"q": "已放置", "types": ["project"], "canvas_id": canvas.id},
    )
    assert result["matches"][0]["node_id"] == ref.id
    assert result["matches"][0]["already_placed"] is True
