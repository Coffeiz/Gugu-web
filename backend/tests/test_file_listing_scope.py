from sqlalchemy.dialects import sqlite

from app.models import File, Folder
from app.services.files.browser import file_listing_query, get_file_tree_rows


def test_workspace_root_listing_excludes_nested_files():
    statement = file_listing_query(
        7, space="workspace", workspace_directory_id=12,
    )

    sql = str(statement.compile(dialect=sqlite.dialect()))
    assert "files.folder_id IS NULL" in sql
    assert "files.workspace_directory_id = ?" in sql


def test_workspace_folder_listing_keeps_exact_folder_scope():
    statement = file_listing_query(
        7, space="workspace", workspace_directory_id=12, folder_id=34,
    )

    sql = str(statement.compile(dialect=sqlite.dialect()))
    assert "files.folder_id = ?" in sql
    assert "files.folder_id IS NULL" not in sql


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
