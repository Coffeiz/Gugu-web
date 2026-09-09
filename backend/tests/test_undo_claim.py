"""Undo/Redo 操作行并发认领回归：apply 读取必须带 FOR UPDATE，重复请求走幂等分支。"""
import pytest

from app.services.undo import UndoService
from app.services.undo import files as undo_files


def _make_adapter_recorder(calls):
    class _RecordingAdapter:
        def __init__(self, db):
            self.db = db

        async def undo(self, operation, user_id):
            calls.append(("undo", operation.id))
            return {"events": []}

        async def redo(self, operation, user_id):
            calls.append(("redo", operation.id))
            return {"events": []}

    return _RecordingAdapter


async def _make_operation(db, user_a, context_id="claim-race"):
    operation = await UndoService.record_forward(
        db, user_id=user_a.id, context_id=context_id, resource="files", action="overwrite",
        target_refs=[{"kind": "file", "id": 1}], before_state={}, after_state={},
        base_versions={},
    )
    await db.commit()
    return operation


def test_claim_select_locks_operation_row(user_a):
    """认领查询必须 FOR UPDATE：并发 undo/redo 靠行锁串行化状态转换。"""
    statement = UndoService._claim_select(
        operation_id="op-1", user_id=user_a.id, context_id="ctx")
    compiled = str(statement.compile())
    assert "FOR UPDATE" in compiled.upper()


@pytest.mark.asyncio
async def test_second_undo_after_claim_takes_idempotent_branch(db, user_a, monkeypatch):
    """第一个请求执行资源变更后，拿到锁的第二个请求不得重复执行。

    模拟 Postgres 行锁的串行化结果：第二个 undo 读到前者提交的 undone 终态，
    必须返回 idempotent 而不是再次调用适配器。
    """
    calls = []
    monkeypatch.setattr(undo_files, "FileUndoAdapter", _make_adapter_recorder(calls))
    operation = await _make_operation(db, user_a)

    first = await UndoService.apply(
        db, user_id=user_a.id, context_id="claim-race",
        operation_id=operation.id, mode="undo")
    await db.commit()
    second = await UndoService.apply(
        db, user_id=user_a.id, context_id="claim-race",
        operation_id=operation.id, mode="undo")
    await db.commit()

    assert first["idempotent"] is False
    assert second["idempotent"] is True
    assert calls == [("undo", operation.id)]


@pytest.mark.asyncio
async def test_redo_after_undo_executes_and_repeats_idempotent(db, user_a, monkeypatch):
    """undo→redo→redo：首次 redo 真实执行，重复 redo 幂等，互不重复变更。"""
    calls = []
    monkeypatch.setattr(undo_files, "FileUndoAdapter", _make_adapter_recorder(calls))
    operation = await _make_operation(db, user_a)

    await UndoService.apply(db, user_id=user_a.id, context_id="claim-race",
                            operation_id=operation.id, mode="undo")
    await db.commit()
    first_redo = await UndoService.apply(db, user_id=user_a.id, context_id="claim-race",
                                         operation_id=operation.id, mode="redo")
    await db.commit()
    second_redo = await UndoService.apply(db, user_id=user_a.id, context_id="claim-race",
                                          operation_id=operation.id, mode="redo")
    await db.commit()

    assert first_redo["idempotent"] is False
    assert second_redo["idempotent"] is True
    assert calls == [("undo", operation.id), ("redo", operation.id)]
