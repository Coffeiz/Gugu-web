import os,uuid
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine,AsyncSession
pytest_plugins=['tests.conftest']
@pytest.mark.asyncio
async def test_summary_trends():
 from app.api.v1 import admin_analytics as module
 engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'))
 schema='analytics_ext_py_'+uuid.uuid4().hex
 try:
  async with engine.begin() as conn:
   await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
   await conn.execute(text(f'SET search_path TO "{schema}"'))
   await conn.exec_driver_sql('CREATE TABLE users(id int,is_developer boolean,created_at timestamptz,last_active_at timestamptz)')
   await conn.exec_driver_sql('CREATE TABLE frontend_events(user_id int,event text,properties jsonb,created_at timestamptz)')
   await conn.exec_driver_sql('CREATE TABLE conversation_sessions(id int,user_id int,source text)')
   await conn.exec_driver_sql('CREATE TABLE agent_usage(user_id int,is_byok boolean,created_at timestamptz,tokens_in bigint,tokens_out bigint,scenario text,input_source text,session_id int)')
   await conn.exec_driver_sql('CREATE TABLE projects(id int,user_id int,created_at timestamptz,updated_at timestamptz,done_at timestamptz,archived boolean,status text)')
   await conn.exec_driver_sql('CREATE TABLE onboarding_state(state jsonb)')
   await conn.exec_driver_sql('CREATE TABLE user_bots(user_id int,platform text,enabled boolean)')
   await conn.exec_driver_sql("INSERT INTO users VALUES(1,false,now()-interval '40 days',now()),(2,true,now(),now())")
   await conn.exec_driver_sql("INSERT INTO conversation_sessions VALUES(1,1,'qq')")
   await conn.exec_driver_sql("INSERT INTO agent_usage VALUES(1,false,now(),10,3,'chat',NULL,1),(2,false,now(),20,4,'chat','web',NULL)")
   await conn.exec_driver_sql("INSERT INTO user_bots VALUES(1,'qq',true)")
   await conn.exec_driver_sql("INSERT INTO projects VALUES(1,1,now(),now(),NULL,false,'active')")
   async with AsyncSession(bind=conn) as db:
    summary=await module.get_summary(exclude_dev=True,include_byok=False,timezone_name='UTC',db=db)
    assert summary['users']['total']==1 and summary['agent']['total_calls']==1 and summary['im_bots']['users_with_bot']==1
    trends=await module.get_trends(days=7,exclude_dev=True,include_byok=False,timezone_name='UTC',db=db)
    assert len(trends['labels'])==7 and trends['agent_calls'][-1]==1 and trends['agent_tokens'][-1]==13
    assert trends['interactions_by_source']['qq'][-1]==1 and trends['interactions_by_source']['web'][-1]==0
   await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
 finally: await engine.dispose()
