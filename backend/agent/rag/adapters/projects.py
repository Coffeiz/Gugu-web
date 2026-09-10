"""Project Knowledge 来源 adapter。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select

from agent.rag.models import IndexDocument, Scope
from app.models import Project


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


class ProjectAdapter:
    """只暴露当前用户自己的项目摘要，不读取项目文件正文。"""

    source_type = "project"

    def __init__(self, user_id: object, *, db=None, db_factory=None):
        self.user_id = user_id
        self._db = db
        self._db_factory = db_factory

    async def build_documents(self, *, scope: Scope) -> list[IndexDocument]:
        from agent.rag.index_builder import records_to_write_documents

        records = await self.build_source_records(scope=scope)
        return await records_to_write_documents(self.user_id, self.source_type, records)

    async def build_source_records(self, *, scope: Scope) -> list[tuple[dict, Scope]]:
        """构建未切块的 canonical Project record，由 TS 负责投影。"""
        if scope.owner_user_id != str(self.user_id) or scope.scope_type != "owner":
            return []
        if self._db is not None:
            return await self._records_from_db(self._db, scope)
        if self._db_factory is not None:
            async with self._db_factory() as db:
                return await self._records_from_db(db, scope)
        import app.db.session as db_session

        if db_session._engine is None:
            db_session._build_engine()
        async with db_session._SessionLocal() as db:
            return await self._records_from_db(db, scope)

    async def _records_from_db(self, db, scope: Scope) -> list[tuple[dict, Scope]]:
        rows = (await db.execute(
            select(Project)
            .where(Project.user_id == self.user_id, Project.deleted_at.is_(None), Project.archived == False)
            .order_by(Project.updated_at.desc(), Project.id.desc())
        )).scalars().all()
        records = []
        for project in rows:
            text = self._project_text(project)
            if not text.strip():
                continue
            document_id = f"project:{project.id}"
            records.append(({
                "source_type": "project", "id": str(project.id),
                "source_id": str(project.id), "parent_id": document_id,
                "title": project.name or "未命名项目", "summary": text[:240],
                "content": text, "version_parts": [project.id, project.version or 1],
                "updated_at": _iso(project.updated_at),
                "metadata": {"project_id": str(project.id), "status": project.status or "pending"},
            }, scope))
        return records

    @staticmethod
    def _project_text(project) -> str:
        """只拼接用于检索的项目事实，避免把业务 JSON 原样送进索引。"""
        lines = [f"项目：{project.name or '未命名项目'}"]
        if project.client:
            lines.append(f"客户：{project.client}")
        if project.status:
            lines.append(f"状态：{project.status}")
        if project.priority:
            lines.append(f"优先级：{project.priority}")
        if project.progress is not None:
            lines.append(f"进度：{project.progress}%")
        if project.current_stage:
            lines.append(f"当前阶段：{project.current_stage}")
        if project.start_date:
            lines.append(f"开始日期：{project.start_date}")
        if project.deadline:
            lines.append(f"截止日期：{project.deadline}")
        stages = [str(item.get("name") or "") for item in (project.stages or []) if isinstance(item, dict)]
        if stages:
            lines.append("阶段：" + "、".join(item for item in stages if item))
        return "\n".join(lines)


__all__ = ["ProjectAdapter"]
