import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import type {LightMyRequestResponse} from 'fastify'
import {Pool} from 'pg'
import {startServer} from '../../../../src/main.js'
import {signedUserToken} from '../../../helpers/auth.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('生产QQ创建与解绑实际PG/Redis/SSE及Python gateway，快照失效失败仍发布', {skip:(!databaseUrl||!redisUrl||!python)&&'需要隔离PG/Redis与显式Python'},async()=>{
 const schema=`qq_host_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-qq-host-')),owner=randomUUID(),other=randomUUID(),secret='synthetic-qq-encryption-secret'
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString(),max:3}),override=join(root,'config.json'),redisScoped=new URL(redisUrl!);redisScoped.pathname='/14'
 await writeFile(override,JSON.stringify({secret_key:secret,im:{qq:true}}))
 const env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:override,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other,TEST_SECRET:secret}
 const bridge=(action:string,extra:Record<string,string>={})=>JSON.parse(execFileSync(python!,[resolve('../../compat/support/qq_bot_create.py'),action],{encoding:'utf8',cwd:resolve('../../backend'),env:{...env,...extra},timeout:20000}))
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 const abort=new AbortController()
 try{
  bridge('setup')
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>socket.close(()=>resolve()))
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(address.port),GUGU_WEBUI_REDIS_URL:redisScoped.toString(),STORAGE__LOCAL_PATH:join(root,'storage'),ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const url='/api/v1/me/bots',headers={authorization:`Bearer ${signedUserToken(secret,owner)}`},foreign={authorization:`Bearer ${signedUserToken(secret,other)}`},payload={user_id:other,app_id:' synthetic-app ',app_secret:' synthetic-qq-secret ',sandbox:true}
  assert.equal((await host.app.inject({method:'POST',url,payload})).statusCode,401)
  const live=await fetch(`http://127.0.0.1:${address.port}/api/v1/live/stream`,{headers,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)])})
  assert.equal(live.status,200);const reader=live.body!.getReader(),decoder=new TextDecoder()
  assert.match(decoder.decode((await reader.read()).value),/: connected/)
  async function invalidation(){let frames='';while(!frames.includes('"resource":"im_channels"')){const next=await reader.read();assert.equal(next.done,false);frames+=decoder.decode(next.value)}assert.match(frames,/"operation":"refresh"/);assert.doesNotMatch(frames,/synthetic-qq-secret|gcm1:/)}
  const created:LightMyRequestResponse=await host.app.inject({method:'POST',url,payload,headers})
  assert.equal(created.statusCode,200,created.body);await invalidation()
  const id=created.json().id,reference=bridge('consume',{TEST_BOT:String(id)})
  assert.deepEqual(created.json(),reference.response);assert.equal(reference.gateway_secret_sha,reference.expected_secret_sha)
  assert.equal((await host.app.inject({url,headers:foreign})).json().items.length,0)
  assert.equal((await host.app.inject({method:'POST',url,payload,headers})).statusCode,409)
  assert.equal((await pool.query("SELECT min(context_epoch)::int AS epoch FROM conversation_sessions WHERE user_id=$1 AND source<>'web'",[owner])).rows[0].epoch,5)
  await writeFile(override,JSON.stringify({secret_key:secret,im:{qq:false}}))
  assert.equal((await host.app.inject({method:'POST',url,payload:{app_id:'new',app_secret:'synthetic'},headers:foreign})).statusCode,503)
  await writeFile(override,JSON.stringify({secret_key:secret,im:{qq:true}}))
  const unbind=`${url}/${id}/qq-binding`
  assert.equal((await host.app.inject({method:'DELETE',url:unbind,headers:foreign})).statusCode,404)
  await pool.query("UPDATE user_bots SET owner_platform_user_id='synthetic-qq-owner',owner_bound_at=clock_timestamp() WHERE id=$1",[id])
  assert.equal((await host.app.inject({method:'DELETE',url:unbind,headers})).statusCode,204);await invalidation()
  assert.equal((await pool.query("SELECT min(context_epoch)::int AS epoch FROM conversation_sessions WHERE user_id=$1 AND source<>'web'",[owner])).rows[0].epoch,6)
  await pool.query("CREATE FUNCTION fail_qq_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic snapshot failure';END $$;CREATE TRIGGER fail_qq_snapshot BEFORE UPDATE OF snapshot_expires_at ON conversation_sessions FOR EACH ROW EXECUTE FUNCTION fail_qq_snapshot()")
  assert.equal((await host.app.inject({method:'DELETE',url:unbind,headers})).statusCode,204);await invalidation()
  assert.equal((await pool.query("SELECT min(context_epoch)::int AS epoch FROM conversation_sessions WHERE user_id=$1 AND source<>'web'",[owner])).rows[0].epoch,6)
  assert.equal((await host.app.inject({url,headers})).json().items[0].owner_bound,false)
  abort.abort();await reader.cancel().catch(()=>undefined)
 }finally{abort.abort();await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
