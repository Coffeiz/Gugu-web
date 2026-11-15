import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {createPostgresRuntime} from '@gugu/core/data'
import {createFileSyncDryRun} from '@gugu/core/filesync-dry-run'
import {registerAdminFileSyncDryRunRoute} from '../../src/modules/filesync/admin-dry-run.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('Node dry-run幂等入正式任务表后由真实Python runner完成，只报告计划不写业务或修改源文件', {skip:(!databaseUrl||!redisUrl||!python)&&'需要隔离PG/Redis与显式Python'},async()=>{
 const schema=`dry_run_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-dry-run-')),owner=randomUUID()
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:2}),runtime=await createPostgresRuntime({url:databaseUrl!,schema}),storage=join(root,'storage'),override=join(root,'config.json')
 await writeFile(override,JSON.stringify({storage:{backend:'local',local_path:storage},filesync:{enabled:true}}))
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:override,PYTHONPATH:'.',TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_STORAGE:storage}
 const bridge=(action:string,extra:Record<string,string>={})=>JSON.parse(execFileSync(python!,[resolve('../../compat/support/filesync_dry_run.py'),action],{encoding:'utf8',cwd:resolve('../../backend'),env:{...env,...extra},timeout:30000}))
 try{
  const baseline=bridge('setup'),events:Array<{runId:string;bindingId:number;revision:number}>=[]
  const create=createFileSyncDryRun(runtime.db,randomUUID,async event=>{assert.equal((await pool.query('SELECT count(*)::int AS n FROM file_sync_reconcile_runs WHERE id=$1',[event.runId])).rows[0].n,1);events.push(event)})
  const [first,second]=await Promise.all([create(1),create(1)])
  assert.equal(first.id,second.id);assert.equal(first.status,'queued');assert.equal(first.action,'dry_run');assert.equal(first.allowDelete,false);assert.deepEqual(first.resultCounts,baseline.counts);assert.equal(events.length,2)
  const saved=(await pool.query('SELECT user_id,binding_revision,gap_revision,root_fingerprint FROM file_sync_reconcile_runs WHERE id=$1',[first.id])).rows[0]
  assert.deepEqual(saved,{user_id:owner,binding_revision:3,gap_revision:7,root_fingerprint:baseline.fingerprint})
  await assert.rejects(()=>create(999),/同步绑定不存在/);assert.equal(events.length,2)
  for(const [id,mode,status,source] of [[2,'mirror_out','active','local_directory'],[3,'bidirectional','inactive','local_directory'],[4,'bidirectional','active','other']] as const){await pool.query("INSERT INTO file_sync_bindings(id,user_id,source,mode,status,root_path,root_fingerprint,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'.','synthetic',clock_timestamp(),clock_timestamp())",[id,owner,source,mode,status]);await assert.rejects(()=>create(id),id===2?/任务类型与同步方向不匹配/:/同步绑定不存在/)}
  await pool.query("INSERT INTO file_sync_bindings(id,user_id,source,mode,status,root_path,root_fingerprint,created_at,updated_at) VALUES(5,$1,'local_directory','bidirectional','active','.','synthetic',clock_timestamp(),clock_timestamp())",[owner])
  await pool.query("CREATE FUNCTION fail_dry_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.binding_id=5 THEN RAISE EXCEPTION 'synthetic task failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_dry_run BEFORE INSERT ON file_sync_reconcile_runs FOR EACH ROW EXECUTE FUNCTION fail_dry_run()")
  const beforeFailure=events.length;await assert.rejects(()=>create(5));assert.equal(events.length,beforeFailure);assert.equal((await pool.query('SELECT count(*)::int AS n FROM file_sync_reconcile_runs WHERE binding_id=5')).rows[0].n,0)
  const consumed=bridge('consume',{TEST_RUN:first.id})
  assert.equal(consumed.status,'succeeded',JSON.stringify(consumed));assert.equal(consumed.error_code,null);assert.equal(consumed.allow_delete,false);assert.equal(consumed.files_unchanged,true)
  assert.equal(consumed.counts.plannedCreated,2);assert.equal(consumed.counts.created,0);assert.deepEqual(Object.values(consumed.business),[0,0,0,0,0])
  const next=await create(1);assert.notEqual(next.id,first.id)
  await pool.query("UPDATE file_sync_reconcile_runs SET action='repair' WHERE id=$1",[next.id]);await assert.rejects(()=>create(1),/该同步绑定已有未完成任务/)
  for(const status of ['running','cancelling']){await pool.query('UPDATE file_sync_reconcile_runs SET status=$2 WHERE id=$1',[next.id,status]);await assert.rejects(()=>create(1),/该同步绑定已有未完成任务/)}
  await pool.query("UPDATE file_sync_reconcile_runs SET status='queued',action='dry_run',allow_delete=true WHERE id=$1",[next.id]);await assert.rejects(()=>create(1),/该同步绑定已有未完成任务/)

 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})

test('dry-run管理员权限与绑定ID参数先于业务，忽略调用方伪造删除许可',async()=>{
 const app=Fastify();let calls=0
 registerAdminFileSyncDryRunRoute(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(request.headers.authorization?403:401).send({detail:'拒绝访问'})},create:async id=>{calls++;assert.equal(id,1);return {id:'synthetic-run',allowDelete:false} as never}})
 try{
  const url='/api/v1/admin/filesync/bindings/1/dry-run',headers={authorization:'admin'}
  assert.equal((await app.inject({method:'POST',url})).statusCode,401);assert.equal((await app.inject({method:'POST',url,headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/filesync/bindings/bad/dry-run',headers})).statusCode,422)
  assert.deepEqual((await app.inject({method:'POST',url,headers,payload:{allow_delete:true}})).json(),{id:'synthetic-run',allowDelete:false});assert.equal(calls,1)
 }finally{await app.close()}
})
