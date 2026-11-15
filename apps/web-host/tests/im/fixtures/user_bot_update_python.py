"""实际Python Bot更新handler差分；仅合成schema和临时配置，禁止外部发布。"""
import os,sys,re,json,asyncio
from uuid import uuid4
from datetime import timedelta
from types import SimpleNamespace
if sys.argv[1:]!=['--allow-isolated-test-update-reference'] or not re.fullmatch(r'bot_update_[a-f0-9]{32}',os.environ.get('TEST_SCHEMA','')):raise SystemExit('仅限隔离测试')
from sqlalchemy import select,func
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from fastapi import HTTPException
from app.models import User,UserBot,ConversationSession
from app.api.v1.user_bots import update_my_bot,BotUpdate
from app.core import events,crypto
from app.core.tz import now_utc
from app.db import session as database
from agent.context.session_snapshot import invalidate_user_im_snapshots
crypto.get_settings=lambda:SimpleNamespace(secret_key=os.environ['TEST_SECRET'])
async def main():
 engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}});factory=async_sessionmaker(engine,expire_on_commit=False);database.ensure_engine=lambda:None;database._SessionLocal=factory;owner=uuid4()
 try:
  async with factory() as db:
   user=User(id=owner,username='小星',email=f'{owner}@example.invalid',hashed_password='synthetic');db.add(user);await db.flush();bot=UserBot(user_id=owner,platform='qq',name='我的 QQ 机器人',app_id='old-app',app_secret='original-secret');db.add(bot)
   for i,source in enumerate(['web','qq','feishu','telegram','wechat']):db.add(ConversationSession(id=2001+i,user_id=owner,source=source,context_epoch=4,snapshot_hash='synthetic-snapshot',session_info_hash='synthetic-session',snapshot_expires_at=now_utc()+timedelta(days=1)))
   await db.commit();bot_id=bot.id
   async def publish(who,*resources,**kwargs):await invalidate_user_im_snapshots(who)
   events.publish=publish;result=[]
   for patch in json.load(sys.stdin):
    try:body=await update_my_bot(bot_id,BotUpdate(**patch),SimpleNamespace(id=owner),db);body.pop('id');status=200
    except HTTPException as error:await db.rollback();body={'detail':error.detail};status=error.status_code
    stored=await db.get(UserBot,bot_id);epoch=await db.scalar(select(func.min(ConversationSession.context_epoch)).where(ConversationSession.user_id==owner,ConversationSession.source!='web'))
    result.append({'status':status,'body':body,'version':stored.group_attention_config_version,'epoch':epoch})
   print(json.dumps(result,ensure_ascii=False))
 finally:await engine.dispose()
asyncio.run(main())
