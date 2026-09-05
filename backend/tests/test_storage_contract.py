"""P0.6 StorageBackend 契约测试 —— 任何后端实现都必须满足的字节层行为。

现在只跑 `LocalStorageBackend`；**OSS 到来时**把它加进 `BACKENDS` 参数化即可跑同一套向量
（迁移信心的地基）。契约按当前接口（put/get/delete/rename_file/exists/list_keys/delete_prefix）；
copy/stat/文件夹钩子在 P1 加入后扩这里。
"""
import os
import stat

import pytest

from app.services import storage as storage_module
from app.services.storage import LocalStorageBackend
from app.services.storage.trash import to_trash_key


@pytest.fixture
def storage(tmp_path):
    # 未来：@pytest.fixture(params=[local_factory, oss_factory]) 跑同一套
    return LocalStorageBackend(tmp_path)


async def test_put_get_roundtrip(storage):
    await storage.put("u/a/doc.txt", b"hello")
    assert await storage.get("u/a/doc.txt") == b"hello"


async def test_failed_replace_keeps_previous_file(tmp_path, monkeypatch):
    """覆盖写被中断时不能留下空文件或半截内容。"""
    storage = LocalStorageBackend(tmp_path)
    await storage.put("u/.agent/pattern.json", b"old")

    def fail_replace(_temporary, _target):
        raise OSError("模拟原子替换失败")

    monkeypatch.setattr(storage_module.os, "replace", fail_replace)

    with pytest.raises(OSError):
        await storage.put("u/.agent/pattern.json", b"new")

    assert await storage.get("u/.agent/pattern.json") == b"old"
    assert not list((tmp_path / "u/.agent").glob(".*.tmp"))


async def test_put_preserves_existing_file_metadata(tmp_path):
    """原子替换不能把已有文件的 owner/mode 换成临时文件的元数据。"""
    storage = LocalStorageBackend(tmp_path)
    await storage.put("u/workspace/doc.txt", b"old")
    path = tmp_path / "u/workspace/doc.txt"
    os.chmod(path, 0o640)
    before = os.stat(path, follow_symlinks=False)

    await storage.put("u/workspace/doc.txt", b"new")

    after = os.stat(path, follow_symlinks=False)
    assert stat.S_IMODE(after.st_mode) == stat.S_IMODE(before.st_mode)
    assert (after.st_uid, after.st_gid) == (before.st_uid, before.st_gid)
    assert await storage.get("u/workspace/doc.txt") == b"new"


async def test_put_new_file_uses_shared_mode(tmp_path):
    storage = LocalStorageBackend(tmp_path)

    await storage.put("u/workspace/new.txt", b"new")

    assert stat.S_IMODE(os.stat(tmp_path / "u/workspace/new.txt").st_mode) == 0o660


async def test_exists(storage):
    assert await storage.exists("u/a/x.txt") is False
    await storage.put("u/a/x.txt", b"1")
    assert await storage.exists("u/a/x.txt") is True


async def test_delete(storage):
    await storage.put("u/a/x.txt", b"1")
    await storage.delete("u/a/x.txt")
    assert await storage.exists("u/a/x.txt") is False
    # 删不存在的 key 不报错（幂等）
    await storage.delete("u/a/nope.txt")


async def test_rename_file(storage):
    await storage.put("u/a/old.txt", b"data")
    await storage.rename_file("u/a/old.txt", "u/b/new.txt")
    assert await storage.exists("u/a/old.txt") is False
    assert await storage.get("u/b/new.txt") == b"data"


async def test_local_trash_hooks_move_and_restore(storage):
    await storage.put("u/a/doc.txt", b"data")
    assert await storage.move_to_trash("u/a/doc.txt", "u/trash/1/doc.txt") == "u/trash/1/doc.txt"
    assert await storage.exists("u/a/doc.txt") is False
    assert await storage.restore_from_trash("u/trash/1/doc.txt", "u/a/doc.txt") == "u/a/doc.txt"
    assert await storage.get("u/a/doc.txt") == b"data"


def test_trash_key_uses_display_name():
    assert (
        to_trash_key(7, "7/个人文件/测试/原文件.bin", "会议/方案", "MD")
        == "7/trash/测试/会议_方案.md"
    )


async def test_list_keys(storage):
    await storage.put("u/a/1.txt", b"1")
    await storage.put("u/a/2.txt", b"2")
    keys = set(await storage.list_keys())
    assert {"u/a/1.txt", "u/a/2.txt"} <= keys


async def test_delete_prefix_scoped(storage):
    await storage.put("user-a/x.txt", b"1")
    await storage.put("user-b/y.txt", b"2")
    n = await storage.delete_prefix("user-a/")
    assert n == 1
    assert await storage.exists("user-a/x.txt") is False
    assert await storage.exists("user-b/y.txt") is True


async def test_delete_prefix_rejects_root(storage):
    with pytest.raises(ValueError):
        await storage.delete_prefix("")     # 防误清整个存储


# ── P1.1 copy / stat（共享契约：Local 与未来 OSS 都要过）───────────────────────

async def test_copy(storage):
    await storage.put("u/a/src.txt", b"payload")
    await storage.copy("u/a/src.txt", "u/b/dst.txt")
    assert await storage.get("u/a/src.txt") == b"payload"   # 源仍在
    assert await storage.get("u/b/dst.txt") == b"payload"


async def test_stat(storage):
    assert await storage.stat("u/a/missing.txt") is None
    await storage.put("u/a/x.txt", b"12345")
    info = await storage.stat("u/a/x.txt")
    assert info is not None and info.size == 5


# ── P1.1 文件夹生命周期钩子（Local 真实目录语义；OSS 侧 no-op，无可断言）──────────

async def test_ensure_folder_materializes_empty_dir(storage):
    await storage.ensure_folder("u/个人文件/空夹")
    assert (storage.root / "u/个人文件/空夹").is_dir()   # 空文件夹上盘（治 123）


async def test_remove_empty_ancestors_prunes(storage):
    await storage.put("u/个人文件/深/更深/f.txt", b"1")
    await storage.delete("u/个人文件/深/更深/f.txt")
    await storage.remove_empty_ancestors("u/个人文件/深/更深/f.txt")
    assert not (storage.root / "u/个人文件/深").exists()   # 变空的祖先被清


async def test_remove_folder_empty_only(storage):
    await storage.ensure_folder("u/个人文件/orphan/sub")
    await storage.remove_folder("u/个人文件/orphan")
    assert not (storage.root / "u/个人文件/orphan").exists()   # 无文件 → 清掉（治 adr）
    # 有文件时保守不删
    await storage.put("u/个人文件/keep/f.txt", b"1")
    await storage.remove_folder("u/个人文件/keep")
    assert (storage.root / "u/个人文件/keep/f.txt").is_file()


async def test_move_folder(storage):
    await storage.ensure_folder("u/个人文件/旧名")
    await storage.move_folder("u/个人文件/旧名", "u/个人文件/新名")
    assert (storage.root / "u/个人文件/新名").is_dir()
    assert not (storage.root / "u/个人文件/旧名").exists()
