"""实际Python删除handler/clear_imreach/快照失效，限定合成PG与Redis。"""
import os,sys,re,json,asyncio
from uuid import UUID,uuid4
from datetime import timedelta
from urllib.parse import urlparse
if sys.argv[1:]!=['--allow-isolated-test-delete-reference'] or not re.fullmatch(r'bot_delete_[a-f0-9]{32}',os.environ.get('TEST_SCHEMA','')):raise SystemExit('仅限隔离测试')
redis_url=os.environ['TEST_REDIS_URL'];parsed=urlparse(redis_url)
if parsed.hostname not in {'127.0.0.1','localhost'} or parsed.path!='/8':raise SystemExit('拒绝非测试Redis')
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
import redis.asyncio as redis
from app.models import User,UserBot,ConversationSession
from app.api.v1.user_bots import delete_my_bot
from app.core import events,redis as redis_module
from app.db import session as database
from app.core.tz import now_utc
from agent.context.session_snapshot import invalidate_user_im_snapshots
async def main():
 engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}});factory=async_sessionmaker(engine,expire_on_commit=False);database.ensure_engine=lambda:None;database._SessionLocal=factory
 store=redis.from_url(redis_url,decode_responses=True);redis_module.get_redis=lambda:store;owner=uuid4()
 try:
  async with factory() as db:
   user=User(id=owner,username='小星',email=f'{owner}@example.invalid',hashed_password='synthetic');db.add(user);await db.flush()
   bot=UserBot(user_id=owner,platform='qq',app_id='synthetic-reference',app_secret='synthetic-reference-secret');db.add(bot)
   for i,source in enumerate(['web','qq','feishu','telegram','wechat']):db.add(ConversationSession(id=1001+i,user_id=owner,source=source,context_epoch=4,snapshot_hash='synthetic-snapshot',session_info_hash='synthetic-session',snapshot_expires_at=now_utc()+timedelta(days=1)))
   await db.commit();await db.refresh(bot);bot_id=bot.id
   for key in [f'imreach:{owner}',f'imreach:{owner}:qq']:await store.set(key,json.dumps({'platform':'qq','puid':'synthetic'}))
   calls=[]
   async def publish(who,*resources,**kwargs):
    assert await db.get(UserBot,bot_id) is None
    calls.append({'resources':resources,'operation':kwargs['operation']});await invalidate_user_im_snapshots(who)
   events.publish=publish
   await delete_my_bot(bot_id,user,db)
   rows=(await db.scalars(select(ConversationSession).where(ConversationSession.user_id==owner).order_by(ConversationSession.source))).all()
   print(json.dumps({'deleted':await db.get(UserBot,bot_id) is None,'platform_reach':await store.get(f'imreach:{owner}:qq'),'recent_reach':await store.get(f'imreach:{owner}'),'calls':calls,'snapshots':[{'source':r.source,'context_epoch':r.context_epoch,'snapshot_hash':r.snapshot_hash,'session_info_hash':r.session_info_hash,'expired':r.snapshot_expires_at<now_utc()} for r in rows]}))
 finally:await store.aclose();await engine.dispose()
asyncio.run(main())
