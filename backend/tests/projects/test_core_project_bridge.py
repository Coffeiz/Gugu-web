"""Web 兼容接入与独立 Core 映射必须读写同一项目数据。"""
from sqlalchemy import select

from app.core.projects import build_project, update_project_atomic
from app.models import Project
from app.services.projects import list_project_rows
from gugu_core.application.projects import ProjectService
from gugu_core.data.models import LocalProject
from gugu_core.data.projects import SqlProjectRepository


async def test_web_and_core_share_rows_aliases_versions_and_ownership(db, user_a, user_b):
    web_row = build_project(user_a.id, {"name": "Web 创建", "client": "合成客户"})
    db.add(web_row)
    await db.commit()
    core = ProjectService(SqlProjectRepository(db, user_a.id))
    rows = await core.list()
    assert [(row.id, row.client) for row in rows] == [(web_row.id, "合成客户")]

    changed = await core.update(web_row.id, 1, {"name": "Core 改名"})
    await db.commit()
    await db.refresh(web_row)
    assert (web_row.name, web_row.version) == ("Core 改名", changed.version)
    assert await update_project_atomic(db, web_row.id, user_a.id, 1, {"name": "过期改名"}) is False
    assert await update_project_atomic(db, web_row.id, user_b.id, 2, {"name": "越权改名"}) is False
    assert await list_project_rows(db, user_b.id, archived=False) == []
    assert [row.name for row in await list_project_rows(db, user_a.id, archived=False)] == ["Core 改名"]


async def test_shared_repository_never_commits_web_transaction(db, user_a):
    service = ProjectService(SqlProjectRepository(db, user_a.id, model=Project))
    created = await service.create({"name": "待回滚项目"})
    assert created.id is not None
    await db.rollback()
    assert (await db.execute(select(Project))).scalars().all() == []


def test_web_project_schema_preserves_core_columns_and_user_foreign_key():
    # 列名、类型和可空性是持久化兼容契约，不能在两个宿主中各自演化。
    def columns(model):
        return {column.name: (str(column.type), column.nullable) for column in model.__table__.columns}

    assert columns(Project) == columns(LocalProject)
    assert {foreign_key.target_fullname for foreign_key in Project.__table__.c.user_id.foreign_keys} == {"users.id"}
    assert not LocalProject.__table__.c.user_id.foreign_keys
