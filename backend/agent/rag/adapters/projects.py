"""Project Knowledge 来源 adapter。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select

from agent.rag.chunking import split_text, text_version
from agent.rag.models import IndexDocument, Scope
from app.models import Project


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


class ProjectAdapter:
    """只暴露当前用户自己的项目摘要，不读取项目文件正文。"""

    source_type = "project"

    def __init__(self, user_id: object, *, db=None):
        self.user_id = user_id
        self._db = db

    async def build_documents(self, *, scope: Scope) -> list[IndexDocument]:
        if scope.owner_user_id != str(self.user_id) or scope.scope_type != "owner":
            return []
        if self._db is not None:
            return await self._build_from_db(self._db, scope)

        import app.db.session as db_session

        if db_session._engine is None:
            db_session._build_engine()
        async with db_session._SessionLocal() as db:
            return await self._build_from_db(db, scope)

    async def _build_from_db(self, db, scope: Scope) -> list[IndexDocument]:
        rows = (await db.execute(
            select(Project)
            .where(Project.user_id == self.user_id, Project.archived == False)
            .order_by(Project.updated_at.desc(), Project.id.desc())
        )).scalars().all()
        documents: list[IndexDocument] = []
        for project in rows:
            text = self._project_text(project)
            pieces = split_text(text, max_chars=1400)
            if not pieces:
                continue
            document_id = f"project:{project.id}"
            version = text_version(text, project.id, project.version or 1)
            for position, piece in enumerate(pieces):
                documents.append(IndexDocument(
                    document_id=document_id,
                    parent_document_id=document_id,
                    source_type=self.source_type,
                    source_id=str(project.id),
                    scope=scope,
                    title=project.name or "未命名项目",
                    summary=text[:240],
                    content=piece,
                    version=version,
                    chunk_index=position,
                    chunk_count=len(pieces),
                    updated_at=_iso(project.updated_at),
                    metadata={"project_id": str(project.id), "status": project.status or "pending"},
                ))
        return documents

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
