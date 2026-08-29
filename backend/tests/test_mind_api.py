"""思维面板 P1：记录时间流 + 便签 CRUD + `[[` 引用补全 + 便签进全局搜索。

对应 docs/product/思维面板/实现方案.md 的 P1 验收项。
路由函数直接调（同 test_global_search.py 的做法），不起 TestClient。
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from app.api.v1.mind import (
    add_canvas_item, create_canvas, create_note, create_ref_node, create_relation,
    create_canvas_note, delete_canvas, delete_note, list_canvas_items, list_canvas_relations,
    list_canvases, list_notes,
    ref_suggest, remove_canvas_item, update_canvas, update_canvas_item, update_canvas_note, update_note,
)
from app.api.v1 import mind as mind_api
from app.api.v1.search import run_global_search
from app.core.mind import content_hash, to_plain_text
from app.core.tz import now_utc
from app.models import CalendarEvent, Client, File, MindCanvasItem, MindMap, MindNode, Project
from app.schemas import (
    MindCanvasCreate, MindCanvasItemCreate, MindCanvasItemUpdate, MindCanvasNoteCreate, MindCanvasUpdate,
    MindCanvasNoteUpdate, MindNoteCreate, MindNoteUpdate, MindRefNodeCreate, MindRelationCreate,
)


async def _new_note(db, user, content="一条想法", **kw):
    return await create_note(MindNoteCreate(content_md=content, **kw), current_user=user, db=db)


async def _row(db, nid) -> MindNode:
    return await db.scalar(select(MindNode).where(MindNode.id == nid))


async def _count_notes(db) -> int:
    return await db.scalar(select(func.count()).select_from(MindNode))


# ── to_plain_text：正文能被搜到的前提 ─────────────────────────────────────────

def test_plain_text_strips_markdown_syntax():
    md = "# 标题\n\n- [ ] 待办一\n- 列表项\n\n**粗体** 和 `代码`\n\n> 引用\n"
    plain = to_plain_text(md)
    for noise in ("#", "- [ ]", "**", "`", ">"):
        assert noise not in plain
    assert "标题" in plain and "待办一" in plain and "粗体" in plain and "引用" in plain


def test_plain_text_keeps_object_reference_label():
    """`[[project:7|某项目]]` 要留下「某项目」，否则按名字搜不到引用了它的便签。"""
    plain = to_plain_text("跟进 [[project:7|某项目]] 的收尾")
    assert plain == "跟进 某项目 的收尾"


def test_plain_text_keeps_link_text_drops_url():
    assert to_plain_text("见 [文档](https://example.com/x)") == "见 文档"


# ── 便签 CRUD ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_note_derives_plain_text_and_marks_pending_index(db, user_a):
    resp = await _new_note(db, user_a, content="# 想法\n\n跟进 [[project:7|某项目]]")
    assert resp.kind == "note"
    assert resp.version == 1

    row = await _row(db, resp.id)
    assert row.content_plain == "想法\n跟进 某项目"      # 服务端推导，不信客户端
    assert row.indexed_hash == content_hash(row.content_plain)
    assert row.indexed_at is None                        # null = 待索引


@pytest.mark.asyncio
async def test_create_note_accepts_backfilled_captured_at(db, user_a):
    past = datetime(2020, 5, 6, 7, 8, tzinfo=timezone.utc)   # datetime 列走 UtcDateTime，读回是 aware UTC
    resp = await _new_note(db, user_a, content="补录昨天的想法", captured_at=past)
    assert resp.captured_at == past
    assert resp.created_at > past                        # created_at 仍是落库时间


@pytest.mark.asyncio
async def test_create_note_rejects_future_captured_at(db, user_a):
    future = datetime.now() + timedelta(days=1)
    with pytest.raises(HTTPException) as e:
        await _new_note(db, user_a, content="明天再想", captured_at=future)
    assert e.value.status_code == 422
    assert await _count_notes(db) == 0


@pytest.mark.asyncio
async def test_timeline_orders_by_captured_at_not_created_at(db, user_a):
    """补录的旧想法必须落回它「发生」的那天，不能因为刚写就排最前。"""
    now = now_utc()
    await _new_note(db, user_a, content="今天写的", captured_at=now)
    await _new_note(db, user_a, content="补录很久以前的", captured_at=now - timedelta(days=30))
    await _new_note(db, user_a, content="补录昨天的", captured_at=now - timedelta(days=1))

    rows = await list_notes(limit=50, offset=0, current_user=user_a, db=db)
    assert [r.content_md for r in rows] == ["今天写的", "补录昨天的", "补录很久以前的"]


@pytest.mark.asyncio
async def test_timeline_hides_soft_deleted_and_other_users_notes(db, user_a, user_b):
    keep = await _new_note(db, user_a, content="我的")
    gone = await _new_note(db, user_a, content="待删")
    await _new_note(db, user_b, content="别人的")
    await delete_note(gone.id, current_user=user_a, db=db)

    rows = await list_notes(limit=50, offset=0, current_user=user_a, db=db)
    assert [r.id for r in rows] == [keep.id]


@pytest.mark.asyncio
async def test_update_note_bumps_version_and_resets_index(db, user_a):
    note = await _new_note(db, user_a, content="原文")
    row = await _row(db, note.id)
    row.indexed_at = now_utc()                   # 装作已经向量化过
    await db.commit()

    resp = await update_note(note.id, MindNoteUpdate(content_md="改了正文", version=1),
                             current_user=user_a, db=db)
    assert resp.version == 2

    row = await _row(db, note.id)
    assert row.content_plain == "改了正文"
    assert row.indexed_at is None                        # 正文变了 → 必须重新索引
    assert row.indexed_hash == content_hash("改了正文")


@pytest.mark.asyncio
async def test_update_note_with_stale_version_returns_409(db, user_a):
    note = await _new_note(db, user_a, content="原文")
    await update_note(note.id, MindNoteUpdate(title="先到", version=1), current_user=user_a, db=db)

    with pytest.raises(HTTPException) as e:
        await update_note(note.id, MindNoteUpdate(title="后到", version=1), current_user=user_a, db=db)
    assert e.value.status_code == 409

    row = await _row(db, note.id)
    assert row.title == "先到"                           # 后到的没覆盖掉先到的


@pytest.mark.asyncio
async def test_update_note_of_other_user_is_404(db, user_a, user_b):
    note = await _new_note(db, user_b, content="别人的")
    with pytest.raises(HTTPException) as e:
        await update_note(note.id, MindNoteUpdate(title="越权", version=1), current_user=user_a, db=db)
    assert e.value.status_code == 404                    # 不泄露「存在但不是你的」


@pytest.mark.asyncio
async def test_update_soft_deleted_note_is_404(db, user_a):
    note = await _new_note(db, user_a, content="待删")
    await delete_note(note.id, current_user=user_a, db=db)
    with pytest.raises(HTTPException) as e:
        await update_note(note.id, MindNoteUpdate(title="改墓碑", version=1), current_user=user_a, db=db)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_delete_note_is_soft_and_keeps_the_row(db, user_a):
    """删便签只写 deleted_at——节点行留着当墓碑，它参与的关系才不会静默断裂。"""
    note = await _new_note(db, user_a, content="待删")
    await delete_note(note.id, current_user=user_a, db=db)

    assert await _count_notes(db) == 1                   # 行还在
    row = await _row(db, note.id)
    assert row.deleted_at is not None


@pytest.mark.asyncio
async def test_delete_note_of_other_user_is_404(db, user_a, user_b):
    note = await _new_note(db, user_b, content="别人的")
    with pytest.raises(HTTPException) as e:
        await delete_note(note.id, current_user=user_a, db=db)
    assert e.value.status_code == 404
    assert (await _row(db, note.id)).deleted_at is None  # 没被删掉


@pytest.mark.asyncio
async def test_note_mutations_publish_canonical_mind_events(db, user_a, monkeypatch):
    """笔记事件必须在提交后以完整实体发布，不能依赖旧的 mind.canvas 参数格式。"""
    published = []

    async def publish(user_id, *resources, **kwargs):
        published.append((user_id, resources, kwargs))

    monkeypatch.setattr(mind_api.events, "publish", publish)
    note = await _new_note(db, user_a, content="初始")
    await update_note(note.id, MindNoteUpdate(content_md="更新", version=1), current_user=user_a, db=db)
    await delete_note(note.id, current_user=user_a, db=db)

    assert [entry[1] for entry in published] == [("mind",), ("mind",), ("mind",)]
    assert [entry[2]["operation"] for entry in published] == ["create", "update", "delete"]
    assert published[0][2]["event_payload"]["kind"] == "note"
    assert published[0][2]["event_payload"]["entity"]["id"] == note.id


@pytest.mark.asyncio
async def test_canvas_mutations_publish_canonical_mind_events(db, user_a, monkeypatch):
    """画布及其删除必须走同一条 canonical 事件链，且事件发生在提交之后。"""
    published = []

    async def publish(user_id, *resources, **kwargs):
        published.append((user_id, resources, kwargs))

    monkeypatch.setattr(mind_api.events, "publish", publish)
    canvas = await create_canvas(MindCanvasCreate(title="事件画布"), current_user=user_a, db=db)
    await update_canvas(canvas.id, MindCanvasUpdate(title="更新画布"), current_user=user_a, db=db)
    await delete_canvas(canvas.id, current_user=user_a, db=db)

    assert [entry[1] for entry in published] == [("mind",), ("mind",), ("mind",)]
    assert [entry[2]["operation"] for entry in published] == ["create", "update", "delete"]
    assert [entry[2]["event_payload"]["kind"] for entry in published[:2]] == ["canvas", "canvas"]
    assert published[-1][2]["event_payload"] == {"kind": "canvas", "entity": {"id": canvas.id}}


# ── `[[` 对象引用补全 ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_ref_suggest_returns_stable_type_and_id(db, user_a):
    p = Project(user_id=user_a.id, name="星尘计划")
    db.add(p)
    await db.commit()
    await db.refresh(p)

    items = await ref_suggest(q="星尘", limit=6, current_user=user_a, db=db)
    assert [(i.type, i.id, i.label) for i in items] == [("project", p.id, "星尘计划")]


@pytest.mark.asyncio
async def test_ref_suggest_only_covers_project_file_event(db, user_a):
    """客户/对话不作为便签的引用对象，别混进补全列表。"""
    db.add(Client(user_id=user_a.id, name="星尘客户"))
    db.add(Project(user_id=user_a.id, name="星尘计划"))
    db.add(File(user_id=user_a.id, display_name="星尘", ext="md", storage_key="k", size="1"))
    db.add(CalendarEvent(user_id=user_a.id, title="星尘评审", date="2026-07-10"))
    await db.commit()

    items = await ref_suggest(q="星尘", limit=6, current_user=user_a, db=db)
    assert {i.type for i in items} == {"project", "file", "event"}


@pytest.mark.asyncio
async def test_ref_suggest_empty_query_returns_nothing(db, user_a):
    assert await ref_suggest(q="   ", limit=6, current_user=user_a, db=db) == []


# ── 便签进全局搜索（顶栏下拉 + 咕咕 global_search 共用同一套）─────────────────

@pytest.mark.asyncio
async def test_global_search_finds_note_by_body_text(db, user_a):
    """便签短，正文可以直接搜——不像文件那样只能搜名字。"""
    await _new_note(db, user_a, content="要给猫剪指甲，别忘了买指甲刀")

    result = await run_global_search(db, user_a.id, "指甲刀")
    groups = {g["type"]: g for g in result["groups"]}
    assert "note" in groups
    assert groups["note"]["items"][0]["subtitle"]        # 给了命中片段
    assert groups["note"]["items"][0]["version"] == 1  # 更新工具可直接使用，不得要求猜版本


@pytest.mark.asyncio
async def test_global_search_finds_note_by_referenced_object_name(db, user_a):
    """正文里写的是 `[[project:7|星尘计划]]`，搜「星尘计划」也该召回这条便签。"""
    await _new_note(db, user_a, content="[[project:7|星尘计划]] 下周启动")

    result = await run_global_search(db, user_a.id, "星尘计划", types=["note"])
    assert result["total"] == 1


@pytest.mark.asyncio
async def test_global_search_skips_deleted_notes_and_ref_nodes(db, user_a):
    """墓碑不该出现在搜索里；ref 节点只是代理，真身已在项目/文件那几组里搜过了。"""
    gone = await _new_note(db, user_a, content="星尘的旧想法")
    await delete_note(gone.id, current_user=user_a, db=db)
    db.add(MindNode(user_id=user_a.id, kind="ref", ref_type="project", ref_id=7, title="星尘计划"))
    await db.commit()

    result = await run_global_search(db, user_a.id, "星尘", types=["note"])
    assert result["total"] == 0


@pytest.mark.asyncio
async def test_global_search_isolates_notes_by_user(db, user_a, user_b):
    await _new_note(db, user_b, content="别人的秘密便签")
    result = await run_global_search(db, user_a.id, "秘密", types=["note"])
    assert result["total"] == 0


# ── P2 画布：节点全局，画布只存展示状态 ────────────────────────────────────────

@pytest.mark.asyncio
async def test_canvas_item_keeps_note_global_and_duplicate_add_is_idempotent(db, user_a):
    note = await _new_note(db, user_a, content="# 保留原文\n\n画布只是摆放")
    canvas = await create_canvas(MindCanvasCreate(title="方案桌面"), current_user=user_a, db=db)

    first = await add_canvas_item(
        canvas.id, MindCanvasItemCreate(node_id=note.id, x=120, y=80), current_user=user_a, db=db,
    )
    duplicate = await add_canvas_item(
        canvas.id, MindCanvasItemCreate(node_id=note.id, x=999, y=999), current_user=user_a, db=db,
    )
    assert duplicate.id == first.id
    assert duplicate.x == 120 and duplicate.y == 80

    moved = await update_canvas_item(
        canvas.id, first.id, MindCanvasItemUpdate(x=260, y=180, z=3), current_user=user_a, db=db,
    )
    assert (moved.x, moved.y, moved.z) == (260, 180, 3)
    assert (await _row(db, note.id)).content_md.startswith("# 保留原文")

    await remove_canvas_item(canvas.id, first.id, current_user=user_a, db=db)
    assert await db.scalar(select(func.count()).select_from(MindCanvasItem)) == 0
    assert await _row(db, note.id) is not None  # 移出画布绝不删除原记录


@pytest.mark.asyncio
async def test_event_canvas_item_embeds_display_snapshot(db, user_a):
    """画布首次加载就必须有活动描述/日期，不能靠前端逐卡补详情后二次撑高。"""
    event = CalendarEvent(
        user_id=user_a.id, title="设计评审", date="2026-07-14", time="14:30", end_time="15:30",
        description="确认画布交互细节", type="event",
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    node = await create_ref_node(
        MindRefNodeCreate(ref_type="event", ref_id=event.id), current_user=user_a, db=db,
    )
    canvas = await create_canvas(MindCanvasCreate(title="活动快照"), current_user=user_a, db=db)

    added = await add_canvas_item(
        canvas.id, MindCanvasItemCreate(node_id=node.id), current_user=user_a, db=db,
    )
    assert added.ref_data == {
        "date": "2026-07-14", "time": "14:30", "endTime": "15:30", "description": "确认画布交互细节",
    }

    listed = await list_canvas_items(canvas.id, current_user=user_a, db=db)
    assert listed[0].ref_data == added.ref_data


@pytest.mark.asyncio
async def test_canvas_note_is_independent_from_record_timeline(db, user_a):
    canvas = await create_canvas(MindCanvasCreate(title="独立便签"), current_user=user_a, db=db)
    item = await create_canvas_note(
        canvas.id, MindCanvasNoteCreate(title="画布想法", content_md="空间里的内容", x=80, y=120),
        current_user=user_a, db=db,
    )
    assert item.node.kind == "canvas_note"
    assert item.node.title == "画布想法"
    assert await list_notes(limit=50, offset=0, current_user=user_a, db=db) == []

    updated = await update_canvas_note(
        item.node_id, MindCanvasNoteUpdate(title="改过的画布想法", content_md="新正文", version=1),
        current_user=user_a, db=db,
    )
    assert (updated.title, updated.content_md, updated.version) == ("改过的画布想法", "新正文", 2)


@pytest.mark.asyncio
async def test_canvas_rejects_other_users_node_and_keeps_canvas_private(db, user_a, user_b):
    canvas = await create_canvas(MindCanvasCreate(title="我的画布"), current_user=user_a, db=db)
    foreign = await _new_note(db, user_b, content="别人的节点")
    with pytest.raises(HTTPException) as e:
        await add_canvas_item(
            canvas.id, MindCanvasItemCreate(node_id=foreign.id), current_user=user_a, db=db,
        )
    assert e.value.status_code == 404

    with pytest.raises(HTTPException) as e:
        await list_canvas_items(canvas.id, current_user=user_b, db=db)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_delete_canvas_cascades_items_but_keeps_nodes(db, user_a):
    canvas = await create_canvas(MindCanvasCreate(title="要删的画布"), current_user=user_a, db=db)
    note = await _new_note(db, user_a, content="节点应该留下")
    await add_canvas_item(canvas.id, MindCanvasItemCreate(node_id=note.id, x=10, y=20), current_user=user_a, db=db)
    assert await db.scalar(select(func.count()).select_from(MindCanvasItem)) == 1

    await delete_canvas(canvas.id, current_user=user_a, db=db)

    assert await db.scalar(select(func.count()).select_from(MindCanvasItem)) == 0   # 视图项级联删掉
    assert await _row(db, note.id) is not None                                      # 节点原文不受影响
    remaining = await list_canvases(project_id=None, current_user=user_a, db=db)
    assert canvas.id not in {c.id for c in remaining}

    with pytest.raises(HTTPException) as e:
        await delete_canvas(canvas.id, current_user=user_a, db=db)   # 已删的画布再删一次 → 404
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_delete_canvas_rejects_other_users_canvas(db, user_a, user_b):
    canvas = await create_canvas(MindCanvasCreate(title="别人的画布"), current_user=user_a, db=db)
    with pytest.raises(HTTPException) as e:
        await delete_canvas(canvas.id, current_user=user_b, db=db)
    assert e.value.status_code == 404
    assert await db.scalar(select(func.count()).select_from(MindMap)) == 1   # 没被误删


@pytest.mark.asyncio
async def test_canvas_relations_only_list_visible_nodes_and_are_idempotent(db, user_a):
    canvas = await create_canvas(MindCanvasCreate(title="关系"), current_user=user_a, db=db)
    a = await _new_note(db, user_a, content="A")
    b = await _new_note(db, user_a, content="B")
    outside = await _new_note(db, user_a, content="不在画布上")
    await add_canvas_item(canvas.id, MindCanvasItemCreate(node_id=a.id), current_user=user_a, db=db)
    await add_canvas_item(canvas.id, MindCanvasItemCreate(node_id=b.id), current_user=user_a, db=db)

    one = await create_relation(MindRelationCreate(src_node_id=a.id, dst_node_id=b.id), current_user=user_a, db=db)
    same = await create_relation(MindRelationCreate(src_node_id=b.id, dst_node_id=a.id), current_user=user_a, db=db)
    parallel = await create_relation(
        MindRelationCreate(src_node_id=a.id, dst_node_id=b.id, allow_parallel=True),
        current_user=user_a, db=db,
    )
    await create_relation(MindRelationCreate(src_node_id=a.id, dst_node_id=outside.id), current_user=user_a, db=db)
    assert one.id == same.id

    relations = await list_canvas_relations(canvas.id, current_user=user_a, db=db)
    assert [relation.id for relation in relations] == [one.id, parallel.id]


@pytest.mark.asyncio
async def test_ref_node_reuses_one_proxy_and_checks_target_ownership(db, user_a, user_b):
    project = Project(user_id=user_a.id, name="可贴项目")
    db.add(project)
    await db.commit()
    await db.refresh(project)

    first = await create_ref_node(
        MindRefNodeCreate(ref_type="project", ref_id=project.id), current_user=user_a, db=db,
    )
    same = await create_ref_node(
        MindRefNodeCreate(ref_type="project", ref_id=project.id), current_user=user_a, db=db,
    )
    assert (first.id, first.ref_type, first.ref_id, first.title) == (same.id, "project", project.id, "可贴项目")

    with pytest.raises(HTTPException) as e:
        await create_ref_node(
            MindRefNodeCreate(ref_type="project", ref_id=project.id), current_user=user_b, db=db,
        )
    assert e.value.status_code == 404
