"""QQ 包 facade 保持跨层入口并关闭当前进程的 HTTP 连接池。"""
from __future__ import annotations

import pytest


def test_qq_facade_reexports_stable_lifecycle_and_send_entries():
    from agent.gateway import qq
    from agent.gateway.qq import client, outbound, runtime

    assert qq.close_qq_http_session is client.close_qq_http_session
    assert qq.start_qq_http_session is client.start_qq_http_session
    assert qq.send_c2c is outbound.send_c2c
    assert qq.send_group is outbound.send_group
    assert qq.serve is runtime.serve


@pytest.mark.asyncio
async def test_qq_facade_closes_the_owned_http_session(monkeypatch):
    from agent.gateway import qq
    from agent.gateway.qq import client

    class _Session:
        closed = False

        def __init__(self):
            self.close_calls = 0

        async def close(self):
            self.close_calls += 1
            self.closed = True

    session = _Session()
    monkeypatch.setattr(client, "_QQ_HTTP_SESSION", session)

    await qq.close_qq_http_session()

    assert session.close_calls == 1
    assert client._QQ_HTTP_SESSION is None
