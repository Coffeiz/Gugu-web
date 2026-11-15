"""导出预览实际handler基线；只允许随机schema和合成模型数据。"""
import os,sys,json,asyncio
from pathlib import Path
from uuid import UUID
from types import SimpleNamespace
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from app.db.base import Base
from app.models import *
from app.api.v1.data_portability import export_preview
path=Path(os.environ['GUGU_CONFIG_OVERRIDE_FILE']).resolve()
if not path.parent.name.startswith('export-preview-') or not os.environ['TEST_SCHEMA'].startswith('export_preview_'):raise SystemExit('拒绝非隔离预览测试')
async def main():
 engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}});factory=async_sessionmaker(engine,expire_on_commit=False)
 owner,other=UUID(os.environ['TEST_OWNER']),UUID(os.environ['TEST_OTHER'])
 try:
  if sys.argv[1]=='setup':
   async with engine.begin() as c:await c.run_sync(Base.metadata.create_all)
   async with factory() as d:
    for index,uid in enumerate([owner,other]):
     d.add(User(id=uid,username=f'合成用户{index}',email=f'preview-{index}@example.test',hashed_password='synthetic'));await d.flush()
     project=Project(user_id=uid,name='项目');client=Client(user_id=uid,name='联系人');directory=WorkspaceDirectory(user_id=uid,name='目录',directory_name=f'synthetic-{index}');folder=Folder(user_id=uid,name='文件夹');canvas=MindMap(user_id=uid,title='画布');node=MindNode(user_id=uid);target=MindNode(user_id=uid);session=ConversationSession(user_id=uid,title='会话');bot=UserBot(user_id=uid,platform='qq',app_secret='synthetic')
     d.add_all([project,client,directory,folder,canvas,node,target,session,bot]);await d.flush()
     message=ConversationMessage(session_id=session.id,conversation_seq=1,role='user',content='合成消息');d.add(message);await d.flush()
     entry=MemoryEntry(owner_user_id=uid,platform='qq',bot_id=str(bot.id),scope_type='owner',scope_id='synthetic',entry_key='synthetic',kind='fact',content_hash='synthetic');d.add(entry);await d.flush()
     d.add_all([UserPreferences(user_id=uid,data_json='{}'),File(user_id=uid,display_name='文件',ext='txt',storage_key=f'{uid}/synthetic-file',size_bytes=42,deleted_at=__import__('datetime').datetime.now(__import__('datetime').timezone.utc)),MindCanvasItem(user_id=uid,canvas_id=canvas.id,node_id=node.id),MindRelation(user_id=uid,src_node_id=node.id,dst_node_id=target.id),CalendarEvent(user_id=uid,title='日历',date='2030-01-02'),Workspace(user_id=uid,name='工作区'),ConversationBatch(session_id=session.id,digest='synthetic'),UserSkill(owner_id=uid,skill_id=f'synthetic-{index}',name='技能',description_short='说明',body='内容',content_digest='synthetic'),Feedback(user_id=uid,username='合成用户',category='other',content='合成反馈'),ScheduledTask(user_id=uid,name='定时任务',cron='0 9 * * *'),ConversationPendingQueue(user_id=uid,queue_id=f'synthetic-{index}',session_id=session.id,items=[{'attachments':[{'attach_id':f'draft-{index}'},{'attach_id':f'draft-{index}'}]}]),MemorySource(entry_id=entry.id,message_id=message.id),ChatAttachment(attach_id=f'attached-{index}',user_id=uid,message_id=message.id,storage_key=f'{uid}/synthetic-attach',state='attached',size=3),ChatAttachment(attach_id=f'draft-{index}',user_id=uid,storage_key=f'{uid}/synthetic-draft',state='draft',size=5),ChatAttachment(attach_id=f'orphan-{index}',user_id=uid,storage_key=f'{uid}/synthetic-orphan',state='draft',size=999),UserProviderCredential(user_id=uid,provider='openai',capability='chat',encrypted_value='synthetic',nonce='synthetic',encrypted_data_key='synthetic'),UserSmtpConfig(user_id=uid,host='smtp.example.test'),UserMcpServer(user_id=uid,name='连接',endpoint='https://example.test/mcp')]);await d.flush()
    await d.commit()
   print('{}');return
  if sys.argv[1]=='large':
   from sqlalchemy import select
   async with factory() as d:
    msg=(await d.execute(select(ConversationMessage).join(ConversationSession,ConversationMessage.session_id==ConversationSession.id).where(ConversationSession.user_id==owner))).scalars().first()
    d.add_all([ChatAttachment(attach_id=f'page-orphan-{n}',user_id=owner,storage_key=f'{owner}/synthetic-page-{n}',state='draft',size=999) for n in range(510)])
    d.add(ChatAttachment(attach_id='page-tail',user_id=owner,message_id=msg.id,storage_key=f'{owner}/synthetic-tail',state='attached',size=7));await d.commit();print('{}');return
  if sys.argv[1]=='cross':
   from sqlalchemy import select
   async with factory() as d:
    msg=(await d.execute(select(ConversationMessage).join(ConversationSession,ConversationMessage.session_id==ConversationSession.id).where(ConversationSession.user_id==other))).scalars().first();entry=(await d.execute(select(MemoryEntry).where(MemoryEntry.owner_user_id==owner))).scalars().first()
    d.add_all([ChatAttachment(attach_id='cross-owner-upload',user_id=owner,message_id=msg.id,storage_key='synthetic-cross',state='attached',size=444),MemorySource(entry_id=entry.id,message_id=msg.id)]);await d.commit();print('{}');return
  async with factory() as d:
   print(json.dumps(await export_preview(SimpleNamespace(id=owner),d),ensure_ascii=False))
 finally:await engine.dispose()
asyncio.run(main())
