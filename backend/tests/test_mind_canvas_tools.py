"""画布只读工具回归测试。

这些用例防止普通时间流 note 被误当成可放置画布节点，并验证画布查询和业务对象搜索
始终遵守用户归属边界。
"""
import json

from sqlalchemy import select

from app.models import CalendarEvent, File, MindCanvasItem, MindMap, MindNode, Project
from agent.tools.mind_canvas import (
    _mind_add_canvas_node,
    _mind_create_canvas,
    _mind_create_canvas_note,
    _mind_get_canvas,
    _mind_list_canvases,
    _mind_search_canvas,
    _mind_search_placeable_nodes,
    _mind_update_canvas_node,
    _mind_remove_canvas_node,
    _mind_update_canvas_note,
    _mind_delete_canvas_note,
    _mind_connect_nodes,
    _mind_update_relation_anchor,
    _mind_disconnect_nodes,
    _mind_batch_canvas,
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


async def test_create_canvas_and_canvas_note_use_viewport_anchor(db, user_a):
    canvas_result = await _mind_create_canvas(db, user_a.id, {"title": "发布规划"})
    canvas_id = canvas_result["canvas"]["canvas_id"]
    canvas = await db.get(MindMap, canvas_id)
    canvas.data_json = json.dumps({"x": -100, "y": -50, "scale": 1, "viewport": {"width": 1000, "height": 600}})
    await db.commit()

    result = await _mind_create_canvas_note(db, user_a.id, {
        "canvas_id": canvas_id,
        "title": "当前视野便签",
        "content": "先完成接口联调",
        "color": "teal",
        "position": {"anchor": "viewport_center"},
    })

    assert result["created"] is True
    assert result["node"]["kind"] == "canvas_note"
    assert result["node"]["position"] == {"x": 490.0, "y": 290.0}


async def test_add_canvas_node_creates_ref_reuses_it_and_rejects_note(db, user_a):
    canvas = await _canvas(db, user_a)
    project = Project(user_id=user_a.id, name="接口项目")
    db.add(project)
    await db.commit()
    await db.refresh(project)

    first = await _mind_add_canvas_node(db, user_a.id, {
        "canvas_id": canvas.id,
        "ref_type": "project",
        "ref_id": project.id,
        "position": {"x": 100, "y": 200},
    })
    second = await _mind_add_canvas_node(db, user_a.id, {
        "canvas_id": canvas.id,
        "ref_type": "project",
        "ref_id": project.id,
    })
    assert first["created"] is True
    assert second["created"] is False
    assert second["node"]["node_id"] == first["node"]["node_id"]

    note = await _node(db, user_a, kind="note", title="时间流笔记")
    rejected = await _mind_add_canvas_node(db, user_a.id, {"canvas_id": canvas.id, "node_id": note.id})
    assert "只能把项目、文件或活动引用节点放入画布" in rejected["error"]


async def test_update_and_remove_canvas_item_only_change_view(db, user_a):
    canvas = await _canvas(db, user_a)
    node = await _node(db, user_a, title="可移动便签")
    item = await _item(db, user_a, canvas, node)

    updated = await _mind_update_canvas_node(db, user_a.id, {
        "canvas_id": canvas.id, "item_id": item.id, "x": 120, "y": 240,
        "w": 320, "collapsed": True,
    })
    assert updated["updated"] is True
    assert updated["node"]["position"] == {"x": 120.0, "y": 240.0}
    assert updated["node"]["size"] == {"w": 320.0, "h": None}
    removed = await _mind_remove_canvas_node(db, user_a.id, {"canvas_id": canvas.id, "item_id": item.id})
    assert removed["node_preserved"] is True
    assert await db.get(MindNode, node.id) is not None


async def test_update_canvas_note_uses_version_and_rejects_timeline_note(db, user_a):
    canvas = await _canvas(db, user_a)
    canvas_note = await _node(db, user_a, kind="canvas_note", title="旧标题", content="旧正文")
    result = await _mind_update_canvas_note(db, user_a.id, {
        "node_id": canvas_note.id, "version": canvas_note.version,
        "title": "新标题", "content": "新正文", "color": "blue",
    })
    assert result["updated"] is True
    assert result["node"]["title"] == "新标题"
    timeline_note = await _node(db, user_a, kind="note", title="时间流")
    rejected = await _mind_update_canvas_note(db, user_a.id, {"node_id": timeline_note.id, "version": 1, "title": "不应修改"})
    assert "画布便签" in rejected["error"]


async def test_connect_is_idempotent_and_requires_same_canvas(db, user_a):
    canvas = await _canvas(db, user_a)
    first = await _node(db, user_a, title="第一节点")
    second = await _node(db, user_a, title="第二节点")
    await _item(db, user_a, canvas, first)
    await _item(db, user_a, canvas, second, x=200)
    created = await _mind_connect_nodes(db, user_a.id, {
        "canvas_id": canvas.id, "source_node_id": first.id, "target_node_id": second.id,
    })
    reused = await _mind_connect_nodes(db, user_a.id, {
        "canvas_id": canvas.id, "source_node_id": second.id, "target_node_id": first.id,
    })
    assert created["relation_id"] == reused["relation_id"]
    assert reused["created_or_reused"] is True


async def test_relation_tools_read_and_update_canvas_connection_sides(db, user_a):
    canvas = await _canvas(db, user_a)
    first = await _node(db, user_a, title="端点一")
    second = await _node(db, user_a, title="端点二")
    await _item(db, user_a, canvas, first)
    await _item(db, user_a, canvas, second, x=200)

    relation = await _mind_connect_nodes(db, user_a.id, {
        "canvas_id": canvas.id,
        "source_node_id": first.id,
        "target_node_id": second.id,
        "source_side": "right",
        "target_side": "left",
    })
    assert relation["source_side"] == "right"
    assert relation["target_side"] == "left"

    canvas_view = await _mind_get_canvas(db, user_a.id, {"canvas_id": canvas.id})
    first_node = next(node for node in canvas_view["nodes"] if node["node_id"] == first.id)
    assert first_node["layout"]["effective_size"] == {"w": 244, "h": 148}
    assert first_node["layout"]["recommended_gap"] == 150
    assert first_node["layout"]["recommended_center_distance"] == 750
    assert canvas_view["relations"][0]["source_side"] == "right"
    assert canvas_view["relations"][0]["target_side"] == "left"

    updated = await _mind_update_relation_anchor(db, user_a.id, {
        "canvas_id": canvas.id,
        "relation_id": relation["relation_id"],
        "source_side": "left",
        "target_side": "right",
    })
    assert updated["updated"] is True
    assert updated["source_side"] == "left"
    assert updated["target_side"] == "right"


async def test_delete_canvas_note_and_disconnect_require_confirmation(db, user_a):
    canvas = await _canvas(db, user_a)
    note = await _node(db, user_a, kind="canvas_note", title="待删除")
    item = await _item(db, user_a, canvas, note)
    blocked = await _mind_delete_canvas_note(db, user_a.id, {"node_id": note.id, "version": note.version})
    assert json.loads(blocked)["needs_confirm"] is True
    assert await db.get(MindNode, note.id) is not None

    first = await _node(db, user_a, title="连接一")
    second = await _node(db, user_a, title="连接二")
    await _item(db, user_a, canvas, first, x=100)
    await _item(db, user_a, canvas, second, x=300)
    relation = await _mind_connect_nodes(db, user_a.id, {"canvas_id": canvas.id, "source_node_id": first.id, "target_node_id": second.id})
    blocked_relation = await _mind_disconnect_nodes(db, user_a.id, {"relation_id": relation["relation_id"]})
    assert json.loads(blocked_relation)["needs_confirm"] is True

    relation_token = json.loads(blocked_relation)["confirm_token"]
    deleted_relation = await _mind_disconnect_nodes(db, user_a.id, {
        "relation_id": relation["relation_id"], "confirm": True, "confirm_token": relation_token,
    })
    assert deleted_relation["deleted_relation_id"] == relation["relation_id"]

    note_token = json.loads(blocked)["confirm_token"]
    deleted_note = await _mind_delete_canvas_note(db, user_a.id, {
        "node_id": note.id, "version": note.version, "confirm": True, "confirm_token": note_token,
    })
    assert deleted_note["deleted_node_id"] == note.id
    assert (await db.get(MindNode, note.id)).deleted_at is not None
    assert await db.get(MindCanvasItem, item.id) is None


async def test_canvas_mutations_reject_self_cross_user_and_stale_versions(db, user_a, user_b):
    canvas = await _canvas(db, user_a)
    first = await _node(db, user_a, title="自己连接一")
    second = await _node(db, user_a, title="自己连接二")
    await _item(db, user_a, canvas, first)
    await _item(db, user_a, canvas, second, x=200)
    self_link = await _mind_connect_nodes(db, user_a.id, {
        "canvas_id": canvas.id, "source_node_id": first.id, "target_node_id": first.id,
    })
    assert "不能连向自己" in self_link["error"]

    foreign = await _node(db, user_b, title="其他用户节点")
    # 模拟脏数据/并发迁移：即使视图项误挂到当前用户画布，节点归属校验仍不能越界。
    await _item(db, user_a, canvas, foreign, x=400)
    cross_link = await _mind_connect_nodes(db, user_a.id, {
        "canvas_id": canvas.id, "source_node_id": first.id, "target_node_id": foreign.id,
    })
    assert "只能连接画布便签或业务引用节点" in cross_link["error"]

    note = await _node(db, user_a, kind="canvas_note", title="版本便签")
    version = note.version
    updated = await _mind_update_canvas_note(db, user_a.id, {
        "node_id": note.id, "version": version, "content": "第一次修改",
    })
    assert updated["updated"] is True
    stale = await _mind_update_canvas_note(db, user_a.id, {
        "node_id": note.id, "version": version, "content": "旧版本覆盖",
    })
    assert "其他端修改" in stale["error"]


async def test_batch_canvas_is_atomic_and_reference_operations_are_idempotent(db, user_a):
    user_id = user_a.id
    canvas = await _canvas(db, user_a)
    canvas_id = canvas.id
    project = Project(user_id=user_a.id, name="批量项目")
    db.add(project)
    await db.commit()
    await db.refresh(project)
    request = {"canvas_id": canvas.id, "request_id": "batch-001", "operations": [
        {"kind": "add_node", "ref_type": "project", "ref_id": project.id, "position": {"x": 20, "y": 30}},
    ]}
    first = await _mind_batch_canvas(db, user_a.id, request)
    second = await _mind_batch_canvas(db, user_a.id, request)
    assert first["atomic"] is True
    assert first["operations"][0]["created"] is True
    assert second["operations"][0]["created"] is False

    failed = await _mind_batch_canvas(db, user_a.id, {"canvas_id": canvas.id, "request_id": "batch-rollback", "operations": [
        {"kind": "add_node", "ref_type": "project", "ref_id": project.id},
        {"kind": "unsupported"},
    ]})
    assert failed["rolled_back"] is True

    rollback_project = Project(user_id=user_id, name="回滚项目")
    db.add(rollback_project)
    await db.commit()
    rollback_project_id = rollback_project.id
    failed = await _mind_batch_canvas(db, user_id, {"canvas_id": canvas_id, "request_id": "batch-rollback-2", "operations": [
        {"kind": "add_node", "ref_type": "project", "ref_id": rollback_project_id},
        {"kind": "unsupported"},
    ]})
    assert failed["rolled_back"] is True
    assert await db.scalar(select(MindNode).where(MindNode.ref_type == "project", MindNode.ref_id == rollback_project_id)) is None
