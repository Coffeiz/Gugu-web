"""仅在调用方提供的隔离 schema 内构造正式模型并调用原 BYOK handler。"""
import asyncio, json, os
from uuid import UUID
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.db.base import Base
from app.models import User, UserProviderCredential
from app.byok.service import decrypt_value
from sqlalchemy import select
from app.api.v1 import byok
from app.byok.schemas import CredentialCreate

async def main():
    engine=create_async_engine(os.environ['BYOK_TEST_PG'],connect_args={'server_settings':{'search_path':os.environ['BYOK_TEST_SCHEMA']}})
    if os.environ.get('BYOK_TEST_VERIFY'):
        sessions=async_sessionmaker(engine,expire_on_commit=False)
        async with sessions() as db:
            row=await db.scalar(select(UserProviderCredential).where(UserProviderCredential.user_id==UUID('00000000-0000-4000-8000-000000000072')).order_by(UserProviderCredential.id.desc()))
            print(json.dumps({'value':decrypt_value(row)}))
        await engine.dispose()
        return
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions=async_sessionmaker(engine,expire_on_commit=False)
    byok._gate=lambda:None
    async with sessions() as db:
        a=User(id=UUID('00000000-0000-4000-8000-000000000071'),username='synthetic_a',email='a@example.test',hashed_password='x')
        b=User(id=UUID('00000000-0000-4000-8000-000000000072'),username='synthetic_b',email='b@example.test',hashed_password='x')
        db.add_all([a,b]);await db.commit()
        result=await byok.create_credential(CredentialCreate(provider='local',capability='embedding',value='',dimensions=32),user=a,db=db)
        print(json.dumps(result,default=str))
    await engine.dispose()

asyncio.run(main())
