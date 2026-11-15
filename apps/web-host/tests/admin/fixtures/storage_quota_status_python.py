import os
import pytest
pytest_plugins=['tests.conftest']
@pytest.mark.asyncio
async def test_storage_quota_status_real_redis(monkeypatch):
 from redis.asyncio import from_url
 from app.api.v1 import storage_quota_admin as module
 from urllib.parse import urlsplit,urlunsplit
 raw=urlsplit(os.environ['GUGU_WEBUI_TEST_REDIS_URL'])
 redis=from_url(urlunsplit(raw._replace(path='/13')),decode_responses=True)
 monkeypatch.setattr(module.R,'get_redis',lambda:redis)
 keys=[module._STATE_KEY,module._LOCK_KEY]
 try:
  await redis.delete(*keys)
  assert await module.get_full_reconcile_status()=={'status':'idle'}
  await redis.set(module._STATE_KEY,'{"status":"running","processed":3}')
  await redis.set(module._LOCK_KEY,'synthetic-lock')
  assert await module.get_full_reconcile_status()=={'status':'running','processed':3}
  await redis.delete(module._LOCK_KEY)
  result=await module.get_full_reconcile_status()
  assert result['status']=='interrupted' and result['processed']==3 and 'finished_at' in result
  assert await redis.ttl(module._STATE_KEY)>604790
  await redis.set(module._STATE_KEY,'broken')
  assert await module.get_full_reconcile_status()=={'status':'idle'}
 finally:
  await redis.delete(*keys)
  await redis.aclose()
