import pytest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from app.api.v1 import safe_egress_admin as api
from app.core.safe_egress import SafeEgressError

@pytest.mark.asyncio
async def test_actual_handler_stage_and_no_secret(monkeypatch):
    monkeypatch.setattr(api, 'get_settings', lambda: SimpleNamespace(safe_egress=SimpleNamespace(enabled=False, proxy_url='http://proxy.example', proxy_auth_secret='')))
    monkeypatch.setattr(api, '_current_auth', lambda: ('', ''))
    monkeypatch.setattr(api, '_make_settings', lambda **kwargs: kwargs)
    class Client:
        def __init__(self, settings): pass
        @asynccontextmanager
        async def stream(self, url, **kwargs):
            assert url == 'https://ja.wikipedia.org/wiki/Muque'
            yield SimpleNamespace(status_code=204)
    monkeypatch.setattr(api, 'SafeEgressClient', Client)
    result = await api.test_safe_egress(api.SafeEgressTestRequest())
    assert {k:v for k,v in result.items() if k != 'elapsed_ms'} == {'ok':True,'stage':'connected','message':'代理、DNS、IP 钉扎和 TLS 验证均已通过','status_code':204}
    class Failure(Client):
        @asynccontextmanager
        async def stream(self, url, **kwargs):
            raise SafeEgressError('tls_verification_failed','目标站点 TLS 握手或证书验证失败，已拒绝连接')
            yield
    monkeypatch.setattr(api, 'SafeEgressClient', Failure)
    result = await api.test_safe_egress(api.SafeEgressTestRequest())
    assert {k:v for k,v in result.items() if k != 'elapsed_ms'} == {'ok':False,'stage':'tls_verification_failed','message':'目标站点 TLS 握手或证书验证失败，已拒绝连接'}
