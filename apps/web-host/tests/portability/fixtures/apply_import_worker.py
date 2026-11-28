"""Node确认后由正式Python Worker消费；全部表、对象、存储均显式隔离。"""
import os,sys,json,re,asyncio,hashlib,importlib.util
from pathlib import Path
from uuid import UUID
from datetime import datetime,timedelta,timezone
from urllib.parse import urlparse
if len(sys.argv)<4 or sys.argv[1] not in {'--prepare-isolated','--consume-isolated'}:raise SystemExit('仅限隔离测试')
mode,root_arg,schema=sys.argv[1:4];root=Path(root_arg).resolve()
if root.parent!=Path('/tmp') or not root.name.startswith('apply-main-') or not re.fullmatch(r'apply_main_[a-f0-9]{32}',schema):raise SystemExit('拒绝非测试目录/schema')
url=os.environ['GUGU_WEBUI_TEST_DATABASE_URL'];parsed=urlparse(url)
if parsed.hostname not in {'127.0.0.1','localhost'}:raise SystemExit('拒绝非隔离数据库')
os.environ.update(GUGU_ENV_FILE=str(root/'no.env'),GUGU_CONFIG_OVERRIDE_FILE=str(root/'override.json'),STORAGE__LOCAL_PATH=str(root/'storage'),SECRET_KEY='synthetic-apply-worker-secret',REDIS__HOST='127.0.0.1',REDIS__PORT='1')
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from app.models import Base,User,Project,File,DataImportJob
from app.services.storage import get_storage
from app.services.data_portability.jobs import claim_next_job
from app.services.data_portability import worker
from app.db import session as db_session
engine=create_async_engine(url.replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':schema,'jit':'off'}})
factory=async_sessionmaker(engine,expire_on_commit=False);db_session._SessionLocal=factory;db_session._engine=engine
async def main():
 try:
  if mode=='--prepare-isolated':
   async with engine.begin() as connection:await connection.run_sync(Base.metadata.create_all)
   spec=importlib.util.spec_from_file_location('baseline_archive',Path.cwd()/'tests/storage/data_portability/test_data_portability_replace_worker.py');baseline=importlib.util.module_from_spec(spec);spec.loader.exec_module(baseline)
   async with factory() as db:
    owner=User(username='synthetic-owner',email='owner@example.invalid',hashed_password='synthetic-hash');other=User(username='synthetic-other',email='other@example.invalid',hashed_password='synthetic-hash');db.add_all([owner,other]);await db.commit()
    db.add_all([Project(user_id=owner.id,name='初始项目',status='active'),Project(user_id=other.id,name='其他用户项目',status='active')]);await db.commit()
    result={'owner':str(owner.id),'other':str(other.id),'jobs':{}}
    token='synthetic-import-confirmation-token-1234567890'
    for target,label in [('incremental','增量导入项目'),('replace','替换导入项目')]:
     row=DataImportJob(user_id=owner.id,mode='preflight',status='preview_ready',stage='preview_ready',preview={'complete':True,'conflicts':{'total':0}},import_token_hash=hashlib.sha256(token.encode()).hexdigest(),expires_at=datetime.now(timezone.utc)+timedelta(hours=1));db.add(row);await db.commit()
     row.staging_key,row.archive_sha256=await baseline._source_archive(owner.id,row.id,label,get_storage());await db.commit();result['jobs'][target]=str(row.id)
    (root/'prepared.json').write_text(json.dumps(result));print(json.dumps(result))
  else:
   target=sys.argv[4];assert target in {'incremental','replace','rollback'};prepared=json.loads((root/'prepared.json').read_text());owner=UUID(prepared['owner']);other=UUID(prepared['other'])
   async with factory() as db:claimed=await claim_next_job(db,'synthetic-import-worker',include_imports=True)
   assert claimed and str(claimed.job_id)==(sys.argv[5] if target=='rollback' else prepared['jobs'][target]) and claimed.mode==target
   await (worker.process_incremental_import if target=='incremental' else worker.process_replace_import)(claimed,worker_id='synthetic-import-worker',session_factory=factory)
   async with factory() as db:
    row=await db.get(DataImportJob,claimed.job_id);assert row.status==('rolled_back' if target=='rollback' else 'completed'),(row.status,row.stage,row.error_code)
    names=list((await db.scalars(select(Project.name).where(Project.user_id==owner).order_by(Project.name))).all());foreign=list((await db.scalars(select(Project.name).where(Project.user_id==other))).all());assert foreign==['其他用户项目']
    assert set(names)==({'替换导入项目'} if target=='replace' else {'初始项目','增量导入项目'}),names
    if target=='replace':assert row.rollback_key and await get_storage().exists(row.rollback_key)
    files=list((await db.scalars(select(File).where(File.user_id==owner))).all());assert len(files)==1;assert await get_storage().get(files[0].storage_key)==b'data'
    if target=='rollback':assert (await db.get(DataImportJob,UUID(prepared['jobs']['replace']))).status=='rolled_back'
    print(json.dumps({'mode':target,'status':row.status,'names':names,'foreign':foreign,'rollback':bool(row.rollback_key)},ensure_ascii=False))
 finally:await engine.dispose()
asyncio.run(main())
