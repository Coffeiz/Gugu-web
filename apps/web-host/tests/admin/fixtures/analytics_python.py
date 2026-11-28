import os
import uuid
from datetime import datetime, timezone
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
pytest_plugins=['tests.conftest']

@pytest.mark.asyncio
async def test_analytics_slices(monkeypatch):
    from app.api.v1 import admin_analytics as module
    url=os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://')
    engine=create_async_engine(url)
    schema='analytics_py_'+uuid.uuid4().hex
    try:
        async with engine.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            await connection.execute(text(f'SET search_path TO "{schema}"'))
            for sql in ['CREATE TABLE users(id int PRIMARY KEY,is_developer boolean)','CREATE TABLE conversation_sessions(id int,user_id int)','CREATE TABLE conversation_messages(session_id int,role text)','CREATE TABLE frontend_events(user_id int,event text,properties jsonb)','CREATE TABLE agent_usage(user_id int,is_byok boolean,tools_used jsonb,created_at timestamptz)','CREATE TABLE projects(user_id int,updated_at timestamptz)','CREATE TABLE calendar_events(user_id int,created_at timestamptz)','CREATE TABLE files(user_id int,updated_at timestamptz,deleted_at timestamptz)','CREATE TABLE scheduled_tasks(user_id int,last_run_at timestamptz)',"INSERT INTO users VALUES(1,false),(2,true)","INSERT INTO conversation_sessions VALUES(1,1),(2,1),(3,2)","INSERT INTO conversation_messages VALUES(1,'user'),(2,'user'),(2,'user'),(2,'assistant'),(3,'user')","INSERT INTO frontend_events VALUES(1,'chat_open','{}'),(1,'chat_message','{\"turn\":3}'),(2,'chat_expanded','{}')","INSERT INTO agent_usage VALUES(1,false,'[\"read\",\"read\",\"write\"]','2026-11-14'),(2,false,'[\"read\"]','2026-11-14')"]:
                await connection.exec_driver_sql(sql)
            async with AsyncSession(bind=connection) as db:
                depth=await module.get_session_depth(exclude_dev=True,db=db)
                assert depth['total_users']==1 and depth['buckets'][1]['users']==1
                assert await module.get_chat_funnel(exclude_dev=True,db=db)==dict(chat_opened=1,chat_msg_1=1,chat_msg_3=1,chat_expanded=0)
                assert await module.get_tool_distribution(exclude_dev=True,include_byok=False,db=db)==[dict(tool='read',calls=2),dict(tool='write',calls=1)]
                monkeypatch.setattr(module,'now_utc',lambda:datetime(2026,11,15,tzinfo=timezone.utc))
                active=await module.get_active_dimensions(exclude_dev=True,include_byok=False,db=db)
                assert [row['users'] for row in active['dimensions']]==[1,0,0,0,0]
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    finally:
        await engine.dispose()
