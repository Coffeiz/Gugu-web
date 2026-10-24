"""大视频传输不整读、不跨用户复用上传引用，并保护取消和源文件变化。"""
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import fakeredis.aioredis
import pytest

from agent.media.budget import MediaMemoryBudget
from agent.media.video_source import prepare_video_path


@pytest.fixture
def video_source(tmp_path, monkeypatch):
    path = tmp_path / "synthetic.mp4"
    with path.open("wb") as stream:
        stream.truncate(5 * 1024 * 1024)
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    upload = AsyncMock(return_value="synthetic-file")
    from agent import providers
    adapter = providers.adapter_for(SimpleNamespace(provider="minimax"))
    monkeypatch.setattr(adapter, "upload_media_path", upload)
    cfg = SimpleNamespace(provider="minimax", model="MiniMax-M3", api_format="anthropic",
                          base_url="https://example.invalid/anthropic", api_key="synthetic", video=True)
    return path, redis, upload, cfg


@pytest.mark.asyncio
async def test_large_video_upload_preserves_source_without_read_bytes(video_source, monkeypatch):
    path, redis, upload, cfg = video_source
    monkeypatch.setattr(Path, "read_bytes", lambda *_: pytest.fail("大视频不可整份读入内存"))
    try:
        result = await prepare_video_path(path, "video/mp4", "synthetic.mp4", cfg,
                                          user_id="synthetic-a", probe={"duration": 3})
        assert result == {"type": "video", "mode": "mm_file", "mime": "video/mp4", "file_id": "synthetic-file"}
        assert upload.await_args.args[0] == path
        await prepare_video_path(path, "video/mp4", "synthetic.mp4", cfg,
                                 user_id="synthetic-a", probe={"duration": 3})
        assert upload.await_count == 1
        await prepare_video_path(path, "video/mp4", "synthetic.mp4", cfg,
                                 user_id="synthetic-b", probe={"duration": 3})
        assert upload.await_count == 2
        cfg.api_key = "synthetic-replacement"
        await prepare_video_path(path, "video/mp4", "synthetic.mp4", cfg,
                                 user_id="synthetic-a", probe={"duration": 3})
        assert upload.await_count == 3
    finally:
        await redis.aclose()


@pytest.mark.asyncio
async def test_upload_failure_does_not_fall_back_to_large_base64(video_source, monkeypatch):
    path, redis, upload, cfg = video_source
    upload.return_value = None
    monkeypatch.setattr(Path, "read_bytes", lambda *_: pytest.fail("上传失败不能退回大载荷"))
    try:
        with pytest.raises(ValueError, match="上传失败"):
            await prepare_video_path(path, "video/mp4", "synthetic.mp4", cfg,
                                     user_id="synthetic-a", probe={"duration": 3})
        assert await redis.dbsize() == 0
    finally:
        await redis.aclose()


@pytest.mark.asyncio
async def test_changed_source_is_rejected_without_caching_reference(video_source):
    path, redis, upload, cfg = video_source

    async def mutate(*_args, **_kwargs):
        with path.open("ab") as stream:
            stream.write(b"changed")
        return "synthetic-file"

    upload.side_effect = mutate
    try:
        with pytest.raises(ValueError, match="发生变化"):
            await prepare_video_path(path, "video/mp4", "synthetic.mp4", cfg,
                                     user_id="synthetic-a", probe={"duration": 3})
        assert await redis.dbsize() == 0
    finally:
        await redis.aclose()


@pytest.mark.asyncio
async def test_source_capacity_is_checked_before_upload(video_source):
    path, redis, upload, cfg = video_source
    try:
        with pytest.raises(ValueError, match="剩余容量不足"):
            await prepare_video_path(path, "video/mp4", "synthetic.mp4", cfg,
                                     probe={"duration": 3}, max_source_bytes=1)
        upload.assert_not_awaited()
    finally:
        await redis.aclose()


@pytest.mark.asyncio
async def test_media_budget_waiter_cancellation_does_not_leak_capacity():
    budget = MediaMemoryBudget(10)
    entered = asyncio.Event()

    async def wait():
        async with budget.reserve(1):
            entered.set()

    async with budget.reserve(100):
        task = asyncio.create_task(wait())
        await asyncio.sleep(0)
        assert not entered.is_set()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    async with budget.reserve(10):
        assert budget.used == 10
    assert budget.used == 0


@pytest.mark.asyncio
async def test_provider_upload_streams_multipart_without_changing_file(tmp_path, monkeypatch):
    """HTTP 传输层收到完整原文件，最大数据块不超过 64 KiB。"""
    import httpx
    from agent.providers.minimax.media import upload_video_path

    original = bytes(range(256)) * 1024
    path = tmp_path / "synthetic.mp4"
    path.write_bytes(original)
    chunks = []

    class Receiver(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            async for chunk in request.stream:
                chunks.append(chunk)
            return httpx.Response(200, json={"file": {"file_id": "synthetic-reference"}})

    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client(transport=Receiver(), **kwargs))
    result = await upload_video_path(path, "synthetic.mp4", mime="video/mp4",
                                    purpose="video_understanding", api_key="synthetic",
                                    base_url="https://example.invalid/anthropic")
    assert result == "synthetic-reference"
    assert max(map(len, chunks)) <= 64 * 1024
    assert original in b"".join(chunks)
    assert path.read_bytes() == original


@pytest.mark.parametrize("value", [
    {"中文": [None, True, 1.25, "引号\"与换行\n"], "b": "abc" * 10000},
    [{"role": "user", "content": [{"type": "video", "file_id": "synthetic"}]}],
])
def test_incremental_digest_preserves_canonical_json_contract(value):
    """内存优化不改变上下文身份和缓存前缀摘要。"""
    import hashlib
    from agent.context.canonical_context import digest, stable_json

    assert digest(value, length=64) == hashlib.sha256(stable_json(value).encode()).hexdigest()
