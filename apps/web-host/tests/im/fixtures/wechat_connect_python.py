"""微信实际handler/ILinkClient及gateway消费，限临时配置、随机schema与私有Redis。"""
import asyncio,base64,hashlib,json,os,sys
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID
path=Path(os.environ['GUGU_CONFIG_OVERRIDE_FILE']).resolve()
if not path.parent.name.startswith('wechat-connect-') or not os.environ['TEST_SCHEMA'].startswith('wechat_connect_'):raise SystemExit('仅允许隔离测试')
if not os.environ['GUGU_WEBUI_TEST_REDIS_URL'].endswith('/9'):raise SystemExit('拒绝非隔离Redis')
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from sqlalchemy import select
from redis.asyncio import Redis
from app.api.v1 import wechat_connect as api
from app.models import UserBot
from app.db import session as database
from app.core import events
from agent.gateway.gateway import _fetch_userbots,_spawn_environment
from agent.context.session_snapshot import invalidate_user_im_snapshots
from agent.gateway.wechat import client as ilink

async def main():
 engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}})
 factory=async_sessionmaker(engine,expire_on_commit=False);database.ensure_engine=lambda:None;database._SessionLocal=factory
 redis=Redis.from_url(os.environ['GUGU_WEBUI_TEST_REDIS_URL'],decode_responses=True);api.R.get_redis=lambda:redis
 owner=UUID(os.environ['TEST_OWNER']);user=SimpleNamespace(id=owner);publications=[];requests=[]
 async def publish(who,*resources,**kwargs):
  assert who==owner and resources==('im_channels',) and kwargs=={'operation':'refresh'}
  await invalidate_user_im_snapshots(who);publications.append(True)
 events.publish=publish
 try:
  if sys.argv[1]=='consume':
   specs=await _fetch_userbots();selected=next(item for item in specs if item['owner']==str(owner) and item['platform']=='wechat');spawn=_spawn_environment(selected)
   print(json.dumps({'owner':selected['owner'],'app_id':selected['app_id'],'secret_sha':hashlib.sha256(selected['app_secret'].encode()).hexdigest(),'gateway_token_sha':hashlib.sha256(spawn['WECHAT_BOT_TOKEN'].encode()).hexdigest(),'gateway_base_url':spawn['WECHAT_BASE_URL']}));return
  if sys.argv[1]=='state':
   raw=await redis.get('wechatconnect:'+os.environ['TEST_TASK']);meta=json.loads(raw) if raw else {}
   print(json.dumps({'ttl':await redis.ttl('wechatconnect:'+os.environ['TEST_TASK']),'owner':meta.get('uid'),'qrcode_sha':hashlib.sha256(meta.get('qrcode','').encode()).hexdigest()}));return
  import httpx
  response=json.loads(os.environ['TEST_RESPONSE']);status=int(os.environ.get('TEST_HTTP_STATUS','200'))
  class Client:
   def __init__(self,**kwargs):pass
   async def get(self,url,params,headers,timeout):
    requests.append({'path':url.split('https://ilinkai.weixin.qq.com')[-1],'params':params,'headers':headers,'timeout':timeout})
    result=httpx.Response(status,json=response,request=httpx.Request('GET',url));return result
   async def aclose(self):pass
  ilink.httpx.AsyncClient=Client;ilink.secrets.randbelow=lambda maximum:123
  api.uuid.uuid4=lambda:SimpleNamespace(hex=os.environ['TEST_TASK'])
  async with factory() as db:
   result=await api.start(user) if sys.argv[1]=='start' else await api.poll(os.environ['TEST_TASK'],user,db)
   bot=(await db.execute(select(UserBot).where(UserBot.user_id==owner,UserBot.platform=='wechat'))).scalars().first()
   extra={'secret_sha':hashlib.sha256(bot.app_secret.encode()).hexdigest(),'app_id':bot.app_id,'enabled':bot.enabled} if bot else {}
   print(json.dumps({'result':result,'requests':requests,'publications':len(publications),**extra}))
 finally:await redis.aclose();await engine.dispose()
asyncio.run(main())
