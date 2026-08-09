"""视频转码结果缓存（PRD-STORAGE-1 Phase B，`chat_attach._compress_video_cached()`
+ `app/core/video_cache_gc.py`）。

覆盖：cache_key 随 storage_key/转码 profile 变化、alive marker 用 SET 而不是
EXPIRE（Redis 丢失后仍能自愈）、marker 缺失但缓存文件还在时自动重建、并发
single-flight 去重、清理任务尊重 alive marker。
"""
import asyncio
from types import SimpleNamespace

import pytest

from app.core import chat_attach, video_cache_gc
from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: backend)
    monkeypatch.setattr(chat_attach, "get_storage", lambda: backend)
    return backend


class _FakeLock:
    def __init__(self, real_lock: asyncio.Lock):
        self._lock = real_lock

    async def acquire(self, blocking=True, blocking_timeout=None):
        await self._lock.acquire()
        return True

    async def release(self):
        self._lock.release()


class _FakeRedis:
    """内存字典 + 真 asyncio.Lock，足够验证 SET-not-EXPIRE 语义和 single-flight
    互斥（两个"并发"协程真的会在同一把锁上排队，不是摆设）。"""

    def __init__(self):
        self.store: dict[str, str] = {}
        self.set_calls: list[str] = []
        self.expire_calls: list[str] = []
        self._locks: dict[str, asyncio.Lock] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value
        self.set_calls.append(key)

    async def expire(self, key, ttl):
        self.expire_calls.append(key)
        # 真实 Redis 语义：EXPIRE 对不存在的 key 是空操作，不会创建它
        if key not in self.store:
            return
        # 存在的话保留原值，这里只是记录调用，不需要真的模拟 TTL 倒计时

    def lock(self, key, timeout=None, blocking=None):
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return _FakeLock(self._locks[key])


MODEL_CFG = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic",
                            model="MiniMax-M3", vision_video=True)


def _probe():
    return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 60.0}


@pytest.mark.asyncio
async def test_cache_hit_skips_transcode(storage, monkeypatch):
    fake_redis = _FakeRedis()
    monkeypatch.setattr(chat_attach, "get_redis", lambda: fake_redis)
    call_count = 0

    async def fake_compress(raw, probe=None):
        nonlocal call_count
        call_count += 1
        return b"compressed-bytes"

    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)

    storage_key, user_id = "u1/lib/video.mp4", "u1"
    raw = b"raw-video"
    probe = _probe()

    first = await chat_attach._compress_video_cached(raw, probe, storage_key, user_id, MODEL_CFG)
    assert first == b"compressed-bytes"
    assert call_count == 1

    second = await chat_attach._compress_video_cached(raw, probe, storage_key, user_id, MODEL_CFG)
    assert second == b"compressed-bytes"
    assert call_count == 1, "第二次应该命中缓存，不再调用 _compress_video"


@pytest.mark.asyncio
async def test_cache_key_changes_with_storage_key(storage, monkeypatch):
    fake_redis = _FakeRedis()
    monkeypatch.setattr(chat_attach, "get_redis", lambda: fake_redis)
    call_count = 0

    async def fake_compress(raw, probe=None):
        nonlocal call_count
        call_count += 1
        return b"compressed-bytes"

    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)

    await chat_attach._compress_video_cached(b"raw", _probe(), "u1/lib/a.mp4", "u1", MODEL_CFG)
    await chat_attach._compress_video_cached(b"raw", _probe(), "u1/lib/b.mp4", "u1", MODEL_CFG)

    assert call_count == 2, "不同 storage_key 不该复用同一份缓存"


@pytest.mark.asyncio
async def test_cache_key_changes_with_transcode_profile(storage, monkeypatch):
    """同一个 storage_key，但 model_cfg 对应的转码 profile 不同（这里换一个不是
    MiniMax M3 的 model_cfg，_video_transcode_profile 里 minimax 字段会不同）——
    不应该命中同一份缓存。"""
    fake_redis = _FakeRedis()
    monkeypatch.setattr(chat_attach, "get_redis", lambda: fake_redis)
    call_count = 0

    async def fake_compress(raw, probe=None):
        nonlocal call_count
        call_count += 1
        return b"compressed-bytes"

    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)
    monkeypatch.setattr(chat_attach, "_minimax_video_enabled", lambda cfg: cfg is MODEL_CFG)

    other_cfg = SimpleNamespace(provider="mimo", base_url="https://api.xiaomimimo.com/v1", model="mimo-vl")

    await chat_attach._compress_video_cached(b"raw", _probe(), "u1/lib/a.mp4", "u1", MODEL_CFG)
    await chat_attach._compress_video_cached(b"raw", _probe(), "u1/lib/a.mp4", "u1", other_cfg)

    assert call_count == 2, "转码 profile 不同不该命中同一份缓存"


@pytest.mark.asyncio
async def test_no_cache_without_storage_key_or_user_id(storage, monkeypatch):
    """聊天附件路径（不传 storage_key/user_id）应该完全不接缓存，每次都真转码，
    行为跟没有缓存机制时一致（不误伤现有聊天附件视频路径）。"""
    fake_redis = _FakeRedis()
    monkeypatch.setattr(chat_attach, "get_redis", lambda: fake_redis)
    call_count = 0

    async def fake_compress(raw, probe=None):
        nonlocal call_count
        call_count += 1
        return b"compressed-bytes"

    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)

    await chat_attach._compress_video_cached(b"raw", _probe(), None, None, MODEL_CFG)
    await chat_attach._compress_video_cached(b"raw", _probe(), None, None, MODEL_CFG)

    assert call_count == 2
    assert fake_redis.set_calls == []   # 完全没碰 Redis


@pytest.mark.asyncio
async def test_cache_hit_refreshes_marker_with_set_not_expire(storage, monkeypatch):
    fake_redis = _FakeRedis()
    monkeypatch.setattr(chat_attach, "get_redis", lambda: fake_redis)

    async def fake_compress(raw, probe=None):
        return b"compressed-bytes"

    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)

    storage_key, user_id = "u1/lib/video.mp4", "u1"
    await chat_attach._compress_video_cached(b"raw", _probe(), storage_key, user_id, MODEL_CFG)
    set_calls_after_write = len(fake_redis.set_calls)

    await chat_attach._compress_video_cached(b"raw", _probe(), storage_key, user_id, MODEL_CFG)

    assert len(fake_redis.set_calls) == set_calls_after_write + 1, "命中缓存应该调用 SET 续期"
    assert fake_redis.expire_calls == [], "不应该用 EXPIRE 续期"


@pytest.mark.asyncio
async def test_marker_missing_but_cache_file_present_self_heals(storage, monkeypatch):
    """alive marker 因为 Redis 丢失而不存在，但物理缓存文件还在——命中读取后
    marker 应该被重新创建出来，而不是判定未命中重新转码（存储层数据比 Redis
    更可信，marker 只是加速用的）。"""
    fake_redis = _FakeRedis()
    monkeypatch.setattr(chat_attach, "get_redis", lambda: fake_redis)

    async def fake_compress(raw, probe=None):
        return b"compressed-bytes"

    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)

    storage_key, user_id = "u1/lib/video.mp4", "u1"
    await chat_attach._compress_video_cached(b"raw", _probe(), storage_key, user_id, MODEL_CFG)

    # 模拟 Redis 整体丢失：清空所有 marker
    fake_redis.store.clear()

    call_count_before = 0

    async def fake_compress_should_not_be_called(raw, probe=None):
        nonlocal call_count_before
        call_count_before += 1
        return b"should-not-happen"

    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress_should_not_be_called)

    result = await chat_attach._compress_video_cached(b"raw", _probe(), storage_key, user_id, MODEL_CFG)

    assert result == b"compressed-bytes", "应该命中物理缓存文件，不应该重新转码"
    assert call_count_before == 0
    assert len(fake_redis.store) == 1, "marker 应该被重新创建"


@pytest.mark.asyncio
async def test_single_flight_dedupes_concurrent_transcode(storage, monkeypatch):
    """两个请求"同时"读同一个未缓存的视频，只应该真正转码一次；等锁的那个应该
    直接拿到第一个转码的结果，而不是自己再转码一遍。"""
    fake_redis = _FakeRedis()
    monkeypatch.setattr(chat_attach, "get_redis", lambda: fake_redis)
    call_count = 0

    async def slow_compress(raw, probe=None):
        nonlocal call_count
        call_count += 1
        await asyncio.sleep(0.05)
        return b"compressed-once"

    monkeypatch.setattr(chat_attach, "_compress_video", slow_compress)

    storage_key, user_id = "u1/lib/video.mp4", "u1"
    results = await asyncio.gather(
        chat_attach._compress_video_cached(b"raw", _probe(), storage_key, user_id, MODEL_CFG),
        chat_attach._compress_video_cached(b"raw", _probe(), storage_key, user_id, MODEL_CFG),
    )

    assert call_count == 1, "应该只真正转码一次（single-flight）"
    assert results[0] == results[1] == b"compressed-once"


# ── 视频缓存清理任务（video_cache_gc）─────────────────────────────────────────

class _FakeGcLock:
    def __init__(self, acquirable: bool):
        self._acquirable = acquirable

    async def acquire(self, blocking=False):
        return self._acquirable

    async def release(self):
        pass


class _FakeGcRedis(_FakeRedis):
    def __init__(self, acquirable: bool = True):
        super().__init__()
        self._acquirable = acquirable
        self.lock_calls: list[str] = []

    def lock(self, key, timeout=None, blocking=None):
        self.lock_calls.append(key)
        return _FakeGcLock(self._acquirable)


@pytest.mark.asyncio
async def test_video_cache_gc_skips_when_marker_alive(db, storage, monkeypatch):
    import os, time
    fake_redis = _FakeGcRedis()
    monkeypatch.setattr(video_cache_gc.R, "get_redis", lambda: fake_redis)

    cache_key = "abc123"
    user_id = "u1"
    path = f"{user_id}/.video_cache/{cache_key}.mp4"
    await storage.put(path, b"cached video", "video/mp4")
    old = time.time() - video_cache_gc._MIN_AGE_WITHOUT_MARKER - 3600
    os.utime(storage.root / path, (old, old))
    fake_redis.store[chat_attach._video_cache_alive_key(user_id, cache_key)] = "1"

    n = await video_cache_gc.sweep_video_cache()

    assert n == 0
    assert await storage.exists(path)


@pytest.mark.asyncio
async def test_video_cache_gc_deletes_old_without_marker(db, storage, monkeypatch):
    import os, time
    fake_redis = _FakeGcRedis()
    monkeypatch.setattr(video_cache_gc.R, "get_redis", lambda: fake_redis)

    cache_key = "abc123"
    user_id = "u1"
    path = f"{user_id}/.video_cache/{cache_key}.mp4"
    await storage.put(path, b"cached video", "video/mp4")
    old = time.time() - video_cache_gc._MIN_AGE_WITHOUT_MARKER - 3600
    os.utime(storage.root / path, (old, old))
    # 没有设置 alive marker

    n = await video_cache_gc.sweep_video_cache()

    assert n == 1
    assert not await storage.exists(path)


@pytest.mark.asyncio
async def test_video_cache_gc_skips_recent_without_marker(db, storage, monkeypatch):
    fake_redis = _FakeGcRedis()
    monkeypatch.setattr(video_cache_gc.R, "get_redis", lambda: fake_redis)

    cache_key = "abc123"
    user_id = "u1"
    path = f"{user_id}/.video_cache/{cache_key}.mp4"
    await storage.put(path, b"cached video", "video/mp4")
    # 刚写入，物理年龄很新，没有 marker 也不该删（毫秒级竞态窗口保护）

    n = await video_cache_gc.sweep_video_cache()

    assert n == 0
    assert await storage.exists(path)


@pytest.mark.asyncio
async def test_video_cache_gc_noop_when_lock_held(db, storage, monkeypatch):
    import os, time
    fake_redis = _FakeGcRedis(acquirable=False)
    monkeypatch.setattr(video_cache_gc.R, "get_redis", lambda: fake_redis)

    cache_key = "abc123"
    user_id = "u1"
    path = f"{user_id}/.video_cache/{cache_key}.mp4"
    await storage.put(path, b"cached video", "video/mp4")
    old = time.time() - video_cache_gc._MIN_AGE_WITHOUT_MARKER - 3600
    os.utime(storage.root / path, (old, old))

    n = await video_cache_gc.sweep_video_cache()

    assert n == 0
    assert await storage.exists(path)
    assert fake_redis.lock_calls == [video_cache_gc._LOCK_KEY]


# ── 补充：首次写缓存真的落存储 + marker 存在但物理文件已丢的自愈 ───────────────

@pytest.mark.asyncio
async def test_first_call_writes_cache_file_and_marker(storage, monkeypatch):
    fake_redis = _FakeRedis()
    monkeypatch.setattr(chat_attach, "get_redis", lambda: fake_redis)

    async def fake_compress(raw, probe=None):
        return b"compressed-bytes"

    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)

    storage_key, user_id = "u1/lib/video.mp4", "u1"
    profile = chat_attach._video_transcode_profile(MODEL_CFG)
    cache_key = chat_attach._video_cache_key(storage_key, profile)
    cache_path = chat_attach._video_cache_path(user_id, cache_key)
    alive_key = chat_attach._video_cache_alive_key(user_id, cache_key)

    await chat_attach._compress_video_cached(b"raw", _probe(), storage_key, user_id, MODEL_CFG)

    assert await storage.exists(cache_path)
    assert await storage.get(cache_path) == b"compressed-bytes"
    assert fake_redis.store.get(alive_key) == "1"


@pytest.mark.asyncio
async def test_alive_marker_present_but_cache_file_missing_retranscodes(storage, monkeypatch):
    """alive marker 还在（比如被外部/安全网误删了物理文件，但 Redis marker 还没
    过期），`prepare_video_media`/`_compress_video_cached` 应该自动判定未命中、
    重新转码，而不是报错或返回损坏内容；成功后重建 marker + 缓存文件。"""
    fake_redis = _FakeRedis()
    monkeypatch.setattr(chat_attach, "get_redis", lambda: fake_redis)
    call_count = 0

    async def fake_compress(raw, probe=None):
        nonlocal call_count
        call_count += 1
        return b"fresh-compressed-bytes"

    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)

    storage_key, user_id = "u1/lib/video.mp4", "u1"
    profile = chat_attach._video_transcode_profile(MODEL_CFG)
    cache_key = chat_attach._video_cache_key(storage_key, profile)
    cache_path = chat_attach._video_cache_path(user_id, cache_key)
    alive_key = chat_attach._video_cache_alive_key(user_id, cache_key)

    # 手动伪造"marker 存在，但物理文件不存在"的不一致状态
    fake_redis.store[alive_key] = "1"
    assert not await storage.exists(cache_path)

    result = await chat_attach._compress_video_cached(b"raw", _probe(), storage_key, user_id, MODEL_CFG)

    assert result == b"fresh-compressed-bytes"
    assert call_count == 1, "marker 存在但文件缺失时应该重新转码，不能报错/返回空"
    assert await storage.exists(cache_path), "重新转码后应该重建缓存文件"
    assert fake_redis.store.get(alive_key) == "1"


@pytest.mark.asyncio
async def test_video_cache_gc_records_snapshot(db, storage, monkeypatch):
    """清理跑完后应该落一条 StorageCategorySnapshot（category='video_cache'，
    管理后台趋势面板用），对象数/总字节数要反映清理后的剩余占用。"""
    from app.models import StorageCategorySnapshot
    from sqlalchemy import select

    fake_redis = _FakeGcRedis()
    monkeypatch.setattr(video_cache_gc.R, "get_redis", lambda: fake_redis)

    # 一个还活着（marker 在），一个该被清理（marker 不在 + 物理年龄够老）
    kept_path = "u1/.video_cache/kept.mp4"
    removed_path = "u1/.video_cache/removed.mp4"
    await storage.put(kept_path, b"x" * 100, "video/mp4")
    await storage.put(removed_path, b"y" * 50, "video/mp4")
    fake_redis.store[chat_attach._video_cache_alive_key("u1", "kept")] = "1"

    import os, time
    old = time.time() - video_cache_gc._MIN_AGE_WITHOUT_MARKER - 3600
    os.utime(storage.root / removed_path, (old, old))

    n = await video_cache_gc.sweep_video_cache()
    assert n == 1

    snapshot = (await db.execute(
        select(StorageCategorySnapshot).order_by(StorageCategorySnapshot.id.desc())
    )).scalars().first()
    assert snapshot is not None
    assert snapshot.category == "video_cache"
    assert snapshot.object_count == 1, "清理后只剩那个 marker 还活着的对象"
    assert snapshot.total_bytes == 100
