import json
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
pytest_plugins=['tests.conftest']
@pytest.mark.asyncio
async def test_patch_real_encryption_preserves_unsent_auth_and_rejects_bad_urls(monkeypatch):
 from app.api.v1 import safe_egress_admin as module
 from app.core import crypto
 from app.core.config import SafeEgressSettings
 monkeypatch.setattr(crypto,'get_settings',lambda:SimpleNamespace(secret_key='synthetic-egress-secret'))
 state={'enabled':False,'proxy_url':'','proxy_auth_secret':crypto.encrypt_secret(json.dumps({'username':'old-user','password':'old-password'}))}
 monkeypatch.setattr(module,'get_settings',lambda:SimpleNamespace(safe_egress=SafeEgressSettings(**state)))
 async def save(patch):state.update(patch['safe_egress'])
 monkeypatch.setattr(module,'save_override',save)
 result=await module.patch_safe_egress_config(module.SafeEgressPatch(enabled=True,proxy_url=' http://proxy.example:3128/ ',proxy_username='new-user'))
 assert result=={'enabled':True,'proxy_url':'http://proxy.example:3128','has_auth':True}
 assert json.loads(crypto.decrypt_secret(state['proxy_auth_secret']))=={'username':'new-user','password':'old-password'}
 before=dict(state)
 for url in ['http://user:password@proxy.example:3128','http://proxy.example:3128/path','socks5://proxy.example:1080']:
  with pytest.raises(HTTPException) as error:await module.patch_safe_egress_config(module.SafeEgressPatch(proxy_url=url))
  assert error.value.status_code==422 and state==before
 assert (await module.patch_safe_egress_config(module.SafeEgressPatch(clear_credentials=True,proxy_username='ignored',proxy_password='ignored')))['has_auth'] is False
 assert state['proxy_auth_secret']==''
 state['proxy_auth_secret']='gcm1:broken'
 with pytest.raises(HTTPException) as error:await module.patch_safe_egress_config(module.SafeEgressPatch(clear_credentials=True))
 assert error.value.status_code==500 and state['proxy_auth_secret']=='gcm1:broken'
