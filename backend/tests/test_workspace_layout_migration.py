import pytest

from app.models import File, WorkspaceDirectory
from scripts.migrations.migrate_workspace_layout import migrate


@pytest.mark.asyncio
async def test_all_users_files_and_keys_move_without_copying_and_retry(db, user_a, user_b, tmp_path):
    """默认与命名目录整体迁移，登记文件更新 key，未登记文件及 inode 保留。"""
    entries = []
    for user in (user_a, user_b):
        for name, old, default in [("默认工作区", "workspace", True), ("QQ", "QQ", False)]:
            directory = WorkspaceDirectory(user_id=user.id, name=name, directory_name=old, is_default=default)
            db.add(directory)
            await db.flush()
            parent = tmp_path / str(user.id) / old
            parent.mkdir(parents=True)
            (parent / "未登记.txt").write_bytes(b"preserved")
            (parent / "登记.txt").write_bytes(b"registered")
            file = File(user_id=user.id, display_name="登记", ext="txt", space="workspace",
                        workspace_directory_id=directory.id, storage_key=f"{user.id}/{old}/登记.txt")
            db.add(file)
            entries.append((directory, file, (parent / "未登记.txt").stat().st_ino))
    await db.commit()
    assert (await migrate(db, tmp_path, apply=False))["status"] == "preview"
    assert not (tmp_path / ".workspace-layout-v2.json").exists()
    assert (await migrate(db, tmp_path, apply=True))["status"] == "completed"
    for directory, file, inode in entries:
        segment = "default" if directory.is_default else "qq"
        assert directory.directory_name == segment
        parent = tmp_path / str(directory.user_id) / "workspace" / segment
        assert (parent / "未登记.txt").read_bytes() == b"preserved"
        assert (parent / "未登记.txt").stat().st_ino == inode
        assert (tmp_path / file.storage_key).read_bytes() == b"registered"
    assert (await migrate(db, tmp_path, apply=True))["status"] == "already_completed"
    assert len(list(tmp_path.glob(".workspace-layout-v2-backup-*.json"))) == 1


@pytest.mark.asyncio
async def test_conflict_aborts_before_any_files_move(db, user_a, tmp_path):
    """目标冲突在预检拒绝，不覆盖、不移动源目录。"""
    root = tmp_path / str(user_a.id) / "workspace"
    (root / "default").mkdir(parents=True)
    (root / "原文件.txt").write_bytes(b"original")
    with pytest.raises(ValueError, match="目标已存在"):
        await migrate(db, tmp_path, apply=True)
    assert (root / "原文件.txt").read_bytes() == b"original"
    assert not (tmp_path / ".workspace-layout-v2.json").exists()


@pytest.mark.asyncio
async def test_interrupted_move_resumes_from_journal(db, user_a, tmp_path, monkeypatch):
    """移动后提交前中断，续跑恢复元数据，不再次嵌套 default。"""
    from scripts.migrations import migrate_workspace_layout as migration
    root = tmp_path / str(user_a.id) / "workspace"
    root.mkdir(parents=True)
    (root / "内容.txt").write_bytes(b"content")
    row = WorkspaceDirectory(user_id=user_a.id, name="默认工作区", directory_name="workspace", is_default=True)
    db.add(row)
    await db.commit()
    normal = migration.execute_moves

    def interrupt(root, journal, checkpoint):
        normal(root, journal, checkpoint)
        raise RuntimeError("合成中断")

    monkeypatch.setattr(migration, "execute_moves", interrupt)
    with pytest.raises(RuntimeError, match="合成中断"):
        await migrate(db, tmp_path, apply=True)
    monkeypatch.setattr(migration, "execute_moves", normal)
    assert (await migrate(db, tmp_path, apply=True))["status"] == "completed"
    assert (root / "default" / "内容.txt").read_bytes() == b"content"
    assert row.directory_name == "default"


@pytest.mark.asyncio
async def test_resume_after_rename_before_checkpoint(db, user_a, tmp_path, monkeypatch):
    """改名已落盘但检查点未写入时，按 inode 识别原目录并续跑。"""
    from scripts.migrations import migrate_workspace_layout as migration
    root = tmp_path / str(user_a.id) / "workspace"
    root.mkdir(parents=True)
    (root / "保留.txt").write_bytes(b"keep")
    normal = migration.save_journal
    calls = 0

    def interrupted(path, journal):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise RuntimeError("检查点中断")
        normal(path, journal)

    monkeypatch.setattr(migration, "save_journal", interrupted)
    with pytest.raises(RuntimeError, match="检查点中断"):
        await migrate(db, tmp_path, apply=True)
    monkeypatch.setattr(migration, "save_journal", normal)
    assert (await migrate(db, tmp_path, apply=True))["status"] == "completed"
    assert (root / "default" / "保留.txt").read_bytes() == b"keep"


@pytest.mark.asyncio
async def test_symlink_root_is_rejected_without_following(db, user_a, tmp_path):
    """不能借工作区符号链接移动别处的数据。"""
    outside = tmp_path / "outside"
    outside.mkdir()
    user_root = tmp_path / str(user_a.id)
    user_root.mkdir()
    (user_root / "workspace").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="符号链接"):
        await migrate(db, tmp_path, apply=True)
    assert outside.is_dir()
    assert not (tmp_path / ".workspace-layout-v2.json").exists()


@pytest.mark.asyncio
async def test_trash_restore_uses_stable_workspace_segment(db, user_a):
    """工作区改显示名后，还原仍回到冻结的物理段，而不是旧顶层目录。"""
    from app.services.storage.trash import original_storage_key
    row = WorkspaceDirectory(user_id=user_a.id, name="改名后的工作区", directory_name="qq")
    db.add(row)
    await db.flush()
    file = File(user_id=user_a.id, display_name="笔记", ext="txt", space="workspace",
                workspace_directory_id=row.id, storage_key=f"{user_a.id}/trash/qq/笔记.txt")
    assert await original_storage_key(file, db) == f"{user_a.id}/workspace/qq/笔记.txt"
