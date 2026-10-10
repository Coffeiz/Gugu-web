"""统一撤销层 Phase 3：思维画布节点、视图项、关系和整图恢复。"""

import pytest

from app.core.tz import now_utc
from app.models import MindCanvasItem, MindMap, MindNode, MindRelation
from app.services.undo import UndoService
from app.services.undo.mind import canvas_snapshot, item_snapshot, node_snapshot, relation_snapshot, ref, state
from app.services.undo.service import UndoError


async def _save(db, row):
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_canvas_note_create_undo_redo_preserves_ids(db, user_a):
    canvas = await _save(db, MindMap(user_id=user_a.id, title="画布"))
    node = await _save(db, MindNode(user_id=user_a.id, kind="canvas_note", title="便签", content_md="正文"))
    item = await _save(db, MindCanvasItem(user_id=user_a.id, canvas_id=canvas.id, node_id=node.id, x=10, y=20))
    operation = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="phase3-note", resource="mind", action="create",
        target_refs=[{"kind": "canvas_note", "id": node.id}, {"kind": "canvas_item", "id": item.id}],
        before_state=state({}),
        after_state=state({ref("canvas_note", node.id): node_snapshot(node), ref("canvas_item", item.id): item_snapshot(item)}),
        base_versions={},
    )
    await db.commit()

    await UndoService.apply(db, user_id=user_a.id, context_id="phase3-note", operation_id=operation.id, mode="undo")
    await db.commit()
    await db.refresh(node)
    await db.refresh(item)
    assert node.deleted_at is not None and item.deleted_at is not None

    await UndoService.apply(db, user_id=user_a.id, context_id="phase3-note", operation_id=operation.id, mode="redo")
    await db.commit()
    await db.refresh(node)
    await db.refresh(item)
    assert node.id == node.id and item.id == item.id
    assert node.deleted_at is None and item.deleted_at is None


@pytest.mark.asyncio
async def test_canvas_delete_undo_restores_canvas_items_and_relations(db, user_a):
    canvas = await _save(db, MindMap(user_id=user_a.id, title="可恢复画布"))
    first = await _save(db, MindNode(user_id=user_a.id, kind="canvas_note", title="一", content_md=""))
    second = await _save(db, MindNode(user_id=user_a.id, kind="canvas_note", title="二", content_md=""))
    item_a = await _save(db, MindCanvasItem(user_id=user_a.id, canvas_id=canvas.id, node_id=first.id, x=1, y=2))
    item_b = await _save(db, MindCanvasItem(user_id=user_a.id, canvas_id=canvas.id, node_id=second.id, x=3, y=4))
    relation = await _save(db, MindRelation(
        user_id=user_a.id, canvas_id=canvas.id, src_node_id=first.id, dst_node_id=second.id,
    ))
    before_items = {
        ref("canvas", canvas.id): canvas_snapshot(canvas),
        ref("canvas_item", item_a.id): item_snapshot(item_a),
        ref("canvas_item", item_b.id): item_snapshot(item_b),
        ref("canvas_note", first.id): node_snapshot(first),
        ref("canvas_note", second.id): node_snapshot(second),
        ref("relation", relation.id): relation_snapshot(relation),
    }
    canvas.deleted_at = now_utc()
    item_a.deleted_at = now_utc()
    item_b.deleted_at = now_utc()
    relation.deleted_at = now_utc()
    await db.commit()
    for row in (canvas, item_a, item_b, relation):
        await db.refresh(row)
    after_items = {
        ref("canvas", canvas.id): canvas_snapshot(canvas),
        ref("canvas_item", item_a.id): item_snapshot(item_a),
        ref("canvas_item", item_b.id): item_snapshot(item_b),
        ref("canvas_note", first.id): node_snapshot(first),
        ref("canvas_note", second.id): node_snapshot(second),
        ref("relation", relation.id): relation_snapshot(relation),
    }
    operation = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="phase3-canvas-delete", resource="mind", action="delete",
        target_refs=[{"kind": key.split(":")[0], "id": int(key.split(":")[1])} for key in before_items],
        before_state=state(before_items), after_state=state(after_items), base_versions={},
    )
    await db.commit()

    await UndoService.apply(db, user_id=user_a.id, context_id="phase3-canvas-delete", operation_id=operation.id, mode="undo")
    await db.commit()
    for row in (canvas, item_a, item_b, relation):
        await db.refresh(row)
    assert all(row.deleted_at is None for row in (canvas, item_a, item_b, relation))


@pytest.mark.asyncio
async def test_canvas_item_undo_rejects_position_change(db, user_a):
    item = await _save(db, MindCanvasItem(user_id=user_a.id, canvas_id=1, node_id=1, x=10, y=10))
    before = item_snapshot(item)
    item.x = 20
    await db.commit()
    await db.refresh(item)
    operation = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="phase3-conflict", resource="mind", action="update",
        target_refs=[{"kind": "canvas_item", "id": item.id}], before_state=state({ref("canvas_item", item.id): before}),
        after_state=state({ref("canvas_item", item.id): item_snapshot(item)}), base_versions={},
    )
    await db.commit()
    item.x = 30
    await db.commit()
    with pytest.raises(UndoError) as error:
        await UndoService.apply(db, user_id=user_a.id, context_id="phase3-conflict", operation_id=operation.id, mode="undo")
    assert error.value.code == "undo.conflict"
