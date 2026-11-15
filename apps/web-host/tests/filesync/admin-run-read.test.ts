import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {createPostgresRuntime} from '@gugu/core/data'
import {createFileSyncRunReader} from '../../../../packages/core/src/filesync/read-runs.js'
import {registerAdminFileSyncRunReadRoutes} from '../../src/modules/filesync/admin-run-read.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('管理员文件同步任务正式PG模型和Python只读handler一致：筛选分页、微秒、404与白名单', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`sync_runs_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1}),runtime=await createPostgresRuntime({url:databaseUrl!,schema})
 const owner=randomUUID(),other=randomUUID(),first=randomUUID(),second=randomUUID()
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-sync-read-config',PYTHONPATH:'.',TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_RUN:first}
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE workspaces(id integer PRIMARY KEY)')
  await pool.query('INSERT INTO users VALUES($1),($2)',[owner,other])
  await pool.query(execFileSync(python!,['-c',"from app.models import FileSyncBinding,FileSyncReconcileRun; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [FileSyncBinding,FileSyncReconcileRun]))"],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  await pool.query("INSERT INTO file_sync_bindings(id,user_id,source,root_fingerprint,created_at,updated_at) VALUES(1,$1,'local_directory','private-root',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),(2,$2,'local_directory','private-root',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[owner,other])
  for(const [id,user,binding,date] of [[first,owner,1,'2026-11-15T01:00:00.123456Z'],[second,other,2,'2026-11-15T02:00:00.654321Z']])await pool.query("INSERT INTO file_sync_reconcile_runs(id,user_id,binding_id,action,status,stage,root_fingerprint,lease_owner,result_counts,error_code,created_at,updated_at,started_at) VALUES($1,$2,$3,'dry_run','succeeded','done','private-root','private-worker','{\"created\":2,\"rootDevice\":7}'::json,'scan_failed',$4,$4,$4)",[id,user,binding,date])
  const reader=createFileSyncRunReader(runtime.db)
  const all=await reader.list({}),filtered=await reader.list({userId:owner,bindingId:1,limit:1})
  assert.equal(all.length,2);assert.equal(all[0]!.id,second);assert.equal(filtered.length,1);assert.equal(filtered[0]!.id,first)
  assert.deepEqual(await reader.get(first),filtered[0]);assert.doesNotMatch(JSON.stringify(all),/private-root|private-worker|user_id|root_fingerprint/)
  assert.equal(filtered[0]!.createdAt,'2026-11-15T01:00:00.123456+00:00')
  await assert.rejects(()=>reader.get(randomUUID()),/对账任务不存在/)
  const script="import asyncio,json,os; from uuid import UUID; from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker; from app.api.v1.filesync_admin import runs,run_status\nasync def scenario():\n engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}})\n try:\n  async with async_sessionmaker(engine)() as db: print(json.dumps({'all':await runs(user_id=None,binding_id=None,limit=50,db=db),'filtered':await runs(user_id=UUID(os.environ['TEST_OWNER']),binding_id=1,limit=1,db=db),'one':await run_status(UUID(os.environ['TEST_RUN']),db=db)}))\n finally: await engine.dispose()\nasyncio.run(scenario())"
  const reference=JSON.parse(execFileSync(python!,['-c',script],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  assert.deepEqual(all,reference.all);assert.deepEqual(filtered,reference.filtered);assert.deepEqual(await reader.get(first),reference.one)
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

test('管理员任务只读路由认证及Python参数422；未授权不读取数据库',async()=>{
 const app=Fastify();installHttpErrorHandler(app);let calls=0
 const id=randomUUID(),owner=randomUUID()
 registerAdminFileSyncRunReadRoutes(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(request.headers.authorization?403:401).send({detail:'拒绝访问'})},reader:{list:async query=>{calls++;assert.deepEqual(query,{userId:owner,bindingId:2,limit:3});return []},get:async key=>{calls++;assert.equal(key,id);return {id} as never}}})
 try{
  const url='/api/v1/admin/filesync/runs',headers={authorization:'admin'}
  assert.equal((await app.inject(url)).statusCode,401);assert.equal((await app.inject({url,headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  for(const query of ['?limit=0','?limit=101','?limit=bad','?user_id=bad','?binding_id=bad'])assert.equal((await app.inject({url:url+query,headers})).statusCode,422)
  assert.equal((await app.inject({url:url+'/bad',headers})).statusCode,422)
  assert.deepEqual((await app.inject({url:url+`?user_id=${owner}&binding_id=2&limit=3`,headers})).json(),[])
  assert.deepEqual((await app.inject({url:url+'/'+id,headers})).json(),{id});assert.equal(calls,2)
 }finally{await app.close()}
})
