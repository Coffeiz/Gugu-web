import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {createDataImportResumer} from '@gugu/core/data-portability/resume-import'
import {registerDataImportResumeRoute} from '../../src/modules/data-portability/resume-import.js'
import {withPostgresTransaction} from '../../src/adapters/postgres-transaction.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')

test('预检恢复真实PG轮换/并发/回滚，Python apply拒绝旧token并验证消费新token', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`resume_import_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:4}),owner=randomUUID(),other=randomUUID(),job=randomUUID(),oldToken=randomBytes(32).toString('base64url')
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-resume-import-config',PYTHONPATH:'.',TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_JOB:job}
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)');await pool.query('INSERT INTO users VALUES($1),($2)',[owner,other])
  await pool.query(execFileSync(python!,['-c',"from app.models import DataImportJob,DataExportJob; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [DataImportJob,DataExportJob]))"],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  const insert=async(id:string)=>pool.query("INSERT INTO data_import_jobs(id,user_id,mode,status,stage,staging_key,import_token_hash,preview,progress_current,created_at,expires_at,updated_at) VALUES($1,$2,'preflight','preview_ready','preview_ready','synthetic-encrypted-staging',$3,'{\"complete\":true,\"conflicts\":{\"total\":0}}'::json,0,'2026-11-15T01:00:00.123456Z',clock_timestamp()+interval '1 hour',clock_timestamp())",[id,owner,hash(oldToken)])
  await insert(job)
  const resume=createDataImportResumer(work=>withPostgresTransaction(pool,client=>work((sql,values)=>client.query(sql,values))),(sql,values)=>pool.query(sql,values),{token:()=>randomBytes(32).toString('base64url'),hash})
  await assert.rejects(()=>resume(other,job),/找不到此导入任务/)
  const result=await resume(owner,job)
  assert.match(result.import_token,/^[A-Za-z0-9_-]{43}$/);assert.notEqual(result.import_token,oldToken)
  assert.equal(result.status,'preview_ready');assert.equal(result.created_at,'2026-11-15T01:00:00.123456+00:00')
  assert.doesNotMatch(JSON.stringify(result),/staging_key|import_token_hash|synthetic-encrypted/)
  assert.equal((await pool.query('SELECT import_token_hash FROM data_import_jobs WHERE id=$1',[job])).rows[0].import_token_hash,hash(result.import_token))
  const concurrent=await Promise.all([resume(owner,job),resume(owner,job)])
  const currentHash=(await pool.query('SELECT import_token_hash FROM data_import_jobs WHERE id=$1',[job])).rows[0].import_token_hash
  assert.notEqual(concurrent[0]!.import_token,concurrent[1]!.import_token)
  assert.equal(concurrent.filter(value=>hash(value.import_token)===currentHash).length,1)
  const current=concurrent.find(value=>hash(value.import_token)===currentHash)!
  for(const change of ["mode='incremental'","status='queued'","staging_key=NULL","preview='{}'::json","expires_at=NULL","expires_at=clock_timestamp()-interval '1 second'"]){
   const invalid=randomUUID();await insert(invalid);await pool.query(`UPDATE data_import_jobs SET ${change} WHERE id=$1`,[invalid]);await assert.rejects(()=>resume(owner,invalid),/此预检任务已过期或不能继续/)
   assert.equal((await pool.query('SELECT import_token_hash FROM data_import_jobs WHERE id=$1',[invalid])).rows[0].import_token_hash,hash(oldToken));await pool.query('DELETE FROM data_import_jobs WHERE id=$1',[invalid])
  }
  const rollback=randomUUID();await insert(rollback)
  await pool.query(`CREATE FUNCTION fail_resume() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${rollback}' THEN RAISE EXCEPTION 'synthetic update failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_resume BEFORE UPDATE ON data_import_jobs FOR EACH ROW EXECUTE FUNCTION fail_resume()`)
  await assert.rejects(()=>resume(owner,rollback));assert.equal((await pool.query('SELECT import_token_hash FROM data_import_jobs WHERE id=$1',[rollback])).rows[0].import_token_hash,hash(oldToken))
  const script="import asyncio,json,os; from uuid import UUID; from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker; from app.services.data_portability.api_jobs import apply_import_job,PortabilityJobError; from app.api.v1.data_portability import _import_view\nasync def scenario():\n engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}})\n try:\n  async with async_sessionmaker(engine)() as db:\n   try: await apply_import_job(db,user_id=UUID(os.environ['TEST_OWNER']),job_id=UUID(os.environ['TEST_JOB']),mode='incremental',import_token=os.environ['OLD_TOKEN'],idempotency_key='synthetic-apply-key')\n   except PortabilityJobError as error: rejected=error.status_code\n   row=await apply_import_job(db,user_id=UUID(os.environ['TEST_OWNER']),job_id=UUID(os.environ['TEST_JOB']),mode='incremental',import_token=os.environ['NEW_TOKEN'],idempotency_key='synthetic-apply-key')\n   print(json.dumps({'rejected':rejected,'status':row.status,'mode':row.mode,'hash':row.import_token_hash}))\n finally: await engine.dispose()\nasyncio.run(scenario())"
  const applied=JSON.parse(execFileSync(python!,['-c',script],{encoding:'utf8',cwd:resolve('../../backend'),env:{...env,OLD_TOKEN:oldToken,NEW_TOKEN:current.import_token}}))
  assert.deepEqual(applied,{rejected:403,status:'queued',mode:'incremental',hash:null})
  assert.equal((await pool.query('SELECT staging_key FROM data_import_jobs WHERE id=$1',[job])).rows[0].staging_key,'synthetic-encrypted-staging')
  await assert.rejects(()=>resume(owner,job),/此预检任务已过期或不能继续/)
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

test('恢复HTTP仅认证owner并成功no-store，不把token写入列表或错误',async()=>{
 const app=Fastify(),owner=randomUUID(),job=randomUUID();let calls=0
 registerDataImportResumeRoute(app,request=>{if(request.headers.authorization!=='user')throw Object.assign(new Error('未认证'),{statusCode:401});return {id:owner} as never},async(user,id)=>{calls++;assert.equal(user,owner);assert.equal(id,job);return {id:job,import_token:'synthetic-new-token'} as never})
 try{
  const path=`/api/v1/data-portability/imports/${job}/resume`,headers={authorization:'user'}
  assert.equal((await app.inject({method:'POST',url:path})).statusCode,401);assert.equal(calls,0)
  assert.equal((await app.inject({method:'POST',url:'/api/v1/data-portability/imports/bad/resume',headers})).statusCode,422)
  const result=await app.inject({method:'POST',url:path+'?user_id=foreign',headers});assert.equal(result.statusCode,200);assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.json().import_token,'synthetic-new-token');assert.equal(calls,1)
 }finally{await app.close()}
})
