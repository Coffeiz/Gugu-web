from app.core.tz import now_utc
from app.models import File, Folder, WorkspaceDirectory
from app.services.files.browser import get_file_tree_rows, list_file_rows


async def test_workspace_listing_returns_only_live_files_from_the_requested_root_and_folder(db, user_a):
    workspace = WorkspaceDirectory(
        user_id=user_a.id, name="测试工作区", directory_name="test-workspace",
    )
    other_workspace = WorkspaceDirectory(
        user_id=user_a.id, name="另一个工作区", directory_name="other-workspace",
    )
    folder = Folder(
        user_id=user_a.id, name="子目录", workspace_directory=workspace,
    )
    db.add_all([workspace, other_workspace, folder])
    await db.flush()

    db.add_all([
        File(
            user_id=user_a.id, display_name="工作区根文件", ext="TXT", space="workspace",
            workspace_directory=workspace, storage_key="workspace/root.txt",
        ),
        File(
            user_id=user_a.id, display_name="子目录文件", ext="TXT", space="workspace",
            workspace_directory=workspace, folder=folder, storage_key="workspace/child.txt",
        ),
        File(
            user_id=user_a.id, display_name="其他工作区文件", ext="TXT", space="workspace",
            workspace_directory=other_workspace, storage_key="other-workspace/root.txt",
        ),
        File(
            user_id=user_a.id, display_name="已删除文件", ext="TXT", space="workspace",
            workspace_directory=workspace, storage_key="workspace/deleted.txt",
            deleted_at=now_utc(),
        ),
    ])
    await db.flush()

    root_rows = await list_file_rows(
        db, user_a.id, space="workspace", workspace_directory_id=workspace.id,
    )
    folder_rows = await list_file_rows(
        db, user_a.id, space="workspace", workspace_directory_id=workspace.id,
        folder_id=folder.id,
    )

    assert {row[0].display_name for row in root_rows} == {"工作区根文件"}
    assert {row[0].display_name for row in folder_rows} == {"子目录文件"}


async def test_file_tree_summary_counts_only_personal_root_files_and_folders(db, user_a):
    root_folder = Folder(user_id=user_a.id, name="根目录文件夹")
    db.add(root_folder)
    await db.flush()
    nested_folder = Folder(user_id=user_a.id, name="子目录", parent_id=root_folder.id)
    db.add(nested_folder)
    await db.flush()
    db.add_all([
        File(
            user_id=user_a.id, display_name="根文件", ext="TXT", space="personal",
            storage_key=f"{user_a.id}/personal/root.txt",
        ),
        File(
            user_id=user_a.id, display_name="深层文件", ext="TXT", space="personal",
            folder_id=nested_folder.id, storage_key=f"{user_a.id}/personal/nested.txt",
        ),
        File(
            user_id=user_a.id, display_name="项目文件", ext="TXT", space="project",
            storage_key=f"{user_a.id}/project/root.txt",
        ),
    ])
    await db.commit()

    summary = await get_file_tree_rows(db, user_a.id)

    # 根目录卡片以“直属文件 + 直属文件夹”为口径，不累加深层文件或项目文件。
    assert summary[3] == 2
