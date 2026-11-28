"""仅供隔离PG/Redis合成数据测试，调用真实Python绑定码消费者。"""
import asyncio,json,os,sys,uuid,tempfile
from pathlib import Path
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from redis.asyncio import from_url

async def main():
 safe=tempfile.TemporaryDirectory(prefix='n2-binding-consumer-')
 os.environ['GUGU_ENV_FILE']=str(Path(safe.name)/'no.env')
 os.environ['GUGU_CONFIG_OVERRIDE_FILE']=str(Path(safe.name)/'no-config.json')
 os.environ['STORAGE__LOCAL_PATH']=str(Path(safe.name)/'storage')
 from app.core import config,crypto,redis as redis_module
 from app.db import session as db_session
 from app.models import Base,User,UserBot,ConversationSession
 from app.services import im_identity
 mode,schema,owner_raw=sys.argv[1:4]
 assert schema.startswith('binding_main_') and schema.replace('_','').isalnum()
 owner=uuid.UUID(owner_raw)
 engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':schema}})
 session=async_sessionmaker(engine,expire_on_commit=False)
 db_session._engine=engine;db_session._SessionLocal=session;db_session._engine_loop=asyncio.get_running_loop()
 settings=config.AppSettings.model_construct(secret_key='synthetic-binding-secret',storage=config.StorageSettings(local_path=os.environ['STORAGE__LOCAL_PATH']))
 config.get_settings=lambda:settings
 crypto.get_settings=lambda:settings;im_identity.get_settings=lambda:settings
 redis=from_url(os.environ['GUGU_WEBUI_TEST_REDIS_URL'],decode_responses=True)
 redis_module.get_redis=lambda:redis
 try:
  if mode=='init':
   async with engine.begin() as conn:await conn.run_sync(Base.metadata.create_all)
   async with session() as db:
    other=uuid.UUID(sys.argv[4]);db.add_all([User(id=owner,username='小北',email='owner@example.test',hashed_password='x'),User(id=other,username='小南',email='other@example.test',hashed_password='x')]);await db.commit()
    bots=[UserBot(user_id=owner,platform='qq',app_secret='synthetic-secret'),UserBot(user_id=owner,platform='telegram',app_secret='synthetic-secret'),UserBot(user_id=other,platform='qq',app_secret='synthetic-secret')]
    db.add_all(bots);db.add(ConversationSession(user_id=owner,source='qq',context_epoch=3));await db.commit();print(json.dumps({'ids':[bot.id for bot in bots]}))
  elif mode=='consume':
   bot_id,platform,code=int(sys.argv[4]),sys.argv[5],sys.argv[6]
   consume=im_identity.consume_qq_binding_code if platform=='qq' else im_identity.consume_telegram_binding_code
   assert await consume(bot_id,owner,'synthetic-platform-owner',code) is True
   assert await consume(bot_id,owner,'synthetic-platform-owner',code) is (platform=='qq')
   async with session() as db:
    bot=await db.get(UserBot,bot_id);assert bot.owner_platform_user_id=='synthetic-platform-owner'
    epoch=await db.scalar(text('SELECT context_epoch FROM conversation_sessions WHERE user_id=:owner'),{'owner':owner});assert epoch>=4
   print(json.dumps({'consumed':True}))
 finally:await redis.aclose();await engine.dispose();safe.cleanup()

if __name__=='__main__':
 if len(sys.argv)<2 or sys.argv[1]!='--allow-isolated-test-database':
  raise SystemExit('此夹具默认拒绝连接数据库；仅隔离测试可显式启用')
 sys.argv.pop(1)
 asyncio.run(main())
