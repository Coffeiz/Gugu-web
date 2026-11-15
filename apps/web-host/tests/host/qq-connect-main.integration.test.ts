import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,randomBytes,createCipheriv} from 'node:crypto'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {createServer as createPortServer} from 'node:net'
import {Pool} from 'pg'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
import {temporarySmtp} from '../admin/fixtures/temporary-smtp.js'
import {createRedisExpiringValueStore} from '../../src/adapters/redis-events.js'
async function freePort(){const s=createPortServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();assert.ok(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port}
test('生产QQ扫码完整TLS→Redis→加密PG→gateway消费，未配置Redis不请求上游且关闭连接',async()=>{
 const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(databaseUrl);assert.ok(redisUrl);assert.ok(python)
 const schema=`qq_connect_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID(),root=await mkdtemp(join(tmpdir(),'qq-connect-')),path=join(root,'override.json'),secret='synthetic-qq-connect-production-secret',smtp=await temporarySmtp(root),task=`synthetic-${randomUUID()}`
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`);const scoped=new URL(databaseUrl);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString(),max:1}),store=createRedisExpiringValueStore(redisUrl);let requests=0,key='',status=0
 const portal=createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(smtp.cert)},async(req,res)=>{requests++;let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);res.setHeader('content-type','application/json');if(req.url==='/lite/create_bind_task'){key=body.key;res.end(JSON.stringify({retcode:0,data:{task_id:task}}));return}const iv=randomBytes(12),aes=createCipheriv('aes-256-gcm',Buffer.from(key,'base64'),iv),cipher=Buffer.concat([iv,aes.update('synthetic-qq-secret'),aes.final(),aes.getAuthTag()]).toString('base64');res.end(JSON.stringify({retcode:0,data:{status,bot_appid:'synthetic-qq-app',bot_encrypt_secret:cipher}}))})
 await new Promise<void>(r=>portal.listen(0,'127.0.0.1',r));const addr=portal.address();assert.ok(addr&&typeof addr!=='string')
 let host:Awaited<ReturnType<typeof startServer>>|undefined,noRedis:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  await writeFile(path,JSON.stringify({secret_key:secret,im:{qq:true}}));const original=await readFile(path,'utf8'),env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:join(root,'absent.env'),GUGU_CONFIG_OVERRIDE_FILE:path,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other}
  execFileSync(python,[resolve('../../compat/support/qq_bot_create.py'),'setup'],{cwd:resolve('../../backend'),env})
  const runtimeEnv={GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:path,SSL_CERT_FILE:smtp.cert,QQ_PORTAL_HOST:`127.0.0.1:${addr.port}`,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:redisUrl}
  host=await startServer(runtimeEnv);const url='/api/v1/me/qq/connect',headers={authorization:`Bearer ${signedUserToken(secret,owner)}`}
  assert.equal((await host.app.inject({method:'POST',url})).statusCode,401);assert.equal((await host.app.inject({method:'GET',url:url+'/'+task})).statusCode,401);assert.equal(requests,0)
  const started=await host.app.inject({method:'POST',url,headers});assert.equal(started.statusCode,200,started.body);assert.equal(started.json().task_id,task);assert.equal(new URL(started.json().scan_url).pathname,'/qqbot/openclaw/connect.html');assert.equal(started.body.includes(key),false)
  const foreign=await host.app.inject({method:'GET',url:url+'/'+task,headers:{authorization:`Bearer ${signedUserToken(secret,other)}`}});assert.equal(foreign.statusCode,403);assert.equal(requests,1)
  assert.deepEqual((await host.app.inject({method:'GET',url:url+'/'+task,headers})).json(),{status:'waiting'});status=2
  const success=await host.app.inject({method:'GET',url:url+'/'+task,headers});assert.equal(success.statusCode,200,success.body);assert.equal(success.json().status,'success');assert.equal(success.body.includes('synthetic-qq-secret'),false);assert.equal(await store.get(`qqconnect:${task}`),null)
  const bot=(await pool.query('SELECT id,app_secret FROM user_bots WHERE user_id=$1',[owner])).rows[0];assert.match(bot.app_secret,/^gcm1:/)
  const consumed=JSON.parse(execFileSync(python,[resolve('../../compat/support/qq_bot_create.py'),'consume'],{cwd:resolve('../../backend'),env:{...env,TEST_BOT:String(bot.id)},encoding:'utf8'}));assert.equal(consumed.gateway_secret_sha,consumed.expected_secret_sha)
  assert.equal((await pool.query("SELECT context_epoch FROM conversation_sessions WHERE user_id=$1 AND source='qq'",[owner])).rows[0].context_epoch,5);assert.equal(await readFile(path,'utf8'),original)
  noRedis=await startServer({...runtimeEnv,GUGU_WEBUI_REDIS_URL:'',GUGU_WEBUI_PORT:String(await freePort())});const before=requests
  assert.equal((await noRedis.app.inject({method:'POST',url})).statusCode,401);assert.equal((await noRedis.app.inject({method:'POST',url,headers})).statusCode,503);assert.equal((await noRedis.app.inject({method:'GET',url:url+'/'+task,headers})).statusCode,503);assert.equal(requests,before)
  await host.close();host=undefined;await noRedis.close();noRedis=undefined
 }finally{await noRedis?.close();await host?.close();await store.delete(`qqconnect:${task}`);await new Promise<void>(r=>portal.close(()=>r()));await smtp.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
