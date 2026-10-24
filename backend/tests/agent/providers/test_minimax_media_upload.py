"""MiniMax Files API 视频上传测试（Provider 专属行为，规格跟随 Provider）。

通用媒体层只决定「这里需要走文件上传」，具体上传动作由 MiniMax Provider 实现
（`agent.providers.minimax.media.upload_video_file`）。
"""
import asyncio
from types import SimpleNamespace

import httpx
import pytest


def test_upload_video_file_success(monkeypatch):
    """上传成功返回 file_id。"""
    from agent.providers.minimax.media import upload_video_file

    class FakeResp:
        status_code = 200

        def json(self):
            return {"file": {"file_id": 12345}, "base_resp": {"status_code": 0}}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            return FakeResp()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    fid = asyncio.run(upload_video_file(
        b"DATA", "v.mp4", mime="video/mp4", purpose="video_understanding",
        api_key="k", base_url="https://api.minimaxi.com/anthropic"))
    assert fid == "12345"


def test_upload_video_file_failure_status(monkeypatch):
    """非 200 返回 None（不抛异常）。"""
    from agent.providers.minimax.media import upload_video_file

    class FakeResp:
        status_code = 500

        def json(self):
            return {}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            return FakeResp()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    fid = asyncio.run(upload_video_file(
        b"DATA", "v.mp4", mime="video/mp4", purpose="video_understanding",
        api_key="k", base_url="https://api.minimaxi.com/anthropic"))
    assert fid is None


def test_upload_video_file_requires_credentials(monkeypatch):
    """缺 api_key / base_url → 跳过上传返回 None，不报错。"""
    from agent.providers.minimax.media import upload_video_file

    fid = asyncio.run(upload_video_file(
        b"DATA", "v.mp4", mime="video/mp4", purpose="video_understanding",
        api_key="", base_url=""))
    assert fid is None


def test_adapter_upload_media_file_uses_provider_implementation(monkeypatch):
    """适配器钩子把上传交给 MiniMax 自己的实现。"""
    from agent.providers.minimax import MiniMaxAdapter

    seen = {}

    async def fake_upload(raw, name, *, mime="", purpose="", api_key="", base_url=""):
        seen.update(raw=raw, name=name, mime=mime, purpose=purpose,
                    api_key=api_key, base_url=base_url)
        return "file-1"

    monkeypatch.setattr("agent.providers.minimax.media.upload_video_file", fake_upload)
    ai = SimpleNamespace(api_key="k", base_url="https://api.minimaxi.com/anthropic")
    fid = asyncio.run(MiniMaxAdapter().upload_media_file(
        b"DATA", "v.mp4", ai, mime="video/mp4", purpose="video_understanding"))
    assert fid == "file-1"
    assert seen["name"] == "v.mp4" and seen["mime"] == "video/mp4"
    assert seen["purpose"] == "video_understanding"


def test_base_adapter_does_not_support_file_upload():
    """默认适配器不支持文件上传（返回 None）——通用层据此判定 Provider 能力。"""
    from agent.providers.base import ProviderAdapter

    fid = asyncio.run(ProviderAdapter().upload_media_file(
        b"DATA", "v.mp4", SimpleNamespace(), mime="video/mp4", purpose="video_understanding"))
    assert fid is None
