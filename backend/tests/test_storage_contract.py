"""P0.6 StorageBackend 契约测试 —— 任何后端实现都必须满足的字节层行为。

现在只跑 `LocalStorageBackend`；**OSS 到来时**把它加进 `BACKENDS` 参数化即可跑同一套向量
（迁移信心的地基）。契约按当前接口（put/get/delete/rename_file/exists/list_keys/delete_prefix）；
copy/stat/文件夹钩子在 P1 加入后扩这里。
"""
import pytest

from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path):
    # 未来：@pytest.fixture(params=[local_factory, oss_factory]) 跑同一套
    return LocalStorageBackend(tmp_path)


async def test_put_get_roundtrip(storage):
    await storage.put("u/a/doc.txt", b"hello")
    assert await storage.get("u/a/doc.txt") == b"hello"


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
