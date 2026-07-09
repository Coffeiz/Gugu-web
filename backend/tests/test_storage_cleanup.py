"""存储层按前缀清除（账户注销用，P0-5）——LocalStorageBackend 行为契约。

- 清 A 用户前缀：A 的全部对象（含 .agent/ 记忆、.voice/、上传文件）删净、返回数量；
- B 用户的数据必须原封不动（注销不能误伤别人）；
- 防呆：空/根/越界前缀必须抛 ValueError（绝不允许清掉整个存储）。
OSS 后端同一接口契约，逻辑走 ObjectIterator+batch_delete，不在此测（需真 bucket）。
"""
import pytest

from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path):
    return LocalStorageBackend(tmp_path)


async def _seed(storage, uid: str):
    await storage.put(f"{uid}/.agent/facts.json", b"{}")
    await storage.put(f"{uid}/.agent/memory.md", b"m")
    await storage.put(f"{uid}/.voice/a.mp3", b"v")
    await storage.put(f"{uid}/项目文件/2026/07/项目 #1/doc.md", b"d")


async def test_delete_prefix_removes_all_user_objects(storage):
    await _seed(storage, "user-a")
    n = await storage.delete_prefix("user-a/")
    assert n == 4
    assert not await storage.exists("user-a/.agent/facts.json")
    assert await storage.list_keys() == []


async def test_delete_prefix_spares_other_users(storage):
    await _seed(storage, "user-a")
    await _seed(storage, "user-b")
    await storage.delete_prefix("user-a/")
    keys = await storage.list_keys()
    assert len(keys) == 4 and all(k.startswith("user-b/") for k in keys)


async def test_delete_prefix_missing_is_zero(storage):
    assert await storage.delete_prefix("nobody/") == 0


async def test_delete_prefix_rejects_empty_and_root(storage):
    for bad in ("", "/", " ", "./", "//"):
        with pytest.raises(ValueError):
            await storage.delete_prefix(bad)


async def test_delete_prefix_rejects_traversal(storage):
    await _seed(storage, "user-a")
    with pytest.raises(ValueError):
        await storage.delete_prefix("../")
