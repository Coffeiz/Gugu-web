"""飞书实际handler，仅临时TLS门户、随机schema、私有Redis。"""
import os,sys,json,asyncio,hashlib
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID
from types import SimpleNamespace
path=Path(os.environ['GUGU_CONFIG_OVERRIDE_FILE']).resolve();base=os.environ['TEST_FEISHU_PORTAL']
if not path.parent.name.startswith('feishu-connect-') or not os.environ['TEST_SCHEMA'].startswith('feishu_connect_') or urlparse(base).hostname!='127.0.0.1' or not os.environ['GUGU_WEBUI_TEST_REDIS_URL'].endswith('/8'):raise SystemExit('拒绝非隔离测试')
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from sqlalchemy import select
from redis.asyncio import Redis
from app.api.v1 import feishu_connect
from app.models import UserBot
from app.db import session as database
from app.core import events
from agent.context.session_snapshot import invalidate_user_im_snapshots
feishu_connect.REG_ENDPOINT=base+'/oauth/v1/app/registration'
async def main():
 engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}});factory=async_sessionmaker(engine,expire_on_commit=False);database.ensure_engine=lambda:None;database._SessionLocal=factory
 redis=Redis.from_url(os.environ['GUGU_WEBUI_TEST_REDIS_URL'],decode_responses=True);feishu_connect.R.get_redis=lambda:redis
 owner=UUID(os.environ['TEST_OWNER']);user=SimpleNamespace(id=owner);publications=[]
 async def publish(who,*resources,**kwargs):
  assert who==owner and resources==('im_channels',) and kwargs=={'operation':'refresh'}
  await invalidate_user_im_snapshots(who);publications.append(True)
 events.publish=publish
 try:
  async with factory() as db:
   if sys.argv[1]=='start':
    result=await feishu_connect.start(user);key='feishuconnect:'+result['poll_id'];meta=json.loads(await redis.get(key));extra={'owner':meta['uid'],'ttl':await redis.ttl(key),'device_code_matches':meta['device_code']=='synthetic-device-code'}
   else:
    result=await feishu_connect.poll(os.environ['TEST_POLL'],user,db);extra={'publications':len(publications)}
    bot=(await db.execute(select(UserBot).where(UserBot.user_id==owner,UserBot.platform=='feishu'))).scalars().first()
    if bot:extra.update({'secret_sha':hashlib.sha256(bot.app_secret.encode()).hexdigest(),'app_id':bot.app_id,'owner_platform_user_id':bot.owner_platform_user_id,'group_enabled':bot.feishu_group_chat_enabled})
   print(json.dumps({'result':result,**extra},ensure_ascii=False))
 finally:await redis.aclose();await engine.dispose()
asyncio.run(main())
