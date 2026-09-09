"""统一撤销/重做流程；领域语义交给资源适配器。"""
from __future__ import annotations

from copy import deepcopy
from datetime import timedelta
from uuid import uuid4

from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import UndoOperation


class UndoError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class UndoConflict(UndoError):
    def __init__(self, message: str = "资源已被其他操作修改，无法安全撤回"):
        super().__init__("undo.conflict", message)


class UndoNotFound(UndoError):
    def __init__(self):
        super().__init__("undo.not_found", "撤销操作不存在或不属于当前用户", status_code=404)


class UndoService:
    """操作记录的唯一公共入口。

    `record_forward` 只记录 Web 请求显式提供的 context；Agent、IM、同步和 Shell
    没有该 header，因此不会混入浏览器的 Ctrl/Command+Z 栈。
    """

    RETENTION = timedelta(days=30)
    @staticmethod
    def new_id(prefix: str) -> str:
        return f"{prefix}-{uuid4().hex}"

    @staticmethod
    def _context(context_id: str | None) -> str | None:
        if not context_id:
            return None
        context_id = context_id.strip()
        return context_id[:128] if context_id else None

    @classmethod
    async def record_forward(
        cls,
        db: AsyncSession,
        *,
        user_id,
        context_id: str | None,
        resource: str,
        action: str,
        target_refs: list[dict],
        before_state: dict,
        after_state: dict,
        base_versions: dict,
        artifact_refs: dict | None = None,
        group_id: str | None = None,
    ) -> UndoOperation | None:
        context_id = cls._context(context_id)
        if context_id is None:
            return None

        # 新正向操作会截断同一标签页中已经撤回的 redo 分支。
        await db.execute(
            update(UndoOperation)
            .where(
                UndoOperation.user_id == user_id,
                UndoOperation.undo_context_id == context_id,
                UndoOperation.actor_type == "web",
                UndoOperation.status == "undone",
            )
            .values(status="expired", failure_code="redo_cleared_by_new_operation")
        )
        operation = UndoOperation(
            id=cls.new_id("op"),
            user_id=user_id,
            undo_context_id=context_id,
            group_id=group_id or cls.new_id("group"),
            resource=resource,
            action=action,
            target_refs=deepcopy(target_refs),
            before_state=deepcopy(before_state),
            after_state=deepcopy(after_state),
            base_versions=deepcopy(base_versions),
            artifact_refs=deepcopy(artifact_refs or {}),
            actor_type="web",
            status="active",
            created_at=now_utc(),
            expires_at=now_utc() + cls.RETENTION,
        )
        db.add(operation)
        await db.flush()
        return operation

    @classmethod
    async def attach_calendar_create_task(
        cls, db: AsyncSession, *, user_id, context_id: str | None, event_id: int, task
    ) -> None:
        """把事件创建后紧随其后的提醒并入同一个撤回组。

        日历表单先创建事件，再逐条创建提醒；提醒不是独立的用户意图，不能让
        Ctrl/Command+Z 只撤回最后一条提醒。仅允许绑定当前上下文中最近的事件创建
        操作，其他定时任务和 Agent/IM 写入不会进入 Web 撤回栈。
        """
        context_id = cls._context(context_id)
        if context_id is None:
            return
        operation = (await db.execute(
            select(UndoOperation)
            .where(
                UndoOperation.user_id == user_id,
                UndoOperation.undo_context_id == context_id,
                UndoOperation.actor_type == "web",
                UndoOperation.resource == "calendar",
                UndoOperation.action == "create",
                UndoOperation.status == "active",
            )
            .order_by(UndoOperation.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()
        if operation is None:
            return
        event_ref = f"event:{event_id}"
        state = deepcopy(operation.after_state or {})
        items = state.setdefault("items", {})
        if event_ref not in items:
            return
        task_ref = f"task:{task.id}"
        if task_ref in items:
            return
        from app.services.undo.domains import task_snapshot
        items[task_ref] = task_snapshot(task)
        operation.after_state = state
        operation.target_refs = [*(operation.target_refs or []), {"kind": "task", "id": task.id}]
        base_versions = deepcopy(operation.base_versions or {})
        base_versions[task_ref] = {"version": 0}
        operation.base_versions = base_versions
        await db.flush()

    @classmethod
    async def preview(cls, db: AsyncSession, *, user_id, context_id: str | None) -> dict:
        context_id = cls._context(context_id)
        if context_id is None:
            return {"available": False, "redo_available": False, "undo": None, "redo": None}
        active = (await db.execute(
            select(UndoOperation)
            .where(
                UndoOperation.user_id == user_id,
                UndoOperation.undo_context_id == context_id,
                UndoOperation.actor_type == "web",
                UndoOperation.status == "active",
            )
            .order_by(UndoOperation.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()
        undone = (await db.execute(
            select(UndoOperation)
            .where(
                UndoOperation.user_id == user_id,
                UndoOperation.undo_context_id == context_id,
                UndoOperation.actor_type == "web",
                UndoOperation.status == "undone",
            )
            .order_by(UndoOperation.undone_at.desc(), UndoOperation.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()
        return {
            "available": active is not None,
            "redo_available": undone is not None,
            "undo": cls._shape(active) if active else None,
            "redo": cls._shape(undone) if undone else None,
        }

    @classmethod
    async def cleanup_expired(cls, db: AsyncSession, *, storage=None, now=None, limit: int = 100) -> dict:
        """清理到期操作及正文 artifact；失败对象保留到下一轮重试。"""
        now = now or now_utc()
        query = (
            select(UndoOperation)
            .where(
                or_(
                    and_(
                        UndoOperation.expires_at.is_not(None),
                        UndoOperation.expires_at <= now,
                        UndoOperation.status != "expired",
                    ),
                    # 新正向操作清空 redo 分支时，记录已提前标记 expired；其
                    # artifact 仍需由本次维护循环回收一次，之后改成终态码避免重复扫描。
                    and_(
                        UndoOperation.status == "expired",
                        UndoOperation.failure_code == "redo_cleared_by_new_operation",
                    ),
                ),
            )
            .order_by(UndoOperation.expires_at.asc())
            .limit(max(1, min(limit, 500)))
        )
        rows = (await db.execute(query)).scalars().all()
        if not rows:
            return {"expired": 0, "artifacts": 0, "failed": 0}
        if storage is None:
            from app.services.storage import get_storage
            storage = get_storage()
        expired = artifacts = failed = 0
        for operation in rows:
            try:
                if operation.artifact_refs:
                    prefix = f"{operation.user_id}/.undo/{operation.id}/"
                    artifacts += await storage.delete_prefix(prefix)
                operation.status = "expired"
                operation.failure_code = (
                    "redo_artifacts_cleaned"
                    if operation.failure_code == "redo_cleared_by_new_operation"
                    else operation.failure_code or "retention_expired"
                )
                operation.artifact_refs = {}
                expired += 1
            except Exception:
                # 存储失败时不标记为已清理，让下一次周期继续重试，避免丢失恢复对象。
                failed += 1
        await db.flush()
        return {"expired": expired, "artifacts": artifacts, "failed": failed}

    @staticmethod
    def _shape(operation: UndoOperation) -> dict:
        count = len(operation.target_refs or [])
        return {
            "operation_id": operation.id,
            "group_id": operation.group_id,
            "resource": operation.resource,
            "action": operation.action,
            "target_count": count,
            "summary": f"{operation.action} {count} 个对象",
            "created_at": operation.created_at.isoformat(),
            "status": operation.status,
            "can_undo": operation.status == "active",
            "can_redo": operation.status == "undone",
        }

    @classmethod
    async def apply(
        cls,
        db: AsyncSession,
        *,
        user_id,
        context_id: str | None,
        operation_id: str,
        mode: str,
    ) -> dict:
        context_id = cls._context(context_id)
        operation = (await db.execute(
            select(UndoOperation).where(
                UndoOperation.id == operation_id,
                UndoOperation.user_id == user_id,
                UndoOperation.undo_context_id == context_id,
                UndoOperation.actor_type == "web",
            )
        )).scalar_one_or_none()
        if operation is None:
            raise UndoNotFound()

        if operation.expires_at and operation.expires_at <= now_utc():
            operation.status = "expired"
            operation.failure_code = "retention_expired"
            await db.flush()
            raise UndoError("undo.expired", "撤销操作已超过保留期限")

        expected = "active" if mode == "undo" else "undone"
        if operation.status != expected:
            if (mode == "undo" and operation.status == "undone") or (mode == "redo" and operation.status == "active"):
                return {"operation": cls._shape(operation), "idempotent": True, "events": []}
            raise UndoError("undo.already_processed", "撤销操作已经处理、冲突或过期")

        if operation.resource not in {"files", "projects", "calendar", "mind"}:
            raise UndoError("undo.unsupported", "该资源尚未接入统一撤销适配器")

        if operation.resource == "files":
            from app.services.undo.files import FileUndoAdapter
            adapter = FileUndoAdapter(db)
        elif operation.resource == "mind":
            from app.services.undo.mind import MindUndoAdapter
            adapter = MindUndoAdapter(db)
        else:
            from app.services.undo.domains import DomainUndoAdapter
            adapter = DomainUndoAdapter(db)
        try:
            result = await (adapter.undo(operation, user_id) if mode == "undo" else adapter.redo(operation, user_id))
        except UndoError as error:
            operation.status = "conflicted" if error.code == "undo.conflict" else "failed"
            operation.failure_code = error.code
            raise

        operation.status = "undone" if mode == "undo" else "active"
        operation.undone_at = now_utc() if mode == "undo" else None
        operation.failure_code = None
        if mode == "undo":
            state = deepcopy(operation.after_state or {})
            state["undo_versions"] = result.get("versions", {})
            operation.after_state = state
        await db.flush()
        result_events = result.get("events", [])
        if not result_events and result.get("event"):
            result_events = [result["event"]]
        return {"operation": cls._shape(operation), "idempotent": False, "events": result_events}
