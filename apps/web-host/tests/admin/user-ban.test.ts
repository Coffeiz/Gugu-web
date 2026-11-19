import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {createPostgresRuntime} from '@gugu/core/data'
import {createAdminUserBanToggle} from '../../src/modules/admin/user-management.js'
import {registerAdminUserBanRoute} from '../../src/modules/admin/users.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('管理员兼容封禁正式PG状态、安全版本、并发与两个提交的审计语义', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`user_ban_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:3}),runtime=await createPostgresRuntime({url:databaseUrl!,schema})
 const owner=randomUUID(),concurrentId=randomUUID(),broken=randomUUID(),auditFailure=randomUUID(),referenceId=randomUUID()
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-user-ban-config',PYTHONPATH:'.',TEST_SCHEMA:schema,TEST_OWNER:referenceId}
 try{
  await pool.query(execFileSync(python!,['-c',"from app.models import User,AuditLog; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [User,AuditLog]))"],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  for(const [id,name] of [[owner,'小北'],[concurrentId,'并发合成'],[broken,'状态失败合成'],[auditFailure,'审计失败合成'],[referenceId,'对照合成']])await pool.query("INSERT INTO users(id,username,email,hashed_password,is_active,account_status,security_version,is_developer,created_at) VALUES($1,$2,$3,'synthetic-not-a-password',true,'active',1,false,clock_timestamp())",[id,name,`${id}@example.invalid`])
  const events:string[]=[],audit={operator:'synthetic-admin',ip:'203.0.113.8'}
  const toggle=createAdminUserBanToggle(runtime.db,async id=>{const row=(await pool.query('SELECT security_version FROM users WHERE id=$1',[id])).rows[0];assert.ok(row.security_version>=2);events.push(id)})
  await assert.rejects(()=>toggle(randomUUID(),audit),/用户不存在/);assert.equal(events.length,0)
  assert.deepEqual(await toggle(owner,audit),{id:owner,is_active:false})
  const suspended=(await pool.query("SELECT account_status,is_active,security_version,suspended_reason,EXTRACT(EPOCH FROM suspended_until-clock_timestamp()) AS seconds FROM users WHERE id=$1",[owner])).rows[0]
  assert.equal(suspended.account_status,'suspended');assert.equal(suspended.security_version,2);assert.equal(suspended.suspended_reason,'admin_ban_compat');assert.ok(Number(suspended.seconds)>2591990&&Number(suspended.seconds)<=2592000)
  assert.deepEqual((await pool.query('SELECT username,action,description,ip FROM audit_logs')).rows,[{username:'synthetic-admin',action:'user',description:'封禁用户 小北',ip:'203.0.113.8'}])
  assert.deepEqual(await toggle(owner,audit),{id:owner,is_active:true})
  assert.deepEqual((await pool.query('SELECT account_status,is_active,security_version,suspended_until,suspended_reason FROM users WHERE id=$1',[owner])).rows[0],{account_status:'active',is_active:true,security_version:3,suspended_until:null,suspended_reason:null})
  const both=await Promise.all([toggle(concurrentId,audit),toggle(concurrentId,audit)]);assert.deepEqual(both.map(x=>x.is_active).sort(),[false,true]);assert.equal((await pool.query('SELECT security_version FROM users WHERE id=$1',[concurrentId])).rows[0].security_version,3)
  await pool.query(`CREATE FUNCTION fail_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${broken}' THEN RAISE EXCEPTION 'synthetic state failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_status BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fail_status()`)
  const beforeEvents=events.length,beforeAudit=(await pool.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n
  await assert.rejects(()=>toggle(broken,audit));assert.equal(events.length,beforeEvents);assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n,beforeAudit)
  await pool.query("CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.description='封禁用户 审计失败合成' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_audit()")
  await assert.rejects(()=>toggle(auditFailure,audit));assert.equal(events.length,beforeEvents+1);assert.equal((await pool.query('SELECT is_active,security_version FROM users WHERE id=$1',[auditFailure])).rows[0].is_active,false);assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n,beforeAudit)
  const unavailable=createAdminUserBanToggle(runtime.db,async()=>{throw new Error('synthetic Redis failure')});assert.equal((await unavailable(auditFailure,audit)).is_active,true)
  const script="import asyncio,json,os; from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker; from starlette.requests import Request; from app.api.v1.users_admin import toggle_ban; from app.core import events\nasync def scenario():\n engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}})\n notified=[]\n async def publish(uid): notified.append(str(uid))\n events.publish_auth_state_changed=publish\n request=Request({'type':'http','headers':[(b'x-forwarded-for',b'203.0.113.8, 198.51.100.4')],'client':('198.51.100.7',1)})\n request.state.admin_username='synthetic-admin'\n try:\n  async with async_sessionmaker(engine,expire_on_commit=False)() as db:\n   banned=await toggle_ban(os.environ['TEST_OWNER'],request,db)\n   unbanned=await toggle_ban(os.environ['TEST_OWNER'],request,db)\n   print(json.dumps({'ban':banned,'unban':unbanned,'notified':notified}))\n finally: await engine.dispose()\nasyncio.run(scenario())"
  const reference=JSON.parse(execFileSync(python!,['-c',script],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  assert.deepEqual(reference,{ban:{id:referenceId,is_active:false},unban:{id:referenceId,is_active:true},notified:[referenceId,referenceId]})
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

test('封禁管理员鉴权与审计操作者/IP取可信HTTP上下文',async()=>{
 const app=Fastify(),id=randomUUID();let calls=0
 registerAdminUserBanRoute(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(request.headers.authorization?403:401).send({detail:'拒绝访问'})},adminUsername:()=> 'synthetic-admin',toggle:async(user,audit)=>{calls++;assert.equal(user,id);assert.deepEqual(audit,{operator:'synthetic-admin',ip:'203.0.113.8'});return {id,is_active:false}}})
 try{
  const url=`/api/v1/admin/users/${id}/ban`
  assert.equal((await app.inject({method:'PATCH',url})).statusCode,401);assert.equal((await app.inject({method:'PATCH',url,headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  const result=await app.inject({method:'PATCH',url,headers:{authorization:'admin','x-forwarded-for':'203.0.113.8, 198.51.100.4'},payload:{operator:'untrusted'}})
  assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{id,is_active:false});assert.equal(calls,1)
 }finally{await app.close()}
})


test('封禁审计HTTP IP有界，超长XFF不能让已提交封禁后的审计被varchar60拒绝',async()=>{
 const app=Fastify()
 registerAdminUserBanRoute(app,{requireAdmin:async()=>{},adminUsername:()=> 'synthetic-admin',toggle:async(id,audit)=>{assert.equal(Array.from(audit.ip!).length,60);return {id,is_active:false}}})
 try{const result=await app.inject({method:'PATCH',url:`/api/v1/admin/users/${randomUUID()}/ban`,headers:{'x-forwarded-for':'x'.repeat(80)+', 203.0.113.8'}});assert.equal(result.statusCode,200)}finally{await app.close()}
})
