"""文件库 keyset 分页契约：有界、稳定，并拒绝跨筛选/用户复用游标。"""

from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.v1 import files as files_api
from app.api.v1 import folders as folders_api
from app.api.v1 import trash as trash_api
from app.models import File, Folder, MindMap, Project


async def _add_files(db, user, names):
    rows = [File(
        user_id=user.id,
        display_name=name,
        ext="TXT",
        space="personal",
        storage_key=f"{user.id}/{name}",
        size_bytes=1,
    ) for name in names]
    db.add_all(rows)
    await db.commit()
    return rows


async def test_file_pages_are_stable_and_cursor_is_bound_to_scope(db, user_a, user_b):
    await _add_files(db, user_a, ["alpha", "bravo", "charlie", "delta", "echo"])
    await _add_files(db, user_b, ["other-user"])

    first = await files_api.list_file_page(
        limit=2, cursor=None, sort_by="name", sort_order="asc", space="personal",
        project_id=None, folder_id=None, workspace_directory_id=None, mind_map_id=None,
        ext=None, q=None, current_user=user_a, db=db,
    )
    second = await files_api.list_file_page(
        limit=2, cursor=first["next_cursor"], sort_by="name", sort_order="asc", space="personal",
        project_id=None, folder_id=None, workspace_directory_id=None, mind_map_id=None,
        ext=None, q=None, current_user=user_a, db=db,
    )
    third = await files_api.list_file_page(
        limit=2, cursor=second["next_cursor"], sort_by="name", sort_order="asc", space="personal",
        project_id=None, folder_id=None, workspace_directory_id=None, mind_map_id=None,
        ext=None, q=None, current_user=user_a, db=db,
    )

    titles = [item.display_name for page in (first, second, third) for item in page["items"]]
    assert titles == ["alpha", "bravo", "charlie", "delta", "echo"]
    assert first["has_more"] and second["has_more"] and not third["has_more"]
    assert all(len(page["items"]) <= 2 for page in (first, second, third))

    with pytest.raises(HTTPException) as error:
        await files_api.list_file_page(
            limit=2, cursor=first["next_cursor"], sort_by="name", sort_order="asc", space="workspace",
            project_id=None, folder_id=None, workspace_directory_id=None, mind_map_id=None,
            ext=None, q=None, current_user=user_a, db=db,
        )
    assert error.value.status_code == 422

    with pytest.raises(HTTPException) as other_user_error:
        await files_api.list_file_page(
            limit=2, cursor=first["next_cursor"], sort_by="name", sort_order="asc", space="personal",
            project_id=None, folder_id=None, workspace_directory_id=None, mind_map_id=None,
            ext=None, q=None, current_user=user_b, db=db,
        )
    assert other_user_error.value.status_code == 422


async def test_stage_sort_requires_a_bounded_scope_and_keeps_project_order_stable(db, user_a):
    project = Project(user_id=user_a.id, name="项目阶段排序", start_date="2026-10-01")
    db.add(project)
    await db.flush()
    rows = [File(
        user_id=user_a.id, display_name=name, ext="TXT", space="project",
        project_id=project.id, storage_key=f"{user_a.id}/{name}", size_bytes=1,
    ) for name in ("first", "second")]
    db.add_all(rows)
    await db.commit()

    with pytest.raises(HTTPException) as unbounded_stage:
        await files_api.list_file_page(
            limit=2, cursor=None, sort_by="stage", sort_order="asc", space=None,
            project_id=None, folder_id=None, workspace_directory_id=None, mind_map_id=None,
            ext=None, q=None, current_user=user_a, db=db,
        )
    assert unbounded_stage.value.status_code == 422

    page = await files_api.list_file_page(
        limit=1, cursor=None, sort_by="stage", sort_order="asc", space="project",
        project_id=project.id, folder_id=None, workspace_directory_id=None, mind_map_id=None,
        ext=None, q=None, current_user=user_a, db=db,
    )
    next_page = await files_api.list_file_page(
        limit=1, cursor=page["next_cursor"], sort_by="stage", sort_order="asc", space="project",
        project_id=project.id, folder_id=None, workspace_directory_id=None, mind_map_id=None,
        ext=None, q=None, current_user=user_a, db=db,
    )
    assert [item.id for item in (*page["items"], *next_page["items"])] == sorted(row.id for row in rows)


async def test_folder_pages_are_limited_and_reject_tampered_cursor(db, user_a):
    folders = [Folder(user_id=user_a.id, name=f"Folder {index}") for index in range(5)]
    db.add_all(folders)
    await db.commit()

    first = await folders_api.list_folder_page(
        project_id=None, workspace_directory_id=None, parent_id=None,
        limit=2, cursor=None, sort_by="name", sort_order="asc", current_user=user_a, db=db,
    )
    second = await folders_api.list_folder_page(
        project_id=None, workspace_directory_id=None, parent_id=None,
        limit=2, cursor=first["next_cursor"], sort_by="name", sort_order="asc", current_user=user_a, db=db,
    )

    assert [item.name for page in (first, second) for item in page["items"]] == [
        "Folder 0", "Folder 1", "Folder 2", "Folder 3",
    ]
    assert first["has_more"] and second["has_more"]
    assert len(first["items"]) == len(second["items"]) == 2

    fallback_page = await folders_api.list_folder_page(
        project_id=None, workspace_directory_id=None, parent_id=None,
        limit=5, cursor=None, sort_by="createdAt", sort_order="desc", current_user=user_a, db=db,
    )
    assert [item.id for item in fallback_page["items"]] == sorted(
        (folder.id for folder in folders), reverse=True,
    )

    tampered = "not-a-valid-cursor"
    with pytest.raises(HTTPException) as error:
        await folders_api.list_folder_page(
            project_id=None, workspace_directory_id=None, parent_id=None,
            limit=2, cursor=tampered, sort_by="name", sort_order="asc", current_user=user_a, db=db,
        )
    assert error.value.status_code == 422


async def test_file_name_cursor_uses_id_to_keep_equal_names_complete(db, user_a):
    rows = [File(
        user_id=user_a.id, display_name="duplicate", ext="TXT", space="personal",
        storage_key=f"{user_a.id}/duplicate-{index}", size_bytes=1,
    ) for index in range(3)]
    db.add_all(rows)
    await db.commit()

    first = await files_api.list_file_page(
        limit=1, cursor=None, sort_by="name", sort_order="asc", space="personal",
        project_id=None, folder_id=None, workspace_directory_id=None, mind_map_id=None,
        ext=None, q=None, current_user=user_a, db=db,
    )
    second = await files_api.list_file_page(
        limit=1, cursor=first["next_cursor"], sort_by="name", sort_order="asc", space="personal",
        project_id=None, folder_id=None, workspace_directory_id=None, mind_map_id=None,
        ext=None, q=None, current_user=user_a, db=db,
    )
    third = await files_api.list_file_page(
        limit=1, cursor=second["next_cursor"], sort_by="name", sort_order="asc", space="personal",
        project_id=None, folder_id=None, workspace_directory_id=None, mind_map_id=None,
        ext=None, q=None, current_user=user_a, db=db,
    )

    ids = [item.id for page in (first, second, third) for item in page["items"]]
    assert ids == sorted(row.id for row in rows)
    assert first["has_more"] and second["has_more"] and not third["has_more"]


async def test_trash_file_and_folder_pages_have_independent_signed_cursors(db, user_a):
    deleted_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    deleted_files = [File(
        user_id=user_a.id, display_name=f"deleted-{index}", ext="TXT", space="personal",
        storage_key=f"{user_a.id}/deleted-{index}", size_bytes=1, deleted_at=deleted_at,
    ) for index in range(5)]
    deleted_folders = [Folder(
        user_id=user_a.id, name=f"deleted-folder-{index}", deleted_at=deleted_at,
    ) for index in range(5)]
    db.add_all([*deleted_files, *deleted_folders])
    await db.commit()

    first_files = await trash_api.list_trash_page(
        limit=2, cursor=None, current_user=user_a, db=db,
    )
    second_files = await trash_api.list_trash_page(
        limit=2, cursor=first_files["next_cursor"], current_user=user_a, db=db,
    )
    first_folders = await trash_api.list_trash_folders_page(
        limit=2, cursor=None, current_user=user_a, db=db,
    )
    second_folders = await trash_api.list_trash_folders_page(
        limit=2, cursor=first_folders["next_cursor"], current_user=user_a, db=db,
    )

    assert len(first_files["items"]) == len(second_files["items"]) == 2
    assert len(first_folders["items"]) == len(second_folders["items"]) == 2
    assert len({item.id for page in (first_files, second_files) for item in page["items"]}) == 4
    assert len({item.id for page in (first_folders, second_folders) for item in page["items"]}) == 4


async def test_deleted_folder_contents_pages_files_and_folders_separately(db, user_a):
    deleted_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    root = Folder(user_id=user_a.id, name="deleted-root", deleted_at=deleted_at)
    db.add(root)
    await db.flush()
    db.add_all([
        Folder(user_id=user_a.id, name=f"child-{index}", parent_id=root.id, deleted_at=deleted_at)
        for index in range(3)
    ])
    db.add_all([
        File(
            user_id=user_a.id, display_name=f"inside-{index}", ext="TXT", space="personal",
            storage_key=f"{user_a.id}/inside-{index}", size_bytes=1, folder_id=root.id,
            deleted_at=deleted_at,
        ) for index in range(3)
    ])
    await db.commit()

    first = await trash_api.list_trash_folder_contents_page(
        fid=root.id, limit=2, folder_cursor=None, file_cursor=None, current_user=user_a, db=db,
    )
    second = await trash_api.list_trash_folder_contents_page(
        fid=root.id, limit=2,
        folder_cursor=first["folders"]["next_cursor"],
        file_cursor=first["files"]["next_cursor"], current_user=user_a, db=db,
    )
    assert len(first["folders"]["items"]) == 2
    assert len(first["files"]["items"]) == 2
    assert len(second["folders"]["items"]) == 1
    assert len(second["files"]["items"]) == 1


async def test_file_and_folder_locations_load_only_owned_scope_ancestors(db, user_a, user_b):
    root = Folder(user_id=user_a.id, name="root")
    db.add(root)
    await db.flush()
    child = Folder(user_id=user_a.id, name="child", parent_id=root.id)
    db.add(child)
    await db.flush()
    file = File(
        user_id=user_a.id, display_name="target", ext="TXT", space="personal",
        storage_key=f"{user_a.id}/target", size_bytes=1, folder_id=child.id,
    )
    db.add(file)
    await db.commit()

    file_location = await files_api.get_file_location(file.id, current_user=user_a, db=db)
    folder_location = await folders_api.get_folder_location(child.id, current_user=user_a, db=db)
    assert [item.id for item in file_location.folder_path] == [root.id, child.id]
    assert folder_location.folder.id == child.id
    assert [item.id for item in folder_location.ancestors] == [root.id]

    with pytest.raises(HTTPException) as cross_user:
        await files_api.get_file_location(file.id, current_user=user_b, db=db)
    assert cross_user.value.status_code == 404


async def test_relative_path_resolution_stays_inside_source_scope(db, user_a):
    root = Folder(user_id=user_a.id, name="docs")
    db.add(root)
    await db.flush()
    notes = Folder(user_id=user_a.id, name="notes", parent_id=root.id)
    assets = Folder(user_id=user_a.id, name="assets", parent_id=root.id)
    db.add_all([notes, assets])
    await db.flush()
    source = File(
        user_id=user_a.id, display_name="source", ext="MD", space="personal",
        storage_key=f"{user_a.id}/source", size_bytes=10, folder_id=notes.id,
    )
    target = File(
        user_id=user_a.id, display_name="song", ext="MP3", space="personal",
        storage_key=f"{user_a.id}/song", size_bytes=10, folder_id=assets.id,
    )
    db.add_all([source, target])
    await db.commit()

    results = await files_api.resolve_file_paths(
        source.id,
        files_api.ResolveFilePathsRequest(paths=[
            "../assets/song.mp3", "../../../../escape.txt", "/absolute.txt", "https://example.invalid/file.txt",
        ]),
        current_user=user_a,
        db=db,
    )
    assert results[0].file is not None and results[0].file.id == target.id
    assert [item.file for item in results[1:]] == [None, None, None]


async def test_relative_path_resolution_does_not_cross_mind_map_scope(db, user_a):
    source_map = MindMap(user_id=user_a.id, title="source")
    other_map = MindMap(user_id=user_a.id, title="other")
    db.add_all([source_map, other_map])
    await db.flush()
    source = File(
        user_id=user_a.id, display_name="source", ext="MD", space="mind",
        mind_map_id=source_map.id, storage_key=f"{user_a.id}/source-map-source", size_bytes=1,
    )
    other_map_file = File(
        user_id=user_a.id, display_name="target", ext="TXT", space="mind",
        mind_map_id=other_map.id, storage_key=f"{user_a.id}/other-map-target", size_bytes=1,
    )
    db.add_all([source, other_map_file])
    await db.commit()

    results = await files_api.resolve_file_paths(
        source.id,
        files_api.ResolveFilePathsRequest(paths=["target.txt"]),
        current_user=user_a,
        db=db,
    )

    assert results[0].file is None


def test_relative_path_request_has_a_hard_total_segment_bound():
    with pytest.raises(ValidationError):
        files_api.ResolveFilePathsRequest(paths=["/".join(["nested"] * 65)])

    with pytest.raises(ValidationError):
        files_api.ResolveFilePathsRequest(paths=["%2F".join(["nested"] * 65)])

    with pytest.raises(ValidationError):
        files_api.ResolveFilePathsRequest(paths=["/".join(["nested"] * 33)] * 8)
