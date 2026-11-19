import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import {createTaskFilesystemAuthorization} from '@gugu/core/scheduled-task-filesystem-authorize'
import {createFilesystemAuthorizationConfirmationStore} from '../../src/modules/agent-sessions/filesystem-authorization-confirmations.js'
import {createRedisFilesystemAuthorizationCommands} from '../../src/adapters/cache/redis-events.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL

test('任务授权真实确认码绑定owner/任务且一次消费，授予事务审计、并发及热关闭保护', {skip:(!databaseUrl||!redisUrl)&&'需要隔离PostgreSQL/Redis'},async()=>{
 const owner=randomUUID(),foreign=randomUUID(),schema=`task_authorize_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1}),runtime=await createPostgresRuntime({url:databaseUrl!,schema})
 const redis=createRedisFilesystemAuthorizationCommands(redisUrl!),confirmations=createFilesystemAuthorizationConfirmationStore(redis)
 let enabled=true;const metrics:string[]=[]
 try{
  await pool.query('CREATE TABLE scheduled_tasks(id integer PRIMARY KEY,user_id uuid,event_id integer,name text,enabled boolean,filesystem_authorization_grant_id integer,updated_at timestamptz)')
  await pool.query('CREATE TABLE filesystem_authorization_grants(id serial PRIMARY KEY,user_id uuid,subject_type text,subject_id text,scope text,permission text,granted_by text,granted_at timestamptz,expires_at timestamptz,revoked_at timestamptz,created_at timestamptz,updated_at timestamptz)')
  await pool.query('CREATE TABLE security_events(user_id uuid,event_type text,resource_type text,resource_fingerprint text,owner_fingerprint text,client_fingerprint text,ip_fingerprint text,user_agent_fingerprint text,action text,reason_code text,metadata_json json,occurred_at timestamptz,expires_at timestamptz)')
  await pool.query("INSERT INTO scheduled_tasks VALUES(1,$1,NULL,'任务一',true,NULL,NULL),(2,$1,NULL,'任务二',true,NULL,NULL),(3,$2,NULL,'其他用户',true,NULL,NULL),(4,$1,NULL,'停用任务',false,NULL,NULL),(5,$1,NULL,'并发任务',true,NULL,NULL),(6,$1,NULL,'热关闭',true,NULL,NULL),(7,$1,77,'事件提醒',true,NULL,NULL)",[owner,foreign])
  const api=createTaskFilesystemAuthorization(runtime.db,{confirmations,enabled:()=>enabled,fingerprint:()=> 'synthetic-fingerprint',recordMetric:async outcome=>{metrics.push(outcome)}})
  await assert.rejects(api.request(owner,3),(error:unknown)=>(error as {code:string}).code==='not_found')
  enabled=false;await assert.rejects(api.request(owner,1),(error:unknown)=>(error as {statusCode:number}).statusCode===409);enabled=true
  await assert.rejects(api.request(owner,4),(error:unknown)=>(error as {statusCode:number}).statusCode===400)
  const first=await api.request(owner,1) as {status:string;confirm_code:string;authorization_ttl_minutes:number}
  assert.equal(first.status,'waiting_confirmation');assert.equal(first.authorization_ttl_minutes,10)
  const firstTtl=Number(await redis.eval("return redis.call('TTL',KEYS[1])",1,`agent:confirm-code:${owner}:${first.confirm_code}`));assert.ok(firstTtl>0&&firstTtl<=600)
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM filesystem_authorization_grants')).rows[0].count,0)
  const second=await api.request(owner,2) as {confirm_code:string}
  await assert.rejects(api.confirm(owner,1,second.confirm_code),(error:unknown)=>(error as {statusCode:number}).statusCode===400)
  const granted=await api.confirm(owner,1,first.confirm_code)
  assert.equal(granted.status,'authorized')
  const task=(await pool.query('SELECT filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=1')).rows[0]
  assert.equal(task.filesystem_authorization_grant_id,granted.grant_id)
  const audit=(await pool.query("SELECT metadata_json FROM security_events WHERE reason_code='granted'")).rows
  assert.equal(audit.length,1);assert.equal(audit[0].metadata_json.source,'user')
  await assert.rejects(api.confirm(owner,1,first.confirm_code),(error:unknown)=>(error as {statusCode:number}).statusCode===400)
  assert.deepEqual(await api.request(owner,1),{status:'authorized',task_id:1})
  const expired=await api.request(owner,2) as {confirm_code:string}
  await redis.eval("return redis.call('PEXPIRE',KEYS[1],ARGV[1])",1,`agent:confirm-code:${owner}:${expired.confirm_code}`,'1')
  await delay(20)
  await assert.rejects(api.confirm(owner,2,expired.confirm_code),(error:unknown)=>(error as {statusCode:number}).statusCode===400)
  const concurrent=await api.request(owner,5) as {confirm_code:string}
  const results=await Promise.allSettled([api.confirm(owner,5,concurrent.confirm_code),api.confirm(owner,5,concurrent.confirm_code)])
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
  const hot=await api.request(owner,6) as {confirm_code:string}
  const wrapped={...confirmations,redeem:async(...args:Parameters<typeof confirmations.redeem>)=>{const result=await confirmations.redeem(...args);enabled=false;return result}}
  const hotApi=createTaskFilesystemAuthorization(runtime.db,{confirmations:wrapped,enabled:()=>enabled,fingerprint:()=> 'synthetic-fingerprint'})
  await assert.rejects(hotApi.confirm(owner,6,hot.confirm_code),(error:unknown)=>(error as {statusCode:number}).statusCode===409)
  assert.equal((await pool.query('SELECT filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=6')).rows[0].filesystem_authorization_grant_id,null)
  assert.equal(metrics.filter(outcome=>outcome==='granted').length,2)
  enabled=true
  const reminder=await api.request(owner,7) as {confirm_code:string}
  await assert.rejects(api.confirm(owner,7,reminder.confirm_code),(error:unknown)=>(error as {statusCode:number}).statusCode===409)
  assert.equal(await confirmations.redeem(owner,reminder.confirm_code),false)
  const rollback=await api.request(owner,2) as {confirm_code:string}
  await pool.query("CREATE FUNCTION block_task_authorization_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$ LANGUAGE plpgsql")
  await pool.query("CREATE TRIGGER block_task_authorization_audit BEFORE INSERT ON security_events FOR EACH ROW WHEN (NEW.reason_code='granted') EXECUTE FUNCTION block_task_authorization_audit()")
  await assert.rejects(api.confirm(owner,2,rollback.confirm_code))
  assert.equal((await pool.query('SELECT filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=2')).rows[0].filesystem_authorization_grant_id,null)
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM filesystem_authorization_grants')).rows[0].count,2)
  assert.equal(await confirmations.redeem(owner,rollback.confirm_code),false)
  const unavailable=createTaskFilesystemAuthorization(runtime.db,{enabled:()=>true,fingerprint:()=> 'synthetic',confirmations:{revoke:async()=>false,createPending:async()=>null,redeem:async()=>false,hasGrant:async()=>false}})
  const blocked=await unavailable.request(owner,2) as Record<string,unknown>
  assert.equal(blocked.status,'confirmation_unavailable');assert.equal(blocked.needs_confirm,true);assert.equal(Object.hasOwn(blocked,'confirm_code'),false)

 }finally{
  for(let id=1;id<=7;id++)await confirmations.revoke(owner,`允许定时任务「${({1:'任务一',2:'任务二',3:'其他用户',4:'停用任务',5:'并发任务',6:'热关闭',7:'事件提醒'} as Record<number,string>)[id]}」读写整个用户沙箱（包含 /workspace、/personal、/project）`,`scheduled-task:filesystem:${id}`)
  await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()
 }
})

import Fastify from 'fastify'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {registerTaskFilesystemAuthorizationRoutes,createTaskAuthorizationEnabledReader} from '../../src/modules/scheduled-tasks/task-filesystem-authorize.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

test('任务授权HTTP认证、确认码DTO以及配置热策略优先级',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gugu-task-auth-')),path=join(root,'config.json')
 const app=Fastify();installHttpErrorHandler(app);const calls:unknown[][]=[]
 registerTaskFilesystemAuthorizationRoutes(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='user')return reply.code(401).send({detail:'未授权'})},ownerIdFromRequest:()=> 'trusted-owner',request:async(...args)=>{calls.push(args);return {status:'waiting_confirmation'}},confirm:async(...args)=>{calls.push(args);return {status:'authorized'}}})
 try{
  await writeFile(path,'{}')
  assert.equal(createTaskAuthorizationEnabledReader(path,{})(),true)
  assert.equal(createTaskAuthorizationEnabledReader(path,{STORAGE:'{"backend":"oss"}'})(),false)
  assert.equal(createTaskAuthorizationEnabledReader(path,{SANDBOX:'{"full_user_sandbox_authorization_enabled":false}'})(),false)
  assert.equal(createTaskAuthorizationEnabledReader(path,{SANDBOX:'{"full_user_sandbox_authorization_enabled":false}',SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED:'true'})(),true)
  const read=createTaskAuthorizationEnabledReader(path,{SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED:'true'})
  await writeFile(path,'{"sandbox":{"full_user_sandbox_authorization_enabled":false}}');assert.equal(read(),false)
  await writeFile(path,'{"sandbox":{"full_user_sandbox_authorization_enabled":true}}');assert.equal(read(),true)
  assert.equal((await app.inject({method:'POST',url:'/api/v1/scheduled-tasks/1/filesystem-authorization/request'})).statusCode,401);assert.deepEqual(calls,[])
  assert.equal((await app.inject({method:'POST',url:'/api/v1/scheduled-tasks/1/filesystem-authorization/request',headers:{authorization:'user'}})).statusCode,200)
  for(const payload of [{},{confirm_code:''},{confirm_code:1},{confirm_code:'x'.repeat(129)}])assert.equal((await app.inject({method:'POST',url:'/api/v1/scheduled-tasks/1/filesystem-authorization',headers:{authorization:'user'},payload})).statusCode,422)
  assert.equal((await app.inject({method:'POST',url:'/api/v1/scheduled-tasks/bad/filesystem-authorization/request',headers:{authorization:'user'}})).statusCode,422)
  assert.equal((await app.inject({method:'POST',url:'/api/v1/scheduled-tasks/bad/filesystem-authorization',headers:{authorization:'user'},payload:{confirm_code:'synthetic-code'}})).statusCode,422)
  const result=await app.inject({method:'POST',url:'/api/v1/scheduled-tasks/1/filesystem-authorization',headers:{authorization:'user'},payload:{confirm_code:'synthetic-code'}})
  assert.equal(result.statusCode,200);assert.deepEqual(calls,[['trusted-owner',1],['trusted-owner',1,'synthetic-code']])
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
})
