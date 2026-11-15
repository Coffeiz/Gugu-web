import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {createPostgresRuntime} from '@gugu/core/data'
import {createFileSyncRunCancellation} from '@gugu/core/filesync-run-cancel'
import {registerAdminFileSyncRunCancelRoute} from '../../src/modules/filesync/admin-run-cancel.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('管理员取消正式PG任务：提交后通知、幂等并发、失败不误发和Python消费者', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`sync_cancel_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:3}),runtime=await createPostgresRuntime({url:databaseUrl!,schema}),owner=randomUUID()
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-sync-cancel-config',PYTHONPATH:'.',TEST_SCHEMA:schema}
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY);CREATE TABLE workspaces(id integer PRIMARY KEY)');await pool.query('INSERT INTO users VALUES($1)',[owner])
  await pool.query(execFileSync(python!,['-c',"from app.models import FileSyncBinding,FileSyncReconcileRun; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [FileSyncBinding,FileSyncReconcileRun]))"],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  await pool.query("INSERT INTO file_sync_bindings(id,user_id,source,root_fingerprint,created_at,updated_at) VALUES(1,$1,'local_directory','synthetic-root',clock_timestamp(),clock_timestamp())",[owner])
  const ids=new Map<string,string>()
  for(const status of ['queued','running','cancelling','succeeded','failed','cancelled']){const id=randomUUID();ids.set(status,id);await pool.query("INSERT INTO file_sync_reconcile_runs(id,user_id,binding_id,action,status,stage,root_fingerprint,lease_owner,revision,created_at,updated_at) VALUES($1,$2,1,'dry_run',$3,'scanning','synthetic-root','synthetic-worker',3,clock_timestamp(),clock_timestamp())",[id,owner,status])}
  const events:Array<{runId:string;bindingId:number;revision:number}>=[]
  const cancel=createFileSyncRunCancellation(runtime.db,async event=>{const saved=(await pool.query('SELECT revision FROM file_sync_reconcile_runs WHERE id=$1',[event.runId])).rows[0];assert.ok(saved);assert.ok(saved.revision>=event.revision);events.push(event)})
  await assert.rejects(()=>cancel(randomUUID()),/对账任务不存在/);assert.equal(events.length,0)
  const concurrent=await Promise.all([cancel(ids.get('queued')!),cancel(ids.get('queued')!)])
  for(const result of concurrent){assert.equal(result.status,'cancelled');assert.equal(result.stage,'cancelled');assert.equal(result.revision,4);assert.equal(result.cancelRequested,false);assert.ok(result.finishedAt)}
  const running=await cancel(ids.get('running')!);assert.equal(running.status,'cancelling');assert.equal(running.revision,4);assert.equal(running.cancelRequested,true);assert.equal(running.finishedAt,null)
  for(const state of ['cancelling','succeeded','failed','cancelled']){const result=await cancel(ids.get(state)!);assert.equal(result.status,state);assert.equal(result.revision,3)}
  assert.equal(events.length,7)
  const failed=randomUUID();await pool.query("INSERT INTO file_sync_reconcile_runs(id,user_id,binding_id,action,status,root_fingerprint,created_at,updated_at) VALUES($1,$2,1,'dry_run','queued','synthetic-root',clock_timestamp(),clock_timestamp())",[failed,owner])
  await pool.query(`CREATE FUNCTION fail_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${failed}' THEN RAISE EXCEPTION 'synthetic cancellation failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_cancel BEFORE UPDATE ON file_sync_reconcile_runs FOR EACH ROW EXECUTE FUNCTION fail_cancel()`)
  await assert.rejects(()=>cancel(failed));assert.equal(events.length,7);assert.equal((await pool.query('SELECT status FROM file_sync_reconcile_runs WHERE id=$1',[failed])).rows[0].status,'queued')
  const brokenPublisher=createFileSyncRunCancellation(runtime.db,async()=>{throw new Error('synthetic Redis failure')})
  assert.equal((await brokenPublisher(ids.get('cancelled')!)).status,'cancelled')
  const script="import asyncio,json,os; from uuid import UUID; from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker; from app.services.filesync import jobs\nasync def scenario():\n engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}})\n async def notify(*args,**kwargs): pass\n jobs.notify_run_changed=notify\n try:\n  async with async_sessionmaker(engine)() as db:\n   requested=await jobs.cancellation_requested(db,UUID(os.environ['TEST_RUN']),'synthetic-worker')\n   wrong=await jobs.cancellation_requested(db,UUID(os.environ['TEST_RUN']),'another-worker')\n   finished=await jobs.finish_run(db,UUID(os.environ['TEST_RUN']),'synthetic-worker',status='succeeded')\n   row=await jobs.get_reconcile_run(db,UUID(os.environ['TEST_RUN']))\n   print(json.dumps({'requested':requested,'wrong':wrong,'finished':finished,'status':row.status,'lease':row.lease_owner}))\n finally: await engine.dispose()\nasyncio.run(scenario())"
  const consumed=JSON.parse(execFileSync(python!,['-c',script],{encoding:'utf8',cwd:resolve('../../backend'),env:{...env,TEST_RUN:ids.get('running')!}}))
  assert.deepEqual(consumed,{requested:true,wrong:false,finished:true,status:'cancelled',lease:null})
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

test('取消管理员鉴权在用例之前，UUID 422，跨owner任务由管理员合法处理',async()=>{
 const app=Fastify(),id=randomUUID();let calls=0
 registerAdminFileSyncRunCancelRoute(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(request.headers.authorization?403:401).send({detail:'拒绝访问'})},cancel:async run=>{calls++;assert.equal(run,id);return {id} as never}})
 try{
  const path=`/api/v1/admin/filesync/runs/${id}/cancel`,headers={authorization:'admin'}
  assert.equal((await app.inject({method:'POST',url:path})).statusCode,401);assert.equal((await app.inject({method:'POST',url:path,headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/filesync/runs/bad/cancel',headers})).statusCode,422)
  assert.deepEqual((await app.inject({method:'POST',url:path,headers})).json(),{id});assert.equal(calls,1)
 }finally{await app.close()}
})
