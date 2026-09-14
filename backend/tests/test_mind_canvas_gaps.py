"""agent/tools/mind_canvas.py CRAP 治理 P1 缺口补测。

与 test_mind_canvas_tools.py 互补：聚焦画布删除（确认门）、断开关联批量、
节点布局更新校验矩阵、批量操作守卫、placeable 搜索分页与 _card_size_fields。
确认门用 monkeypatch 归零验证放行路径，拦截路径保持真实门。
"""
import pytest

from app.models import MindMap, MindCanvasItem, MindNode, Project
from agent.tools.mind_canvas import (
    _card_size_fields,
    _canvas_batch,
    _canvas_connect,
    _canvas_delete,
    _canvas_disconnect,
    _canvas_remove_node,
    _canvas_search_placeable,
    _canvas_update_node,
    _canvas_update_note,
)


async def _canvas(db, user, title="测试画布"):
    canvas = MindMap(user_id=user.id, title=title, data_json="{}")
    db.add(canvas)
    await db.commit()
    await db.refresh(canvas)
    return canvas


async def _node(db, user, *, kind="canvas_note", title="便签", content="内容",
                ref_type=None, ref_id=None):
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


async def _note_and_item(db, user, canvas, *, title="待删便签", x=10):
    note = await _node(db, user, kind="canvas_note", title=title)
    item = await _item(db, user, canvas, note, x=x)
    return note, item


async def _connected_pair(db, user, canvas, *, x_base=100):
    first = await _node(db, user, title="端点一")
    second = await _node(db, user, title="端点二")
    await _item(db, user, canvas, first, x=x_base)
    await _item(db, user, canvas, second, x=x_base + 200)
    relation = await _canvas_connect(db, user.id, {
        "canvas_id": canvas.id, "source_node_id": first.id, "target_node_id": second.id})
    return relation["relation_id"]


# ── _canvas_delete：批量 + 单个 + 确认门 ──────────────────────────────────

async def test_canvas_delete_batch_and_single_with_confirmation(db, user_a, monkeypatch):
    c1 = await _canvas(db, user_a, "画布甲")
    c2 = await _canvas(db, user_a, "画布乙")

    assert "canvas_ids 必须是" in (await _canvas_delete(db, user_a.id, {"canvas_ids": "x"}))["error"]
    assert "canvas_ids 必须是" in (await _canvas_delete(db, user_a.id, {"canvas_ids": []}))["error"]
    assert "canvas_ids 必须是" in (await _canvas_delete(db, user_a.id, {"canvas_ids": list(range(21))}))["error"]
    assert "不存在" in (await _canvas_delete(db, user_a.id, {"canvas_ids": [987654]}))["error"]

    blocked_batch = await _canvas_delete(db, user_a.id, {"canvas_ids": [c1.id, c2.id]})
    assert "success" not in str(blocked_batch)                         # 未确认被拦

    assert "需要提供 canvas_id" in (await _canvas_delete(db, user_a.id, {}))["error"]
    assert "画布不存在" in (await _canvas_delete(db, user_a.id, {"canvas_id": 987654}))["error"]

    c3 = await _canvas(db, user_a, "画布丙")
    blocked_single = await _canvas_delete(db, user_a.id, {"canvas_id": c3.id})
    assert "deleted" not in str(blocked_single)

    monkeypatch.setattr("agent.security.confirm.needs_target_confirmation", lambda *a, **k: None)
    batch = await _canvas_delete(db, user_a.id, {"canvas_ids": [c2.id, c1.id]})
    assert batch["success"] and batch["deleted_canvas_ids"] == sorted([c1.id, c2.id])
    single = await _canvas_delete(db, user_a.id, {"canvas_id": c3.id})
    assert single == {"deleted": True, "canvas_id": c3.id, "title": "画布丙"}


# ── _canvas_disconnect：批量校验与确认放行 ────────────────────────────────

async def test_canvas_disconnect_batch_validation_and_confirmed(db, user_a, monkeypatch):
    canvas = await _canvas(db, user_a)
    r1 = await _connected_pair(db, user_a, canvas, x_base=100)
    r2 = await _connected_pair(db, user_a, canvas, x_base=500)

    assert "需要提供 canvas_id" in (await _canvas_disconnect(db, user_a.id, {}))["error"]
    assert "relation_ids 必须是" in (await _canvas_disconnect(
        db, user_a.id, {"canvas_id": canvas.id, "relation_ids": "x"}))["error"]
    assert "relation_ids 必须是" in (await _canvas_disconnect(
        db, user_a.id, {"canvas_id": canvas.id, "relation_ids": []}))["error"]
    assert "不存在" in (await _canvas_disconnect(
        db, user_a.id, {"canvas_id": canvas.id, "relation_ids": [987654]}))["error"]

    blocked = await _canvas_disconnect(
        db, user_a.id, {"canvas_id": canvas.id, "relation_ids": [r1, r2]})
    assert "success" not in str(blocked)

    monkeypatch.setattr("agent.security.confirm.needs_target_confirmation", lambda *a, **k: None)
    batch = await _canvas_disconnect(
        db, user_a.id, {"canvas_id": canvas.id, "relation_ids": [r2, r1]})
    assert batch["success"] and batch["deleted_relation_ids"] == sorted([r1, r2])

    assert "需要提供 relation_id" in (await _canvas_disconnect(
        db, user_a.id, {"canvas_id": canvas.id}))["error"]
    assert "关联不存在" in (await _canvas_disconnect(
        db, user_a.id, {"canvas_id": canvas.id, "relation_id": 987654}))["error"]

    r3 = await _connected_pair(db, user_a, canvas, x_base=900)
    single = await _canvas_disconnect(
        db, user_a.id, {"canvas_id": canvas.id, "relation_id": r3})
    assert single == {"deleted_relation_id": r3}


# ── _canvas_update_node：布局字段校验矩阵 ─────────────────────────────────

async def test_canvas_update_node_validation_matrix(db, user_a):
    canvas = await _canvas(db, user_a)
    note, _note_item = await _note_and_item(db, user_a, canvas)

    assert "需要提供 canvas_id" in (await _canvas_update_node(db, user_a.id, {}))["error"]
    assert "画布不存在" in (await _canvas_update_node(
        db, user_a.id, {"canvas_id": 987654, "item_id": 1}))["error"]
    assert "updates 必须是非空数组" in (await _canvas_update_node(
        db, user_a.id, {"canvas_id": canvas.id, "updates": []}))["error"]
    assert "需要提供 item_id" in (await _canvas_update_node(
        db, user_a.id, {"canvas_id": canvas.id, "updates": [{}]}))["error"]
    assert "画布节点不存在" in (await _canvas_update_node(
        db, user_a.id, {"canvas_id": canvas.id, "updates": [{"item_id": 987654}]}))["error"]
    assert "x 必须是有效数字" in (await _canvas_update_node(
        db, user_a.id, {"canvas_id": canvas.id, "item_id": note.id, "x": "10"}))["error"]
    assert "z 必须是整数" in (await _canvas_update_node(
        db, user_a.id, {"canvas_id": canvas.id, "item_id": note.id, "z": "3"}))["error"]
    assert "collapsed 必须是布尔值" in (await _canvas_update_node(
        db, user_a.id, {"canvas_id": canvas.id, "item_id": note.id, "collapsed": "yes"}))["error"]
    assert "至少提供一个要修改的布局字段" in (await _canvas_update_node(
        db, user_a.id, {"canvas_id": canvas.id, "item_id": note.id}))["error"]


async def test_canvas_update_node_sizes_only_for_notes_and_batch(db, user_a):
    canvas = await _canvas(db, user_a)
    note, _note_item = await _note_and_item(db, user_a, canvas)
    project = Project(user_id=user_a.id, name="引用项目", client="内部")
    db.add(project)
    await db.commit()
    await db.refresh(project)
    ref = await _node(db, user_a, kind="ref", title="引用项目", content="",
                      ref_type="project", ref_id=project.id)
    ref_item = await _item(db, user_a, canvas, ref, x=300)

    # 引用节点不允许设置卡片大小；「w/h」拼写一律提示用 width/height
    denied = await _canvas_update_node(db, user_a.id, {
        "canvas_id": canvas.id, "item_id": ref_item.id, "width": 100, "height": 80})
    assert "只有画布便签支持设置卡片大小" in denied["error"]
    short_key = await _canvas_update_node(db, user_a.id, {
        "canvas_id": canvas.id, "item_id": note.id, "w": 100})
    assert "请使用 width 和 height" in short_key["error"]
    pos_key = await _canvas_update_node(db, user_a.id, {
        "canvas_id": canvas.id, "item_id": note.id, "position": {"w": 100}})
    assert "请使用 width 和 height" in pos_key["error"]

    ok = await _canvas_update_node(db, user_a.id, {
        "canvas_id": canvas.id, "item_id": note.id,
        "x": 55, "y": 66, "z": 7, "collapsed": True, "width": 220, "height": 160})
    assert ok["updated"] is True and ok["node"]["node_id"] == note.id

    batched = await _canvas_update_node(db, user_a.id, {"canvas_id": canvas.id, "updates": [
        {"item_id": note.id, "x": 1},
        {"item_id": ref_item.id, "x": 2},
    ]})
    assert batched["count"] == 2 and batched["canvas_id"] == canvas.id


# ── _canvas_remove_node：单项/批量 ────────────────────────────────────────

async def test_canvas_remove_node_single_batch_and_errors(db, user_a):
    canvas = await _canvas(db, user_a)
    n1, _i1 = await _note_and_item(db, user_a, canvas)
    n2, item2 = await _note_and_item(db, user_a, canvas, title="第二条", x=200)

    assert "需要提供 canvas_id" in (await _canvas_remove_node(db, user_a.id, {}))["error"]
    assert "画布不存在" in (await _canvas_remove_node(
        db, user_a.id, {"canvas_id": 987654, "item_id": 1}))["error"]
    assert "有效 item_id" in (await _canvas_remove_node(
        db, user_a.id, {"canvas_id": canvas.id}))["error"]
    assert "item_ids 必须是非空数组" in (await _canvas_remove_node(
        db, user_a.id, {"canvas_id": canvas.id, "item_ids": []}))["error"]
    assert "画布节点不存在" in (await _canvas_remove_node(
        db, user_a.id, {"canvas_id": canvas.id, "item_id": 987654}))["error"]

    single = await _canvas_remove_node(db, user_a.id, {"canvas_id": canvas.id, "item_id": item2.id})
    assert single["removed_item_id"] == item2.id and single["node_preserved"] is True
    assert n1 is not None and n2 is not None                           # 只摘视图，节点保留

    batched = await _canvas_remove_node(db, user_a.id, {
        "canvas_id": canvas.id, "item_ids": [987654]})
    assert "画布节点不存在" in batched["error"]                        # 批量下同样中止


# ── _canvas_update_note：字段校验与版本冲突 ───────────────────────────────

async def test_canvas_update_note_fields_and_conflict(db, user_a, monkeypatch):
    canvas = await _canvas(db, user_a)
    note, _note_item = await _note_and_item(db, user_a, canvas)

    assert "必须提供 node_id" in (await _canvas_update_note(db, user_a.id, {"updates": [{}]}))["error"]
    assert "找不到这条画布便签" in (await _canvas_update_note(
        db, user_a.id, {"node_id": 987654, "title": "x"}))["error"]
    assert "便签标题格式不正确" in (await _canvas_update_note(
        db, user_a.id, {"node_id": note.id, "title": 123}))["error"]
    assert "便签正文必须是文本" in (await _canvas_update_note(
        db, user_a.id, {"node_id": note.id, "content": 123}))["error"]
    assert "至少提供一个要修改的字段" in (await _canvas_update_note(
        db, user_a.id, {"node_id": note.id}))["error"]

    ok = await _canvas_update_note(db, user_a.id, {
        "node_id": note.id, "title": "   ", "content": "新正文", "color": "amber"})
    assert ok["updated"] is True and ok["node"]["title"] == "新便签"    # 空白标题回退默认

    batched = await _canvas_update_note(db, user_a.id, {"updates": [
        {"node_id": note.id, "title": "批量甲"},
        {"node_id": 987654, "title": "批量乙"},
    ]})
    assert "找不到这条画布便签" in batched["error"]                    # 任一项失败整批报错

    async def conflict(*args, **kwargs):
        return False                                                   # 模拟乐观锁失败

    monkeypatch.setattr("agent.tools.mind_canvas.update_canvas_note", conflict)
    raced = await _canvas_update_note(db, user_a.id, {"node_id": note.id, "title": "再改"})
    assert "刚被修改" in raced["error"]


# ── _canvas_batch：守卫与 delete_note 确认 ────────────────────────────────

async def test_canvas_batch_guards_and_delete_note_confirmation(db, user_a, monkeypatch):
    canvas = await _canvas(db, user_a)
    note, _note_item = await _note_and_item(db, user_a, canvas)

    assert "需要提供 canvas_id 和非空 operations" in (await _canvas_batch(
        db, user_a.id, {"canvas_id": canvas.id, "operations": "x"}))["error"]
    assert "需要提供 canvas_id 和非空 operations" in (await _canvas_batch(
        db, user_a.id, {"canvas_id": canvas.id}))["error"]
    assert "单次最多批量处理 20 个操作" in (await _canvas_batch(
        db, user_a.id, {"canvas_id": canvas.id, "request_id": "r",
                        "operations": [{"kind": "noop"}] * 21}))["error"]
    assert "request_id" in (await _canvas_batch(
        db, user_a.id, {"canvas_id": canvas.id, "request_id": "  ",
                        "operations": [{"kind": "noop"}]}))["error"]
    assert "画布不存在" in (await _canvas_batch(
        db, user_a.id, {"canvas_id": 987654, "request_id": "r",
                        "operations": [{"kind": "noop"}]}))["error"]
    assert "必须提供正整数 node_id" in (await _canvas_batch(
        db, user_a.id, {"canvas_id": canvas.id, "request_id": "r", "operations": [
            {"kind": "delete_note", "node_id": True},
            {"kind": "delete_note", "node_id": 0},
        ]}))["error"]

    blocked = await _canvas_batch(db, user_a.id, {
        "canvas_id": canvas.id, "request_id": "r1",
        "operations": [{"kind": "delete_note", "node_id": note.id}]})
    assert "success" not in str(blocked)                               # 未确认整批拦截

    monkeypatch.setattr("agent.security.confirm.needs_target_confirmation", lambda *a, **k: None)
    done = await _canvas_batch(db, user_a.id, {
        "canvas_id": canvas.id, "request_id": "r2",
        "operations": [{"kind": "delete_note", "node_id": note.id}]})
    assert done["atomic"] is True and done["operations"][0]["deleted_node_id"] == note.id


# ── _canvas_search_placeable：分页、围栏与非法类型 ────────────────────────

async def test_canvas_search_placeable_pagination_and_guards(db, user_a):
    assert "需要提供搜索关键词" in (await _canvas_search_placeable(db, user_a.id, {}))["error"]
    assert "画布不存在" in (await _canvas_search_placeable(
        db, user_a.id, {"q": "x", "canvas_id": 987654}))["error"]

    for i in range(3):
        db.add(Project(user_id=user_a.id, name=f"_alpha_{i}", client="内部"))
    await db.commit()

    page = await _canvas_search_placeable(
        db, user_a.id, {"queries": ["_alpha_"], "types": ["project"], "limit": 2})
    assert page["count"] == 3 and len(page["matches"]) == 2 and page["truncated"] is True

    page2 = await _canvas_search_placeable(
        db, user_a.id, {"q": "_alpha_", "types": ["project"], "limit": 2, "offset": 2})
    assert len(page2["matches"]) == 1 and page2["offset"] == 2 and page2["truncated"] is False

    bogus = await _canvas_search_placeable(
        db, user_a.id, {"q": "_alpha_", "types": ["bogus"]})
    assert bogus["matches"] == []                                      # 非法类型整体被滤掉


# ── _card_size_fields：纯函数 ──────────────────────────────────────────────

def test_card_size_fields_rules():
    with pytest.raises(ValueError):
        _card_size_fields({"w": 100, "h": 80}, allow=True)
    with pytest.raises(ValueError):
        _card_size_fields({"position": {"w": 100}}, allow=True)
    with pytest.raises(ValueError):
        _card_size_fields({"width": 100}, allow=False)

    assert _card_size_fields({}, allow=True) == {}
    sized = _card_size_fields({"width": 220, "height": 160}, allow=True)
    assert sized == {"w": 220, "h": 160}
    assert set(_card_size_fields({"width": 99999, "height": 1}, allow=True)) == {"w", "h"}
