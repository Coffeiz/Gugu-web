"""独立数据库 Session 交错写入时，各资源的旧版本写入必须失败。"""
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.mind import update_node_atomic
from app.core.projects import build_project, update_project_atomic
from app.models import File, Folder, MindNode, Project
from app.services.canvas.service import update_canvas_note
from app.services.storage.file_service.files import advance_file_version_atomic
from app.services.storage.folder_tree import SqlAlchemyFolderTree
from app.core.errors import Conflict


@pytest.mark.asyncio
async def test_project_stale_session_cannot_overwrite_committed_update(db, user_a):
    project = build_project(user_a.id, {"name": "原项目"})
    db.add(project)
    await db.commit()
    project_id = project.id

    async with AsyncSession(bind=db.bind, expire_on_commit=False) as other:
        row = await other.get(Project, project_id)
        assert await update_project_atomic(other, project_id, user_a.id, row.version, {"name": "新标题"}, row)
        await other.commit()

    assert not await update_project_atomic(db, project_id, user_a.id, 1, {"name": "旧草稿"}, project)
    await db.refresh(project)
    assert (project.name, project.version) == ("新标题", 2)


@pytest.mark.asyncio
async def test_mind_note_stale_session_cannot_overwrite_committed_update(db, user_a):
    note = MindNode(user_id=user_a.id, kind="note", title="原笔记", content_md="原文", content_plain="原文")
    db.add(note)
    await db.commit()
    note_id = note.id

    async with AsyncSession(bind=db.bind, expire_on_commit=False) as other:
        assert await update_node_atomic(other, note_id, user_a.id, 1, {"title": "新标题"})
        await other.commit()

    assert not await update_node_atomic(db, note_id, user_a.id, 1, {"title": "旧草稿"})
    await db.refresh(note)
    assert (note.title, note.version) == ("新标题", 2)


@pytest.mark.asyncio
async def test_canvas_note_stale_session_cannot_overwrite_committed_update(db, user_a):
    note = MindNode(user_id=user_a.id, kind="canvas_note", title="原便签", content_md="原文", content_plain="原文")
    db.add(note)
    await db.commit()
    note_id = note.id

    async with AsyncSession(bind=db.bind, expire_on_commit=False) as other:
        updated = await update_canvas_note(other, user_a.id, note_id, 1, {"title": "新标题"})
        assert updated is not False
        await other.commit()

    assert await update_canvas_note(db, user_a.id, note_id, 1, {"title": "旧草稿"}) is False
    await db.refresh(note)
    assert (note.title, note.version) == ("新标题", 2)


@pytest.mark.asyncio
async def test_folder_stale_session_cannot_rename_committed_update(db, user_a):
    tree = SqlAlchemyFolderTree(db)
    folder = await tree.create(user_a.id, name="原目录", parent_id=None, project_id=None)
    await db.commit()
    folder_id = folder.id

    async with AsyncSession(bind=db.bind, expire_on_commit=False) as other:
        updated = await SqlAlchemyFolderTree(other).rename(user_a.id, folder_id, "新目录", client_version=1)
        assert updated.version == 2
        await other.commit()

    with pytest.raises(Conflict):
        await tree.rename(user_a.id, folder_id, "旧草稿", client_version=1)
    await db.refresh(folder)
    assert (folder.name, folder.version) == ("新目录", 2)


@pytest.mark.asyncio
async def test_file_stale_session_cannot_claim_same_write_version(db, user_a):
    file = File(user_id=user_a.id, display_name="资料", ext="txt", space="personal", storage_key=f"{user_a.id}/资料.txt")
    db.add(file)
    await db.commit()
    file_id = file.id

    async with AsyncSession(bind=db.bind, expire_on_commit=False) as other:
        assert await advance_file_version_atomic(other, user_id=user_a.id, file_id=file_id, client_version=1)
        await other.commit()

    assert not await advance_file_version_atomic(db, user_id=user_a.id, file_id=file_id, client_version=1)
    await db.refresh(file)
    assert file.version == 2
