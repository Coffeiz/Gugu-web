import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import type {LightMyRequestResponse} from 'fastify'
import {Pool} from 'pg'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('生产管理员封禁真实认证和SSE失效，解封不恢复旧JWT，审计失败不撤销封禁', {skip:(!databaseUrl||!redisUrl||!python)&&'需要隔离PG/Redis与显式Python'},async()=>{
 const schema=`ban_host_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-ban-host-'))
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString(),max:3}),owner=randomUUID(),other=randomUUID(),secret='synthetic-ban-host-secret'
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.'}
  await pool.query(execFileSync(python!,['-c',"from app.models import User,AuditLog; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [User,AuditLog]))"],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  await pool.query('CREATE TABLE user_bots(id integer,user_id uuid,platform text,enabled boolean)')
  for(const [id,name] of [[owner,'小北'],[other,'小月']])await pool.query("INSERT INTO users(id,username,email,hashed_password,is_active,account_status,security_version,is_developer,created_at) VALUES($1,$2,$3,'synthetic-not-a-password',true,'active',1,false,clock_timestamp())",[id,name,`${id}@example.invalid`])
  const override=join(root,'config.json');await writeFile(override,'{}')
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(resolve=>socket.close(()=>resolve()))
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(port),GUGU_WEBUI_REDIS_URL:redisUrl,STORAGE__LOCAL_PATH:join(root,'storage'),ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const path=`/api/v1/admin/users/${owner}/ban`,userHeaders={authorization:`Bearer ${signedUserToken(secret,owner)}`},otherHeaders={authorization:`Bearer ${signedUserToken(secret,other)}`}
  assert.equal((await host.app.inject({method:'PATCH',url:path})).statusCode,401);assert.equal((await host.app.inject({method:'PATCH',url:path,headers:userHeaders})).statusCode,403)
  const login:LightMyRequestResponse=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
  assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`,'x-forwarded-for':'203.0.113.8, 198.51.100.4'}
  assert.equal((await host.app.inject({url:'/api/v1/mcp/status',headers:userHeaders})).statusCode,200)
  async function banWithLive(version:number,expectedStatus:number){
   const abort=new AbortController()
   try{
    const response=await fetch(`http://127.0.0.1:${port}/api/v1/live/stream`,{headers:{authorization:`Bearer ${signedUserToken(secret,owner,version)}`},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])})
    assert.equal(response.status,200);const reader=response.body!.getReader(),decoder=new TextDecoder()
    let frames=decoder.decode((await reader.read()).value);assert.match(frames,/: connected/)
    const banned:LightMyRequestResponse=await host!.app.inject({method:'PATCH',url:path,headers})
    assert.equal(banned.statusCode,expectedStatus,banned.body)
    while(!frames.includes('event: account_suspended')){const next=await reader.read();assert.equal(next.done,false);frames+=decoder.decode(next.value)}
    assert.doesNotMatch(frames,/auth.state.changed/)
    abort.abort();await reader.cancel().catch(()=>undefined)
   }finally{abort.abort()}
  }
  await banWithLive(1,200)
  assert.equal((await host.app.inject({url:'/api/v1/mcp/status',headers:userHeaders})).statusCode,401)
  assert.equal((await host.app.inject({url:'/api/v1/mcp/status',headers:otherHeaders})).statusCode,200)
  assert.deepEqual((await pool.query('SELECT account_status,is_active,security_version,suspended_reason FROM users WHERE id=$1',[owner])).rows[0],{account_status:'suspended',is_active:false,security_version:2,suspended_reason:'admin_ban_compat'})
  assert.deepEqual((await pool.query("SELECT username,action,description,ip FROM audit_logs WHERE action='user'")).rows,[{username:'synthetic-admin',action:'user',description:'封禁用户 小北',ip:'203.0.113.8'}])
  const unbanned:LightMyRequestResponse=await host.app.inject({method:'PATCH',url:path,headers});assert.equal(unbanned.statusCode,200);assert.equal(unbanned.json().is_active,true)
  assert.equal((await host.app.inject({url:'/api/v1/mcp/status',headers:userHeaders})).statusCode,401)
  const fresh={authorization:`Bearer ${signedUserToken(secret,owner,3)}`}
  assert.equal((await host.app.inject({url:'/api/v1/mcp/status',headers:fresh})).statusCode,200)
  await pool.query("CREATE FUNCTION fail_ban_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.description='封禁用户 小北' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_ban_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_ban_audit()")
  await banWithLive(3,500)
  assert.equal((await host.app.inject({url:'/api/v1/mcp/status',headers:fresh})).statusCode,401)
  assert.equal((await pool.query('SELECT security_version FROM users WHERE id=$1',[owner])).rows[0].security_version,4)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='user'")).rows[0].n,2)
  await pool.query(`CREATE FUNCTION fail_ban_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${other}' THEN RAISE EXCEPTION 'synthetic state failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_ban_state BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fail_ban_state()`)
  const failed:LightMyRequestResponse=await host.app.inject({method:'PATCH',url:`/api/v1/admin/users/${other}/ban`,headers})
  assert.equal(failed.statusCode,500);assert.doesNotMatch(failed.body,/synthetic state failure/)
  assert.equal((await host.app.inject({url:'/api/v1/mcp/status',headers:otherHeaders})).statusCode,200)
 }finally{await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
