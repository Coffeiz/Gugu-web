"""保护 Agent 文件概览在根目录数量增加时不产生逐目录数据库查询。"""

from sqlalchemy import event

from agent.context.loaders import load_files_overview
from app.models import Folder, WorkspaceDirectory


async def test_personal_root_folder_query_count_stays_bounded(db, user_a):
    db.add(Folder(user_id=user_a.id, name="个人根目录一"))
    await db.flush()

    statements = []

    bind = db.sync_session.get_bind()
    listener = lambda _conn, _cursor, statement, *_rest: (
        statements.append(statement)
        if statement.lstrip().upper().startswith("SELECT") else None
    )
    event.listen(bind, "before_cursor_execute", listener)
    try:
        first = await load_files_overview(db, user_a.id)
        first_query_count = len(statements)

        workspace = WorkspaceDirectory(
            user_id=user_a.id,
            name="测试工作区",
            directory_name="test-workspace",
        )
        db.add(workspace)
        await db.flush()
        db.add_all([
            Folder(user_id=user_a.id, name=f"个人根目录{index}")
            for index in range(2, 12)
        ])
        db.add(Folder(
            user_id=user_a.id,
            name="工作区根目录",
            workspace_directory_id=workspace.id,
        ))
        await db.flush()

        before_second_load = len(statements)
        many = await load_files_overview(db, user_a.id)
        second_query_count = len(statements) - before_second_load
    finally:
        event.remove(bind, "before_cursor_execute", listener)

    assert first_query_count == second_query_count
    assert [folder["path"] for folder in first["folders"]] == ["个人根目录一"]
    assert {folder["path"] for folder in many["folders"]} == {
        "个人根目录一",
        *(f"个人根目录{index}" for index in range(2, 12)),
    }
    assert "工作区根目录" not in {folder["path"] for folder in many["folders"]}
