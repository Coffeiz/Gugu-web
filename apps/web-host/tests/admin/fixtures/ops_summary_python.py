"""读取明确隔离Redis中的合成hash并调用实际Python运维handler。"""
import os,sys,json,asyncio,tempfile
from pathlib import Path
from datetime import datetime,timezone
from urllib.parse import urlparse
if len(sys.argv)!=4 or sys.argv[1]!='--allow-isolated-test-redis':raise SystemExit('仅限显式隔离Redis')
url,day=sys.argv[2:]
parsed=urlparse(url)
if parsed.hostname not in {'127.0.0.1','localhost'} or parsed.path!='/9':raise SystemExit('拒绝非合成Redis')
with tempfile.TemporaryDirectory(prefix='ops-python-') as tmp:
 os.environ['GUGU_ENV_FILE']=str(Path(tmp)/'no.env')
 os.environ['GUGU_CONFIG_OVERRIDE_FILE']=str(Path(tmp)/'no.json')
 os.environ['STORAGE__LOCAL_PATH']=str(Path(tmp)/'storage')
 from pydantic import TypeAdapter,ValidationError
 integer=TypeAdapter(int)
 for value,expected in [('1.0',1),('1_0',10),(' 2 ',2)]:assert integer.validate_python(value)==expected
 try:integer.validate_python('1e0')
 except ValidationError:pass
 else:raise AssertionError('科学计数法应被拒绝')
 from app.api.v1 import ops_admin
 from app.core import redis,opsmetrics
 import redis.asyncio as aioredis
 fixed=datetime.fromisoformat(day).replace(tzinfo=timezone.utc)
 class Clock(datetime):
  @classmethod
  def now(cls,tz=None):return fixed
 opsmetrics.datetime=Clock
 async def main():
  r=aioredis.from_url(url,decode_responses=True)
  redis.get_redis=lambda:r
  try:print(json.dumps(await ops_admin.ops_summary(days=2),ensure_ascii=False))
  finally:await r.aclose()
 asyncio.run(main())
