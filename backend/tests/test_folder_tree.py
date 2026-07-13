"""P0.2 SqlAlchemyFolderTree —— 领域层行为契约，与现 app/api/v1/folders.py 逐字等价。"""
import pytest

from app.core.errors import Conflict, Invalid, NotFound
from app.models import Project
from app.services.storage.folder_tree import SqlAlchemyFolderTree


async def test_create_personal_and_get(db, user_a):
    t = SqlAlchemyFolderTree(db)
    f = await t.create(user_a.id, name="资料", parent_id=None, project_id=None)
    await db.commit()
    assert f.id and f.name == "资料" and f.project_id is None and f.parent_id is None
    assert (await t.get(user_a.id, f.id)).id == f.id


async def test_create_duplicate_conflict(db, user_a):
    t = SqlAlchemyFolderTree(db)
    await t.create(user_a.id, name="dup", parent_id=None, project_id=None)
    await db.commit()
    with pytest.raises(Conflict):
        await t.create(user_a.id, name="dup", parent_id=None, project_id=None)


async def test_create_project_not_found(db, user_a):
    t = SqlAlchemyFolderTree(db)
    with pytest.raises(NotFound):
        await t.create(user_a.id, name="x", parent_id=None, project_id=999)


async def test_create_in_owned_project(db, user_a):
    p = Project(user_id=user_a.id, name="P")
    db.add(p); await db.commit(); await db.refresh(p)
    t = SqlAlchemyFolderTree(db)
    f = await t.create(user_a.id, name="设计", parent_id=None, project_id=p.id)
    await db.commit()
    assert f.project_id == p.id


async def test_get_other_user_none(db, user_a, user_b):
    t = SqlAlchemyFolderTree(db)
    f = await t.create(user_a.id, name="a", parent_id=None, project_id=None)
    await db.commit()
    assert await t.get(user_b.id, f.id) is None


async def test_resolve_folder_path_nested(db, user_a):
    t = SqlAlchemyFolderTree(db)
    root = await t.create(user_a.id, name="设计", parent_id=None, project_id=None); await db.flush()
    child = await t.create(user_a.id, name="评审", parent_id=root.id, project_id=None); await db.commit()
    assert await t.resolve_folder_path(user_a.id, child.id) == "设计/评审"
    assert await t.resolve_folder_path(user_a.id, root.id) == "设计"
    assert await t.resolve_folder_path(user_a.id, 999) is None


async def test_descendants(db, user_a):
    t = SqlAlchemyFolderTree(db)
    a = await t.create(user_a.id, name="a", parent_id=None, project_id=None); await db.flush()
    b = await t.create(user_a.id, name="b", parent_id=a.id, project_id=None); await db.flush()
    c = await t.create(user_a.id, name="c", parent_id=b.id, project_id=None); await db.commit()
    assert set(await t.descendants(user_a.id, a.id)) == {a.id, b.id, c.id}


async def test_get_children_root(db, user_a):
    t = SqlAlchemyFolderTree(db)
    await t.create(user_a.id, name="x", parent_id=None, project_id=None)
    await t.create(user_a.id, name="y", parent_id=None, project_id=None)
    await db.commit()
    kids = await t.get_children(user_a.id, project_id=None, parent_id=None)
    assert {f.name for f in kids} == {"x", "y"}


async def test_rename(db, user_a):
    t = SqlAlchemyFolderTree(db)
    f = await t.create(user_a.id, name="old", parent_id=None, project_id=None); await db.commit()
    r = await t.rename(user_a.id, f.id, "new"); await db.commit()
    assert r.name == "new"


async def test_rename_not_found(db, user_a):
    t = SqlAlchemyFolderTree(db)
    with pytest.raises(NotFound):
        await t.rename(user_a.id, 999, "x")


async def test_move_ok_and_cycle(db, user_a):
    t = SqlAlchemyFolderTree(db)
    a = await t.create(user_a.id, name="a", parent_id=None, project_id=None); await db.flush()
    b = await t.create(user_a.id, name="b", parent_id=a.id, project_id=None); await db.flush()
    c = await t.create(user_a.id, name="c", parent_id=None, project_id=None); await db.commit()
    moved = await t.move(user_a.id, a.id, c.id); await db.commit()
    assert moved.parent_id == c.id
    with pytest.raises(Invalid):                 # a 移进其子孙 b → 循环
        await t.move(user_a.id, a.id, b.id)


async def test_move_cross_space_invalid(db, user_a):
    p = Project(user_id=user_a.id, name="P")
    db.add(p); await db.commit(); await db.refresh(p)
    t = SqlAlchemyFolderTree(db)
    personal = await t.create(user_a.id, name="pf", parent_id=None, project_id=None); await db.flush()
    proj_folder = await t.create(user_a.id, name="jf", parent_id=None, project_id=p.id); await db.commit()
    with pytest.raises(Invalid):
        await t.move(user_a.id, personal.id, proj_folder.id)


async def test_move_target_not_found(db, user_a):
    t = SqlAlchemyFolderTree(db)
    f = await t.create(user_a.id, name="f", parent_id=None, project_id=None); await db.commit()
    with pytest.raises(NotFound):
        await t.move(user_a.id, f.id, 999)
