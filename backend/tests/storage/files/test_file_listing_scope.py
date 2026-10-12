from app.core.tz import now_utc
from app.models import File, Folder, WorkspaceDirectory
from app.services.files.browser import list_file_page_rows


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

    root_page = await list_file_page_rows(
        db, user_a.id, limit=10, cursor=None, sort_by="createdAt", sort_order="desc",
        space="workspace", workspace_directory_id=workspace.id,
    )
    folder_page = await list_file_page_rows(
        db, user_a.id, limit=10, cursor=None, sort_by="createdAt", sort_order="desc",
        space="workspace", workspace_directory_id=workspace.id, folder_id=folder.id,
    )

    assert {row[0].display_name for row in root_page["items"]} == {"工作区根文件"}
    assert {row[0].display_name for row in folder_page["items"]} == {"子目录文件"}
