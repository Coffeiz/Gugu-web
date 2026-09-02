"""画布只读工具回归测试。

这些用例防止普通时间流 note 被误当成可放置画布节点，并验证画布查询和业务对象搜索
始终遵守用户归属边界。
"""
import json

from sqlalchemy import select

from app.models import CalendarEvent, File, MindCanvasItem, MindMap, MindNode, MindRelation, Project
from agent.tools.mind_canvas import (
    _canvas_add_node,
    _canvas_create,
    _canvas_create_note,
    _canvas_get,
    _canvas_list,
    _canvas_search,
    _canvas_search_placeable,
    _canvas_update_node,
    _canvas_remove_node,
    _canvas_update_note,
    _canvas_delete_note,
    _canvas_connect,
    _canvas_update_anchor,
    _canvas_disconnect,
    _canvas_batch,
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

    listed = await _canvas_list(db, user_a.id, {})
    assert listed["total"] == 1
    assert listed["canvases"][0]["node_count"] == 1
    assert listed["canvases"][0]["view"]["camera"] == {"x": -120, "y": 80, "scale": 1.25}

    result = await _canvas_get(db, user_a.id, {"canvas_id": canvas.id})
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

    result = await _canvas_search(db, user_a.id, {"canvas_id": canvas.id, "q": "接口"})

    assert result["count"] == 1
    assert result["matches"][0]["node_id"] == canvas_note.id
    assert result["matches"][0]["kind"] == "canvas_note"
    assert "version" not in result["matches"][0]


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

    result = await _canvas_search_placeable(
        db, user_a.id, {"queries": ["发布"], "types": ["project", "file", "event"]},
    )

    assert {item["ref_type"] for item in result["matches"]} == {"project", "file", "event"}
    assert all(item["ref_id"] != foreign_project.id for item in result["matches"])
    assert all(item["node_id"] is None for item in result["matches"])


async def test_search_canvas_isolates_other_user_canvas(db, user_a, user_b):
    foreign_canvas = await _canvas(db, user_b, title="私有画布")

    result = await _canvas_search(db, user_a.id, {"canvas_id": foreign_canvas.id, "q": "私有"})
    assert result == {"error": "画布不存在"}


async def test_search_placeable_marks_existing_ref_and_item(db, user_a):
    canvas = await _canvas(db, user_a)
    project = Project(user_id=user_a.id, name="已放置项目")
    db.add(project)
    await db.commit()
    await db.refresh(project)
    ref = await _node(db, user_a, kind="ref", title=project.name, content="", ref_type="project", ref_id=project.id)
    await _item(db, user_a, canvas, ref)

    result = await _canvas_search_placeable(
        db, user_a.id, {"q": "已放置", "types": ["project"], "canvas_id": canvas.id},
    )
    assert result["matches"][0]["node_id"] == ref.id
    assert result["matches"][0]["already_placed"] is True


async def test_create_canvas_and_canvas_note_use_viewport_anchor(db, user_a):
    canvas_result = await _canvas_create(db, user_a.id, {"title": "发布规划"})
    canvas_id = canvas_result["canvas"]["canvas_id"]
    canvas = await db.get(MindMap, canvas_id)
    canvas.data_json = json.dumps({"x": -100, "y": -50, "scale": 1, "viewport": {"width": 1000, "height": 600}})
    await db.commit()

    result = await _canvas_create_note(db, user_a.id, {
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

    first = await _canvas_add_node(db, user_a.id, {
        "canvas_id": canvas.id,
        "ref_type": "project",
        "ref_id": project.id,
        "position": {"x": 100, "y": 200},
    })
    second = await _canvas_add_node(db, user_a.id, {
        "canvas_id": canvas.id,
        "ref_type": "project",
        "ref_id": project.id,
    })
    assert first["created"] is True
    assert second["created"] is False
    assert second["node"]["node_id"] == first["node"]["node_id"]

    note = await _node(db, user_a, kind="note", title="时间流笔记")
    rejected = await _canvas_add_node(db, user_a.id, {"canvas_id": canvas.id, "node_id": note.id})
    assert "只能把项目、文件或活动引用节点放入画布" in rejected["error"]


async def test_update_and_remove_canvas_item_only_change_view(db, user_a):
    user_id = user_a.id
    canvas = await _canvas(db, user_a)
    canvas_id = canvas.id
    node = await _node(db, user_a, title="可移动便签")
    item = await _item(db, user_a, canvas, node)
    item_id = item.id

    updated_size = await _canvas_update_node(db, user_id, {
        "canvas_id": canvas_id, "item_id": item_id, "width": 320, "height": 200,
    })
    assert updated_size["updated"] is True
    assert updated_size["node"]["size"] == {"w": 320.0, "h": 200.0}
    updated = await _canvas_update_node(db, user_id, {
        "canvas_id": canvas_id, "item_id": item_id, "x": 120, "y": 240,
        "collapsed": True,
    })
    assert updated["updated"] is True
    assert updated["node"]["position"] == {"x": 120.0, "y": 240.0}
    assert updated["node"]["size"] == {"w": 320.0, "h": 200.0}
    removed = await _canvas_remove_node(db, user_id, {"canvas_id": canvas_id, "item_id": item_id})
    assert removed["node_preserved"] is True
    assert await db.get(MindNode, node.id) is not None


async def test_update_canvas_note_reads_current_version_and_rejects_timeline_note(db, user_a):
    canvas = await _canvas(db, user_a)
    canvas_note = await _node(db, user_a, kind="canvas_note", title="旧标题", content="旧正文")
    result = await _canvas_update_note(db, user_a.id, {
        "node_id": canvas_note.id,
        "title": "新标题", "content": "新正文", "color": "blue",
    })
    assert result["updated"] is True
    assert result["node"]["title"] == "新标题"
    assert "version" not in result["node"]
    timeline_note = await _node(db, user_a, kind="note", title="时间流")
    rejected = await _canvas_update_note(db, user_a.id, {"node_id": timeline_note.id, "version": 1, "title": "不应修改"})
    assert "画布便签" in rejected["error"]


async def test_connect_is_idempotent_and_requires_same_canvas(db, user_a):
    canvas = await _canvas(db, user_a)
    first = await _node(db, user_a, title="第一节点")
    second = await _node(db, user_a, title="第二节点")
    await _item(db, user_a, canvas, first)
    await _item(db, user_a, canvas, second, x=400)
    created = await _canvas_connect(db, user_a.id, {
        "canvas_id": canvas.id, "source_node_id": first.id, "target_node_id": second.id,
    })
    reused = await _canvas_connect(db, user_a.id, {
        "canvas_id": canvas.id, "source_node_id": second.id, "target_node_id": first.id,
    })
    assert created["relation_id"] == reused["relation_id"]
    assert reused["created_or_reused"] is True
    assert created["source_side"] == "right"
    assert created["target_side"] == "left"
    assert created["anchor_source"] == "geometry"
    assert created["verification"]["checked_relation_id"] == created["relation_id"]


async def test_removing_canvas_item_detaches_relation_without_deleting_global_relation(db, user_a):
    canvas = await _canvas(db, user_a)
    first = await _node(db, user_a, kind="ref", title="抽屉节点一", ref_type="project", ref_id=101)
    second = await _node(db, user_a, kind="ref", title="抽屉节点二", ref_type="project", ref_id=102)
    first_item = await _item(db, user_a, canvas, first)
    await _item(db, user_a, canvas, second, x=400)
    relation = await _canvas_connect(db, user_a.id, {
        "canvas_id": canvas.id, "source_node_id": first.id, "target_node_id": second.id,
    })

    removed = await _canvas_remove_node(db, user_a.id, {
        "canvas_id": canvas.id, "item_id": first_item.id,
    })
    assert removed["node_preserved"] is True
    assert (await _canvas_get(db, user_a.id, {"canvas_id": canvas.id}))["relations"] == []

    restored = await _canvas_add_node(db, user_a.id, {
        "canvas_id": canvas.id, "node_id": first.id, "position": {"x": 10, "y": 20},
    })
    assert restored["created"] is True
    assert (await _canvas_get(db, user_a.id, {"canvas_id": canvas.id}))["relations"] == []
    assert await db.get(MindRelation, relation["relation_id"]) is not None


async def test_relation_tools_read_and_update_canvas_connection_sides(db, user_a):
    canvas = await _canvas(db, user_a)
    first = await _node(db, user_a, title="端点一")
    second = await _node(db, user_a, title="端点二")
    await _item(db, user_a, canvas, first)
    await _item(db, user_a, canvas, second, x=400)

    relation = await _canvas_connect(db, user_a.id, {
        "canvas_id": canvas.id,
        "source_node_id": first.id,
        "target_node_id": second.id,
        "source_side": "right",
        "target_side": "left",
    })
    assert relation["source_side"] == "right"
    assert relation["target_side"] == "left"

    canvas_view = await _canvas_get(db, user_a.id, {"canvas_id": canvas.id})
    first_node = next(node for node in canvas_view["nodes"] if node["node_id"] == first.id)
    assert first_node["layout"]["effective_size"] == {"w": 240, "h": 140}
    assert first_node["layout"]["recommended_gap"] == 150
    assert first_node["layout"]["recommended_center_distance"] == 750
    assert canvas_view["relations"][0]["source_side"] == "right"
    assert canvas_view["relations"][0]["target_side"] == "left"
    audit = canvas_view["relation_audit"][0]
    assert audit["recommended"] == {"source_side": "right", "target_side": "left"}
    assert audit["status"] == "aligned"
    assert audit["source"]["center"] == {"x": 130.0, "y": 90.0}
    assert audit["target"]["center"] == {"x": 520.0, "y": 90.0}

    updated = await _canvas_update_anchor(db, user_a.id, {
        "canvas_id": canvas.id,
        "relation_id": relation["relation_id"],
        "source_side": "left",
        "target_side": "right",
    })
    assert updated["updated"] is True
    assert updated["source_side"] == "left"
    assert updated["target_side"] == "right"

    custom_view = await _canvas_get(db, user_a.id, {"canvas_id": canvas.id})
    assert custom_view["relation_audit"][0]["status"] == "custom"
    assert "可能是有意的回环布局" in custom_view["relation_audit"][0]["reason"]

    rejected = await _canvas_connect(db, user_a.id, {
        "canvas_id": canvas.id,
        "source_node_id": first.id,
        "target_node_id": second.id,
        "source_side": "left",
        "target_side": "right",
    })
    assert "省略 source_side/target_side" in rejected["error"]

    repaired = await _canvas_connect(db, user_a.id, {
        "canvas_id": canvas.id,
        "source_node_id": first.id,
        "target_node_id": second.id,
    })
    assert repaired["anchor_source"] == "geometry"
    assert repaired["source_side"] == "right"
    assert repaired["target_side"] == "left"


async def test_delete_canvas_note_and_disconnect_require_confirmation(db, user_a):
    canvas = await _canvas(db, user_a)
    note = await _node(db, user_a, kind="canvas_note", title="待删除")
    item = await _item(db, user_a, canvas, note)
    blocked = await _canvas_delete_note(db, user_a.id, {"node_id": note.id, "version": note.version})
    assert json.loads(blocked)["needs_confirm"] is True
    assert await db.get(MindNode, note.id) is not None

    first = await _node(db, user_a, title="连接一")
    second = await _node(db, user_a, title="连接二")
    await _item(db, user_a, canvas, first, x=100)
    await _item(db, user_a, canvas, second, x=300)
    relation = await _canvas_connect(db, user_a.id, {"canvas_id": canvas.id, "source_node_id": first.id, "target_node_id": second.id})
    blocked_relation = await _canvas_disconnect(db, user_a.id, {"canvas_id": canvas.id, "relation_id": relation["relation_id"]})
    assert json.loads(blocked_relation)["needs_confirm"] is True

    relation_token = json.loads(blocked_relation)["confirm_token"]
    deleted_relation = await _canvas_disconnect(db, user_a.id, {
        "canvas_id": canvas.id, "relation_id": relation["relation_id"], "confirm": True, "confirm_token": relation_token,
    })
    assert deleted_relation["deleted_relation_id"] == relation["relation_id"]

    note_token = json.loads(blocked)["confirm_token"]
    deleted_note = await _canvas_delete_note(db, user_a.id, {
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
    self_link = await _canvas_connect(db, user_a.id, {
        "canvas_id": canvas.id, "source_node_id": first.id, "target_node_id": first.id,
    })
    assert "不能连向自己" in self_link["error"]

    foreign = await _node(db, user_b, title="其他用户节点")
    # 模拟脏数据/并发迁移：即使视图项误挂到当前用户画布，节点归属校验仍不能越界。
    await _item(db, user_a, canvas, foreign, x=400)
    cross_link = await _canvas_connect(db, user_a.id, {
        "canvas_id": canvas.id, "source_node_id": first.id, "target_node_id": foreign.id,
    })
    assert "只能连接画布便签或业务引用节点" in cross_link["error"]

    note = await _node(db, user_a, kind="canvas_note", title="版本便签")
    version = note.version
    updated = await _canvas_update_note(db, user_a.id, {
        "node_id": note.id, "version": version, "content": "第一次修改",
    })
    assert updated["updated"] is True
    stale = await _canvas_update_note(db, user_a.id, {
        "node_id": note.id, "content": "再次增量修改",
    })
    assert stale["updated"] is True


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
    first = await _canvas_batch(db, user_a.id, request)
    second = await _canvas_batch(db, user_a.id, request)
    assert first["atomic"] is True
    assert first["operations"][0]["created"] is True
    # 幂等重放：同 request_id + 同 payload → 返回首次缓存结果
    assert second == first

    failed = await _canvas_batch(db, user_a.id, {"canvas_id": canvas.id, "request_id": "batch-rollback", "operations": [
        {"kind": "add_node", "ref_type": "project", "ref_id": project.id},
        {"kind": "unsupported"},
    ]})
    assert failed["rolled_back"] is True

    rollback_project = Project(user_id=user_id, name="回滚项目")
    db.add(rollback_project)
    await db.commit()
    rollback_project_id = rollback_project.id
    failed = await _canvas_batch(db, user_id, {"canvas_id": canvas_id, "request_id": "batch-rollback-2", "operations": [
        {"kind": "add_node", "ref_type": "project", "ref_id": rollback_project_id},
        {"kind": "unsupported"},
    ]})
    assert failed["rolled_back"] is True
    assert await db.scalar(select(MindNode).where(MindNode.ref_type == "project", MindNode.ref_id == rollback_project_id)) is None


async def test_batch_idempotency_conflict_on_different_payload(db, user_a):
    """同 request_id + 不同 payload → idempotency_conflict=True。"""
    canvas = await _canvas(db, user_a)
    project_a = Project(user_id=user_a.id, name="项目A")
    project_b = Project(user_id=user_a.id, name="项目B")
    db.add_all([project_a, project_b])
    await db.commit()
    await db.refresh(project_a)
    await db.refresh(project_b)

    req_a = {"canvas_id": canvas.id, "request_id": "idem-conflict", "operations": [
        {"kind": "add_node", "ref_type": "project", "ref_id": project_a.id, "position": {"x": 0, "y": 0}},
    ]}
    req_b = {"canvas_id": canvas.id, "request_id": "idem-conflict", "operations": [
        {"kind": "add_node", "ref_type": "project", "ref_id": project_b.id, "position": {"x": 100, "y": 100}},
    ]}
    first = await _canvas_batch(db, user_a.id, req_a)
    assert first["atomic"] is True
    conflict = await _canvas_batch(db, user_a.id, req_b)
    assert conflict["idempotency_conflict"] is True


async def test_batch_idempotent_replay_create_note_only_one_row(db, user_a):
    """同 request_id 重放 create_note → 数据库只有一份 note。"""
    canvas = await _canvas(db, user_a)
    req = {"canvas_id": canvas.id, "request_id": "idem-note", "operations": [
        {"kind": "create_note", "title": "幂等便签", "content": "内容"},
    ]}
    first = await _canvas_batch(db, user_a.id, req)
    assert first["atomic"] is True
    assert first["operations"][0]["created"] is True
    node_id = first["operations"][0]["node"]["node_id"]

    second = await _canvas_batch(db, user_a.id, req)
    assert second == first

    # 数据库中只有一份 note
    notes = (await db.execute(select(MindNode).where(
        MindNode.user_id == user_a.id,
        MindNode.kind == "canvas_note",
        MindNode.title == "幂等便签",
    ))).scalars().all()
    assert len(notes) == 1
    assert notes[0].id == node_id


async def test_canvas_crud_arrays_and_batch_delete_are_limited_and_confirmed(db, user_a):
    user_id = user_a.id
    canvas = await _canvas(db, user_a)
    canvas_id = canvas.id
    created = await _canvas_create_note(db, user_a.id, {
        "canvas_id": canvas_id,
        "notes": [
            {"title": "批量一", "content": "内容一"},
            {"title": "批量二", "content": "内容二"},
        ],
    })
    assert created["count"] == 2
    note_ids = [entry["node"]["node_id"] for entry in created["results"]]

    updated = await _canvas_update_note(db, user_a.id, {
        "updates": [
            {"node_id": note_ids[0], "version": 1, "content": "更新一"},
            {"node_id": note_ids[1], "version": 1, "content": "更新二"},
        ],
    })
    assert updated["count"] == 2

    removed = await _canvas_remove_node(db, user_a.id, {
        "canvas_id": canvas_id,
        "item_ids": [entry["node"]["item_id"] for entry in created["results"]],
    })
    assert removed["count"] == 2
    assert all(item["node_preserved"] for item in removed["results"])

    notes = await db.scalars(select(MindNode).where(MindNode.id.in_(note_ids)))
    versions = [note.version for note in notes]
    blocked = await _canvas_delete_note(db, user_a.id, {
            "notes": [{"node_id": node_id} for node_id in note_ids],
    })
    blocked_payload = json.loads(blocked)
    assert blocked_payload["needs_confirm"] is True
    deleted = await _canvas_delete_note(db, user_a.id, {
            "notes": [{"node_id": node_id} for node_id in note_ids],
        "confirm": True,
        "confirm_token": blocked_payload["confirm_token"],
    })
    assert deleted["count"] == 2

    too_many = await _canvas_create_note(db, user_a.id, {
        "canvas_id": canvas_id,
        "notes": [{"content": str(index)} for index in range(21)],
    })
    assert "最多处理 20 个操作" in too_many["error"]

    batch = await _canvas_batch(db, user_a.id, {
        "canvas_id": canvas.id,
        "request_id": "batch-crud-001",
        "operations": [
            {"kind": "create_note", "title": "事务便签", "content": "事务内容"},
        ],
    })
    assert batch["atomic"] is True
    assert batch["operations"][0]["created"] is True
    batch_node = batch["operations"][0]["node"]
    batch_item_id = batch_node["item_id"]
    rejected_batch_size = await _canvas_batch(db, user_id, {
        "canvas_id": canvas_id,
        "request_id": "batch-crud-size-rejected",
        "operations": [{"kind": "update_item", "item_id": batch_item_id, "w": 100, "h": 60}],
    })
    assert rejected_batch_size["rolled_back"] is True
    assert "不能修改画布卡片大小" in rejected_batch_size["error"]
    removed_batch = await _canvas_batch(db, user_id, {
        "canvas_id": canvas_id,
        "request_id": "batch-crud-remove-001",
        "operations": [{"kind": "remove_item", "item_id": batch_item_id}],
    })
    assert removed_batch["atomic"] is True
    assert removed_batch["operations"][0]["node_preserved"] is True

    delete_request = {
        "canvas_id": canvas_id,
        "request_id": "batch-crud-delete-001",
            "operations": [{"kind": "delete_note", "node_id": batch_node["node_id"]}],
    }
    blocked_batch = await _canvas_batch(db, user_id, delete_request)
    blocked_batch_payload = json.loads(blocked_batch)
    assert blocked_batch_payload["needs_confirm"] is True
    delete_request.update({"confirm": True, "confirm_token": blocked_batch_payload["confirm_token"]})
    deleted_batch = await _canvas_batch(db, user_id, delete_request)
    assert deleted_batch["atomic"] is True
    assert deleted_batch["operations"][0]["deleted_node_id"] == batch_node["node_id"]


async def test_empty_canvas_auto_placement_uses_world_coordinates(db, user_a):
    """空画布 auto placement 应该用 world = -camera/scale + margin，而不是直接用 camera。"""
    data = {"x": 600, "y": 400, "scale": 1.0, "viewport": {"width": 1200, "height": 800}}
    canvas = await _canvas(db, user_a, data=data)
    batch = await _canvas_batch(db, user_a.id, {
        "canvas_id": canvas.id,
        "request_id": "auto-place-empty",
        "operations": [
            {"kind": "create_note", "title": "首张便签", "content": "测试"},
        ],
    })
    assert batch["atomic"] is True
    pos = batch["operations"][0]["node"]["position"]
    # world_x = -600/1 + 40 = -560, world_y = -400/1 + 40 = -360
    assert pos["x"] == -560.0
    assert pos["y"] == -360.0


async def test_empty_canvas_auto_placement_with_scale(db, user_a):
    """空画布 scale != 1 时 auto placement 坐标仍然正确。"""
    data = {"x": 600, "y": 400, "scale": 0.5, "viewport": {"width": 1200, "height": 800}}
    canvas = await _canvas(db, user_a, data=data)
    batch = await _canvas_batch(db, user_a.id, {
        "canvas_id": canvas.id,
        "request_id": "auto-place-scale",
        "operations": [
            {"kind": "create_note", "title": "缩放便签", "content": "测试"},
        ],
    })
    assert batch["atomic"] is True
    pos = batch["operations"][0]["node"]["position"]
    # world_x = -600/0.5 + 40 = -1160, world_y = -400/0.5 + 40 = -760
    assert pos["x"] == -1160.0
    assert pos["y"] == -760.0


async def test_get_canvas_limit_1_keeps_full_relations_and_marks_incomplete_audit(db, user_a):
    """节点分页仍返回全画布关系，并明确标记当前页之外的审计端点。"""
    data = {"x": 0, "y": 0, "scale": 1.0, "viewport": {"width": 1200, "height": 800}}
    canvas = await _canvas(db, user_a, data=data)
    # 创建两个便签并连接
    batch = await _canvas_batch(db, user_a.id, {
        "canvas_id": canvas.id,
        "request_id": "dangling-setup",
        "operations": [
            {"kind": "create_note", "title": "A", "content": ""},
            {"kind": "create_note", "title": "B", "content": ""},
        ],
    })
    node_a_id = batch["operations"][0]["node"]["node_id"]
    node_b_id = batch["operations"][1]["node"]["node_id"]
    from agent.tools.mind_canvas import _canvas_connect
    connect_result = await _canvas_connect(db, user_a.id, {
        "canvas_id": canvas.id,
        "source_node_id": node_a_id,
        "target_node_id": node_b_id,
        "type": "related",
    })
    assert "relation_id" in connect_result

    # limit=1 只返回第一个节点
    from agent.tools.mind_canvas import _canvas_get
    result = await _canvas_get(db, user_a.id, {
        "canvas_id": canvas.id,
        "limit": 1,
    })
    assert len(result["nodes"]) == 1
    assert result["truncated"] is True
    assert result["pagination"] == {"offset": 0, "limit": 1, "total": 2, "next_offset": 1}
    assert result["relation_count"] == 1
    assert result["relation_scope"] == "canvas"
    returned_ids = {n["node_id"] for n in result["nodes"]}
    assert len(result["relations"]) == 1
    assert result["relation_audit"][0]["status"] == "incomplete"
    assert result["relation_audit_scope"] == "visible_nodes"

    second_page = await _canvas_get(db, user_a.id, {
        "canvas_id": canvas.id, "limit": 1, "offset": 1,
    })
    assert len(second_page["nodes"]) == 1
    assert second_page["pagination"]["next_offset"] is None
    assert second_page["relation_audit"][0]["status"] == "incomplete"
