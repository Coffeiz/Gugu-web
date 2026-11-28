import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import {Pool} from 'pg'
import {startServer} from '../../../../src/main.js'
import {signedUserToken} from '../../../helpers/auth.js'
import {createRedisScheduledTaskCommands,createRedisValueReader} from '../../../../src/adapters/cache/redis-events.js'
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();assert.ok(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port}
test('生产Bot PUT与DELETE真实认证/PG/Redis/SSE，owner隔离且无Redis不撤销持久变更',async()=>{
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisBase=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(url);assert.ok(redisBase);assert.ok(python)
 const schema=`bot_host_delete_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1}),root=await mkdtemp(join(tmpdir(),'bot-delete-main-')),owner=randomUUID(),other=randomUUID(),secret='synthetic-delete-main-secret';await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);const pool=new Pool({connectionString:scoped.toString(),max:2}),redisUrl=new URL(redisBase);redisUrl.pathname='/8'
 const commands=createRedisScheduledTaskCommands(redisUrl.toString()),read=createRedisValueReader(redisUrl.toString()),keys=[`imreach:${owner}:qq`,`imreach:${owner}`,`context-revision:${owner}`,`context-revision:${other}`],override=join(root,'config.json'),headers={authorization:`Bearer ${signedUserToken(secret,owner)}`},foreign={authorization:`Bearer ${signedUserToken(secret,other)}`};let host:Awaited<ReturnType<typeof startServer>>|undefined;const abort=new AbortController()
 try{
  await writeFile(override,JSON.stringify({secret_key:secret,im:{qq:true}}));execFileSync(python,[resolve('../../compat/support/qq_bot_create.py'),'setup'],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_TEST_DATABASE_URL:url,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other},encoding:'utf8'})
  const port=await freePort(),boot=(redis:string,listenPort:number)=>startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(listenPort),GUGU_WEBUI_REDIS_URL:redis,STORAGE__LOCAL_PATH:join(root,'storage')});host=await boot(redisUrl.toString(),port)
  const created=await host.app.inject({method:'POST',url:'/api/v1/me/bots',headers,payload:{app_id:'synthetic-app',app_secret:'synthetic-delete-secret'}});assert.equal(created.statusCode,200,created.body);const id=created.json().id,path=`/api/v1/me/bots/${id}`
  assert.equal((await host.app.inject({method:'PUT',url:path,payload:{name:'forbidden'}})).statusCode,401);assert.equal((await host.app.inject({method:'PUT',url:path,headers:foreign,payload:{name:'forbidden'}})).statusCode,404)
  const updated=await host.app.inject({method:'PUT',url:path,headers,payload:{user_id:other,name:'更新后的机器人',app_secret:created.json().app_secret,group_response_mode:'reply_all',group_attention_mode:'active',group_allowed_tools:['web_search'],private_message_format:'markdown',private_streaming_enabled:'YES'}});assert.equal(updated.statusCode,200,updated.body);assert.equal(updated.json().name,'更新后的机器人');assert.equal(updated.json().private_streaming_enabled,true);assert.deepEqual(updated.json().group_allowed_tools,['web_search','http_get']);assert.doesNotMatch(updated.body,/synthetic-delete-secret|gcm1:/)
  assert.equal((await pool.query('SELECT group_attention_config_version FROM user_bots WHERE id=$1',[id])).rows[0].group_attention_config_version,1);assert.equal((await pool.query("SELECT min(context_epoch)::int AS n FROM conversation_sessions WHERE user_id=$1 AND source<>'web'",[owner])).rows[0].n,6)
  assert.equal((await host.app.inject({method:'PUT',url:path,headers,payload:{name:'must-rollback',private_message_format:'compat',private_streaming_enabled:true}})).statusCode,400);assert.equal((await pool.query('SELECT name FROM user_bots WHERE id=$1',[id])).rows[0].name,'更新后的机器人');assert.equal((await host.app.inject({method:'PUT',url:path,headers,payload:{enabled:['true']}})).statusCode,422)
  await pool.query("UPDATE conversation_sessions SET context_epoch=4,snapshot_expires_at=clock_timestamp()+interval '1 day'")
  await commands.eval("redis.call('SET',KEYS[1],ARGV[1]);redis.call('SET',KEYS[2],ARGV[1]);return 1",2,keys[0]!,keys[1]!,JSON.stringify({platform:'qq',puid:'synthetic-private'}))
  assert.equal((await host.app.inject({method:'DELETE',url:path})).statusCode,401);assert.equal((await host.app.inject({method:'DELETE',url:path,headers:foreign})).statusCode,404);assert.ok(await read(keys[0]!))
  const live=await fetch(`http://127.0.0.1:${port}/api/v1/live/stream`,{headers,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)])});assert.equal(live.status,200);const reader=live.body!.getReader(),decoder=new TextDecoder();assert.match(decoder.decode((await reader.read()).value),/: connected/)
  const deleted=await host.app.inject({method:'DELETE',url:path,headers});assert.equal(deleted.statusCode,204,deleted.body);assert.equal(deleted.body,'');let frame='';while(!frame.includes('"resource":"im_channels"')){const next=await reader.read();assert.equal(next.done,false);frame+=decoder.decode(next.value)}assert.doesNotMatch(frame,/synthetic-delete-secret|gcm1:/);await reader.cancel();abort.abort()
  assert.equal(await read(keys[0]!),null);assert.equal(await read(keys[1]!),null);assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_bots WHERE id=$1',[id])).rows[0].n,0);assert.equal((await pool.query("SELECT min(context_epoch)::int AS n FROM conversation_sessions WHERE user_id=$1 AND source<>'web'",[owner])).rows[0].n,5);assert.equal((await host.app.inject({method:'DELETE',url:path,headers})).statusCode,404)
  await host.close();host=await boot('',await freePort());const again=await host.app.inject({method:'POST',url:'/api/v1/me/bots',headers,payload:{app_id:'synthetic-again',app_secret:'synthetic-again-secret'}});assert.equal(again.statusCode,200,again.body);assert.equal((await host.app.inject({method:'DELETE',url:`/api/v1/me/bots/${again.json().id}`,headers})).statusCode,204)
 }finally{abort.abort();await host?.close();await commands.eval("return redis.call('DEL',unpack(KEYS))",keys.length,...keys);await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
