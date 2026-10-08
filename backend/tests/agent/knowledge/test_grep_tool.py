"""grep 与 read_file 行范围读取的回归测试。"""

import asyncio
import threading
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import File, Folder, Project, WorkspaceDirectory
from app.services.storage import LocalStorageBackend
from app.services.storage.file_service import FileService


async def _wire_storage(monkeypatch, root):
    storage = LocalStorageBackend(root)
    monkeypatch.setattr("agent.tools.files.get_storage", lambda: storage)
    monkeypatch.setattr("agent.tools.files.grep.get_storage", lambda: storage)
    return storage


async def _create_file(db, user_id, storage, *, name, content, space="personal", project_id=None,
                       folder_id=None, workspace_directory_id=None):
    result = await FileService(db, storage=storage).create_file(
        user_id,
        space=space,
        project_id=project_id,
        folder_id=folder_id,
        workspace_directory_id=workspace_directory_id,
        stage_name="",
        mind_map_id=None,
        display_name=name.rsplit(".", 1)[0],
        ext=name.rsplit(".", 1)[1],
        mime_type="text/plain",
        data=content.encode("utf-8"),
    )
    await db.commit()
    return result.file


async def test_read_file_can_return_a_fixed_physical_line_range(db, user_a, tmp_path, monkeypatch):
    storage = await _wire_storage(monkeypatch, tmp_path)
    file = await _create_file(
        db,
        user_a.id,
        storage,
        name="range.txt",
        content="一\n二\n三\n四\n五\n",
    )

    import agent.tools.files as agent_files

    result = await agent_files._read_file(
        db,
        user_a.id,
        {"file_id": file.id, "target_lines": "2-4"},
    )

    assert result["content"] == "二\n三\n四\n"
    assert result["numbered_content"] == "2: 二\n3: 三\n4: 四"
    assert result["line_range"] == {"start": 2, "end": 4}


async def test_local_storage_reads_do_not_block_the_event_loop(tmp_path, monkeypatch):
    storage = LocalStorageBackend(tmp_path)
    await storage.put("probe.txt", b"probe", "text/plain")
    read_bytes = Path.read_bytes
    entered = threading.Event()
    release = threading.Event()

    def slow_read(path):
        entered.set()
        release.wait(timeout=1)
        return read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", slow_read)
    release_timer = threading.Timer(0.2, release.set)
    release_timer.start()
    read_task = asyncio.create_task(storage.get("probe.txt"))
    try:
        await asyncio.wait_for(asyncio.to_thread(entered.wait, 0.5), timeout=1)
        assert not read_task.done()
    finally:
        release.set()
        release_timer.cancel()

    assert await read_task == b"probe"


async def test_grep_returns_matches_with_requested_context(db, user_a, tmp_path, monkeypatch):
    storage = await _wire_storage(monkeypatch, tmp_path)
    file = await _create_file(
        db,
        user_a.id,
        storage,
        name="search.txt",
        content="前置\n上一行\n目标内容\n下一行\n末尾\n",
    )

    from agent.tools.files.grep import _grep_files

    result = await _grep_files(db, user_a.id, {
        "query": "目标",
        "context_lines": 1,
        "limit": 10,
    })

    assert result["success"] is True
    assert result["total_matches"] == 1
    assert result["matched_files"] == 1
    assert result["results"][0]["file_id"] == file.id
    assert result["results"][0]["matches"] == [{
        "line": 3,
        "text": "目标内容",
        "context": [
            {"line": 2, "text": "上一行"},
            {"line": 3, "text": "目标内容"},
            {"line": 4, "text": "下一行"},
        ],
    }]


async def test_grep_can_search_personal_project_and_workspace_files(db, user_a, tmp_path, monkeypatch):
    storage = await _wire_storage(monkeypatch, tmp_path)
    project = Project(user_id=user_a.id, name="检索项目", start_date="2026-01-02")
    workspace = WorkspaceDirectory(
        user_id=user_a.id,
        name="检索工作区",
        directory_name="workspace-grep",
    )
    db.add_all([project, workspace])
    await db.commit()
    await db.refresh(project)
    await db.refresh(workspace)
    await _create_file(db, user_a.id, storage, name="personal.txt", content="needle")
    await _create_file(
        db,
        user_a.id,
        storage,
        name="project.txt",
        content="needle",
        space="project",
        project_id=project.id,
    )
    await _create_file(
        db,
        user_a.id,
        storage,
        name="workspace.txt",
        content="needle",
        space="workspace",
        workspace_directory_id=workspace.id,
    )

    from agent.tools.files.grep import _grep_files

    result = await _grep_files(db, user_a.id, {"query": "needle", "context_lines": 0})

    assert result["matched_files"] == 3
    assert {item["space"] for item in result["results"]} == {"personal", "project", "workspace"}
    assert all(item["matches"][0]["line"] == 1 for item in result["results"])


async def test_grep_does_not_inherit_bound_workspace_scope(db, user_a, tmp_path, monkeypatch):
    storage = await _wire_storage(monkeypatch, tmp_path)
    workspace = WorkspaceDirectory(
        user_id=user_a.id, name="检索工作区", directory_name="workspace-bound",
    )
    db.add(workspace)
    await db.commit()
    await db.refresh(workspace)
    await _create_file(db, user_a.id, storage, name="personal.txt", content="已看电影")
    await _create_file(
        db,
        user_a.id,
        storage,
        name="workspace.txt",
        content="已看工作记录",
        space="workspace",
        workspace_directory_id=workspace.id,
    )

    import agent.tools.files as agent_files

    async def bound_workspace(*_args, **_kwargs):
        return {
            "space": "workspace",
            "project_id": None,
            "folder_id": None,
            "workspace_directory_id": workspace.id,
        }

    monkeypatch.setattr(agent_files, "_bound_workspace_target", bound_workspace)

    from agent.tools.files.grep import _grep_files

    result = await _grep_files(db, user_a.id, {"query": "已看", "context_lines": 0})

    assert result["matched_files"] == 2


async def test_grep_path_limits_results_to_requested_personal_folder(db, user_a, tmp_path, monkeypatch):
    storage = await _wire_storage(monkeypatch, tmp_path)
    folder = await FileService(db, storage=storage).create_folder(
        user_a.id, name="F1", parent_id=None, project_id=None,
    )
    await db.commit()
    await _create_file(
        db,
        user_a.id,
        storage,
        name="inside.txt",
        content="needle",
        folder_id=folder.id,
    )
    await _create_file(db, user_a.id, storage, name="outside.txt", content="needle")

    from agent.tools.files.grep import _grep_files

    result = await _grep_files(db, user_a.id, {
        "query": "needle",
        "path": "/personal/F1",
        "context_lines": 0,
    })

    assert result["matched_files"] == 1
    assert result["results"][0]["path"] == "/personal/F1/inside.txt"


async def test_grep_isolates_other_users_and_skips_binary_files(db, user_a, user_b, tmp_path, monkeypatch):
    storage = await _wire_storage(monkeypatch, tmp_path)
    await _create_file(db, user_b.id, storage, name="secret.txt", content="needle")
    binary = File(
        user_id=user_a.id,
        display_name="binary",
        ext="bin",
        mime_type="application/octet-stream",
        storage_key="binary-key",
        size_bytes=6,
        size="6 B",
    )
    db.add(binary)
    await db.commit()
    await storage.put(binary.storage_key, b"needle\x00", binary.mime_type)

    from agent.tools.files.grep import _grep_files

    result = await _grep_files(db, user_a.id, {"query": "needle", "context_lines": 0})

    assert result["matched_files"] == 0
    assert result["total_matches"] == 0
    assert result["skipped_files"] == 1


async def test_grep_bulk_resolves_folder_paths_instead_of_querying_per_file(
    db, user_a, tmp_path, monkeypatch,
):
    storage = await _wire_storage(monkeypatch, tmp_path)
    folders = [
        Folder(user_id=user_a.id, name=f"folder-{index}")
        for index in range(6)
    ]
    db.add_all(folders)
    await db.commit()
    for index, folder in enumerate(folders):
        await _create_file(
            db,
            user_a.id,
            storage,
            name=f"file-{index}.txt",
            content="needle",
            folder_id=folder.id,
        )
    folder_selects = 0

    def count_folder_selects(_conn, _cursor, statement, _parameters, _context, _many):
        nonlocal folder_selects
        normalized = statement.lower().replace('"', "").replace("`", "")
        if normalized.lstrip().startswith("select") and "from folders" in normalized:
            folder_selects += 1

    event.listen(db.bind.sync_engine, "before_cursor_execute", count_folder_selects)
    try:
        from agent.tools.files.grep import _grep_files

        async with AsyncSession(db.bind) as request_db:
            result = await _grep_files(
                request_db, user_a.id, {"query": "needle", "context_lines": 0},
            )
    finally:
        event.remove(db.bind.sync_engine, "before_cursor_execute", count_folder_selects)

    assert result["matched_files"] == 6
    assert {item["path"] for item in result["results"]} == {
        f"/personal/folder-{index}/file-{index}.txt" for index in range(6)
    }
    assert folder_selects <= 2


async def test_grep_reads_files_with_bounded_concurrency_and_keeps_candidate_order(
    db, user_a, tmp_path, monkeypatch,
):
    storage = await _wire_storage(monkeypatch, tmp_path)
    files = []
    for index in range(6):
        files.append(await _create_file(
            db,
            user_a.id,
            storage,
            name=f"ordered-{index}.txt",
            content="needle",
        ))
        files[-1].updated_at = files[-1].updated_at.replace(day=index + 1)
    await db.commit()

    active_reads = 0
    max_active_reads = 0
    original_get = storage.get

    async def delayed_get(key):
        nonlocal active_reads, max_active_reads
        active_reads += 1
        max_active_reads = max(max_active_reads, active_reads)
        try:
            await asyncio.sleep(0.01)
            return await original_get(key)
        finally:
            active_reads -= 1

    monkeypatch.setattr(storage, "get", delayed_get)

    from agent.tools.files.grep import _grep_files

    result = await _grep_files(db, user_a.id, {"query": "needle", "context_lines": 0, "limit": 20})

    assert result["total_matches"] == 6
    assert max_active_reads > 1
    assert max_active_reads <= 8
    assert [item["file_id"] for item in result["results"]] == [
        file.id for file in reversed(files)
    ]

    limited = await _grep_files(
        db, user_a.id, {"query": "needle", "context_lines": 0, "limit": 1},
    )
    assert limited["total_matches"] == 1
    assert [item["file_id"] for item in limited["results"]] == [files[-1].id]
