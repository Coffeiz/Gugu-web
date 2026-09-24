"""@ 引用上下文：文件块必须带 id 与所在目录，咕咕才能直接定位文件而非按名搜索。"""
from __future__ import annotations

import pytest

from agent.context.references import build_reference_context
from app.models import File, Folder, MindNode


@pytest.fixture
async def folder_with_file(db, user_a):
    folder = Folder(user_id=user_a.id, name="插画参考")
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    file = File(
        user_id=user_a.id,
        display_name="ZenlessZoneZero Screenshot 2024.07.08 - 11.00.27.87",
        ext="png",
        space="personal",
        folder_id=folder.id,
        storage_key="personal/test/screenshot.png",
        mime_type="image/png",
    )
    db.add(file)
    await db.commit()
    await db.refresh(file)
    return folder, file


async def test_file_reference_includes_id_and_folder_path(db, user_a, folder_with_file):
    folder, file = folder_with_file
    context = await build_reference_context(
        db, user_a.id, [{"type": "file", "id": file.id, "label": file.display_name}],
    )
    assert f"文件 id：{file.id}" in context
    assert "目录：插画参考（folder_id=" in context
    assert f"folder_id={folder.id}" in context
    assert ".png" in context


async def test_file_reference_without_folder_reports_space_root(db, user_a):
    file = File(
        user_id=user_a.id, display_name="loose", ext="txt",
        space="personal", folder_id=None, storage_key="personal/loose.txt",
        mime_type="text/plain",
    )
    db.add(file)
    await db.commit()
    await db.refresh(file)
    context = await build_reference_context(
        db, user_a.id, [{"type": "file", "id": file.id, "label": "loose"}],
    )
    assert f"文件 id：{file.id}" in context
    assert "空间根目录" in context


async def test_canvas_note_reference_includes_owned_note_content(db, user_a):
    note = MindNode(
        user_id=user_a.id, kind="canvas_note", title="调度逻辑",
        content_md="worker.py 负责消费队列", content_plain="worker.py 负责消费队列",
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)

    context = await build_reference_context(
        db, user_a.id, [{"type": "canvas_note", "id": note.id, "label": note.title}],
    )

    assert "[画布便签]" in context
    assert f"便签 id：{note.id}" in context
    assert "worker.py 负责消费队列" in context


async def test_deleted_file_reference_is_ignored(db, user_a, folder_with_file):
    from datetime import timedelta

    _folder, file = folder_with_file
    file.deleted_at = file.created_at + timedelta(minutes=1)
    await db.commit()
    context = await build_reference_context(
        db, user_a.id, [{"type": "file", "id": file.id, "label": "gone"}],
    )
    assert context == ""


async def test_other_users_file_reference_is_ignored(db, user_a, user_b, folder_with_file):
    _folder, file = folder_with_file
    context = await build_reference_context(
        db, user_b.id, [{"type": "file", "id": file.id, "label": "stolen"}],
    )
    assert context == ""


async def test_folder_reference_lists_path_and_contents(db, user_a, folder_with_file):
    folder, _file = folder_with_file
    context = await build_reference_context(db, user_a.id, [{"type": "folder", "id": folder.id}])
    assert "[文件夹]" in context
    assert f"目录 id：{folder.id}" in context
    assert "插画参考" in context
    assert "内含文件：ZenlessZoneZero" in context


async def test_folder_reference_cross_user_ignored(db, user_a, user_b):
    other = Folder(user_id=user_b.id, name="别人的目录")
    db.add(other)
    await db.flush()
    context = await build_reference_context(db, user_a.id, [{"type": "folder", "id": other.id}])
    assert context == ""
