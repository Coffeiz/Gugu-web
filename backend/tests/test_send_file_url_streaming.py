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
from agent.tools.files import transfer as file_transfer
from app.core import chat_attach


async def _fake_stage(user_id, name, ext, mime, data, **kwargs):
    """这个测试套件测的是 streaming 限流本身，不是 chat_attach 的持久化语义——
    真跑 chat_attach.stage() 需要一个真实存在的 users 行（storage_key/DB 外键），
    测试用的 user_id 只是个占位字符串，跟持久化无关，mock 掉避免测试依赖真实 DB/存储。"""
    return {"attach_id": "fake", "name": name, "ext": ext, "mime": mime or "",
            "size": len(data), "storage_key": f"{user_id}/.chat_staging/fake.{ext}",
            "kind": kwargs.get("kind") or "binary"}

# 与 files.py 保持一致
MAX_BYTES = im_files._SEND_URL_MAX_BYTES
CHUNK = 1024 * 1024   # 1MB


class _FakeResp:
    """流式响应：连续吐 chunk，记录被消费的字节数。

    模拟真实 httpx 生命周期：client 关闭（__aexit__）后 response 的连接随之关闭，
    此时再 aiter_bytes() 会抛 ReadError——用于断言 body 必须在 AsyncClient 生命周期内消费。
    """

    def __init__(self, total_bytes: int, content_type: str = "image/jpeg", *, status_code: int = 200, headers=None):
        self.status_code = status_code
        self.headers = {"content-type": content_type, **(headers or {})}
        self._total = total_bytes
        self.consumed = 0
        self.closed = False
        self.client_closed = False

    async def aiter_bytes(self):
        if self.client_closed:
            raise httpx.ReadError("stream closed: client exited before body consumed")
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
        # 模拟真实 AsyncClient：退出时关闭 transport，response 连接随之失效。
        self._resp.client_closed = True
        return False

    def stream(self, method, url, headers=None):
        assert method == "GET"
        return _FakeStream(self._resp)


class _FakeStream:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, *a):
        return False


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
    async def resolve(_self, url):
        return "93.184.216.34", None
    monkeypatch.setattr(file_transfer.SafeEgressClient, "resolve", resolve)
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
    async def resolve(_self, url):
        return "93.184.216.34", None
    monkeypatch.setattr(file_transfer.SafeEgressClient, "resolve", resolve)
    monkeypatch.setattr(chat_attach, "stage", _fake_stage)
    resp = _FakeResp(CHUNK)   # 1MB
    client = _FakeClient(resp)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client)

    result, resp = _run("https://example.com/small.jpg", resp)

    assert isinstance(result, dict)
    assert result.get("ok") is True
    assert resp.consumed == CHUNK


def test_content_length_over_limit_rejected_before_read(monkeypatch):
    """Content-Length 声明就超限：不读 body 直接拒绝。"""
    async def resolve(_self, url):
        return "93.184.216.34", None
    monkeypatch.setattr(file_transfer.SafeEgressClient, "resolve", resolve)
    resp = _FakeResp(0)   # body 为空，但声明 Content-Length 超限
    resp.headers["content-length"] = str(MAX_BYTES * 2)
    client = _FakeClient(resp)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client)

    result, resp = _run("https://example.com/declared-big.jpg", resp)

    assert isinstance(result, str)
    payload = json.loads(result)
    assert "图片过大" in payload["error"]
    assert resp.consumed == 0, "Content-Length 超限不应读 body"


def test_send_file_uses_shared_egress_stream(monkeypatch):
    """文件 URL 下载复用统一出站适配器；目标域名先经过统一解析校验。"""
    monkeypatch.setattr(chat_attach, "stage", _fake_stage)
    resp = _FakeResp(CHUNK)
    client = _FakeClient(resp)
    resolved = []

    async def resolve(_self, url):
        resolved.append(url)
        return "93.184.216.34", None

    def fake_async_client(**kwargs):
        return client

    monkeypatch.setattr(file_transfer.SafeEgressClient, "resolve", resolve)
    monkeypatch.setattr(httpx, "AsyncClient", fake_async_client)

    _run("https://example.com/small.jpg", resp)
    assert resolved == ["https://example.com/small.jpg"]


def test_send_file_revalidates_redirect_target_through_shared_adapter(monkeypatch):
    monkeypatch.setattr(chat_attach, "stage", _fake_stage)
    responses = [
        _FakeResp(0, status_code=302, headers={"location": "https://cdn.example/image.jpg"}),
        _FakeResp(CHUNK),
    ]
    resolved = []

    class _ResponseQueueClient(_FakeClient):
        def __init__(self, _resp):
            super().__init__(responses.pop(0))

    async def resolve(_self, url):
        resolved.append(url)
        return "93.184.216.34", None

    monkeypatch.setattr(file_transfer.SafeEgressClient, "resolve", resolve)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: _ResponseQueueClient(None))
    result, _ = _run("https://example.com/image.jpg", responses[-1])
    assert result.get("ok") is True
    assert resolved == ["https://example.com/image.jpg", "https://cdn.example/image.jpg"]


def test_send_file_rejects_private_redirect_before_opening_second_connection(monkeypatch):
    response = _FakeResp(0, status_code=302, headers={"location": "http://127.0.0.1/secret"})
    resolved = []
    clients_created = []

    async def resolve(_self, url):
        resolved.append(url)
        if url.startswith("http://127."):
            raise file_transfer.SafeEgressError("non_public_destination", "目标地址不是公网地址，已拒绝请求")
        return "93.184.216.34", None

    def fake_async_client(**kwargs):
        clients_created.append(kwargs)
        return _FakeClient(response)

    monkeypatch.setattr(file_transfer.SafeEgressClient, "resolve", resolve)
    monkeypatch.setattr(httpx, "AsyncClient", fake_async_client)
    result, _ = _run("https://example.com/image.jpg", response)

    assert "目标地址不是公网地址" in json.loads(result)["error"]
    assert resolved == ["https://example.com/image.jpg", "http://127.0.0.1/secret"]
    assert len(clients_created) == 1
