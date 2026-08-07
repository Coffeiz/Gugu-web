"""send_file(url) 网络图片下载的 streaming 限流回归测试。

覆盖 PR #10 复审提出的 P1 DoS 面：旧实现用 httpx.get() 把整个响应读进内存后才检查
15MB 上限，群成员给一个 2GB 的 URL 会先把 2GB 全读进 RAM。新实现用 streaming +
累计限流，读取到上限附近就中止，不消费完整响应。
"""
import asyncio
import json

import httpx
import pytest

from agent.tools import files as im_files

# 与 files.py 保持一致
MAX_BYTES = im_files._SEND_URL_MAX_BYTES
CHUNK = 1024 * 1024   # 1MB


class _FakeResp:
    """流式响应：连续吐 chunk，记录被消费的字节数。"""

    def __init__(self, total_bytes: int, content_type: str = "image/jpeg"):
        self.status_code = 200
        self.headers = {"content-type": content_type}
        self._total = total_bytes
        self.consumed = 0
        self.closed = False

    async def aiter_bytes(self):
        while self.consumed < self._total:
            n = min(CHUNK, self._total - self.consumed)
            self.consumed += n
            yield b"\x00" * n

    async def aclose(self):
        self.closed = True


class _FakeClient:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def build_request(self, method, url):
        return {"method": method, "url": url}

    async def send(self, request, stream=False):
        return self._resp


def _run(url: str, resp: _FakeResp):
    """在独立事件循环里跑 _send_file_from_url，返回 (结果, resp)。"""
    async def _inner():
        return await im_files._send_file_from_url("user-1", url, "测试图")

    result = asyncio.run(_inner())
    return result, resp


@pytest.mark.parametrize("total_bytes", [
    MAX_BYTES + CHUNK * 2,      # 略超上限（响应明显大于上限）
    MAX_BYTES * 2,              # 2 倍
    MAX_BYTES * 100,            # 100 倍（模拟 2GB 级 DoS）
])
def test_streaming_aborts_near_limit_not_full_body(monkeypatch, total_bytes):
    """chunked 响应连续吐 >15MB：读取到上限附近就中止，不消费完整响应。"""
    monkeypatch.setattr(im_files, "_url_is_safe", lambda url: None)
    resp = _FakeResp(total_bytes)
    client = _FakeClient(resp)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client)

    result, resp = _run("https://example.com/big.jpg", resp)

    # 返回「图片过大」错误
    assert isinstance(result, str)
    payload = json.loads(result)
    assert "图片过大" in payload["error"]
    # 消费的字节数在上限附近（超过 MAX 触发超限，但最多多一个 chunk），而不是把整个响应读完
    assert MAX_BYTES < resp.consumed <= MAX_BYTES + CHUNK
    assert resp.consumed < total_bytes, "不应消费完整响应（DoS 面）"


def test_streaming_accepts_under_limit(monkeypatch):
    """小于上限的图片正常下载成功。"""
    monkeypatch.setattr(im_files, "_url_is_safe", lambda url: None)
    resp = _FakeResp(CHUNK)   # 1MB
    client = _FakeClient(resp)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client)

    result, resp = _run("https://example.com/small.jpg", resp)

    assert isinstance(result, dict)
    assert result.get("ok") is True
    assert resp.consumed == CHUNK


def test_content_length_over_limit_rejected_before_read(monkeypatch):
    """Content-Length 声明就超限：不读 body 直接拒绝。"""
    monkeypatch.setattr(im_files, "_url_is_safe", lambda url: None)
    resp = _FakeResp(0)   # body 为空，但声明 Content-Length 超限
    resp.headers["content-length"] = str(MAX_BYTES * 2)
    client = _FakeClient(resp)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client)

    result, resp = _run("https://example.com/declared-big.jpg", resp)

    assert isinstance(result, str)
    payload = json.loads(result)
    assert "图片过大" in payload["error"]
    assert resp.consumed == 0, "Content-Length 超限不应读 body"
