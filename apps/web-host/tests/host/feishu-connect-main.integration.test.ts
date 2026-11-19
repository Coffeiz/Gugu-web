import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {createServer as createPortServer} from 'node:net'
import {Pool} from 'pg'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
import {createRedisExpiringValueStore} from '../../src/adapters/cache/redis-events.js'
import {createFeishuConnectHostOptions} from '../../src/modules/im/feishu-connect.js'
async function freePort(){const s=createPortServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();assert.ok(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port}
test('生产飞书固定官方目标：真实认证/Redis owner与过期，无Redis503，拒绝向外发送',async()=>{
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(url);assert.ok(redisUrl);assert.ok(python)
 const schema=`feishu_connect_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID(),root=await mkdtemp(join(tmpdir(),'feishu-connect-')),path=join(root,'override.json'),secret='synthetic-feishu-production-secret',id=`synthetic-${randomUUID()}`,store=createRedisExpiringValueStore(redisUrl),admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`)
 let outbound=0;const deny=createServer((_req,res)=>{outbound++;res.writeHead(403);res.end()});deny.on('connect',(_req,socket)=>{outbound++;socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')});await new Promise<void>(r=>deny.listen(0,'127.0.0.1',r));const a=deny.address();assert.ok(a&&typeof a!=='string')
 let host:Awaited<ReturnType<typeof startServer>>|undefined,noRedis:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  await writeFile(path,JSON.stringify({secret_key:secret,im:{feishu:true}}));execFileSync(python,[resolve('../../compat/support/qq_bot_create.py'),'setup'],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:join(root,'absent.env'),GUGU_CONFIG_OVERRIDE_FILE:path,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other}})
  const env={GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:path,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:redisUrl,HTTPS_PROXY:`http://127.0.0.1:${a.port}`,NO_PROXY:''}
  const options=createFeishuConnectHostOptions({...env,FEISHU_ACCOUNTS_HOST:'untrusted.example.test'},redisUrl);assert.equal(options.portalBase,'https://accounts.feishu.cn');assert.equal(options.allowLocal,false);await options.transport.close()
  host=await startServer(env);const base='/api/v1/me/feishu/connect',headers={authorization:`Bearer ${signedUserToken(secret,owner)}`}
  assert.equal((await host.app.inject({method:'POST',url:base})).statusCode,401);assert.equal((await host.app.inject({method:'GET',url:base+'/'+id})).statusCode,401)
  assert.deepEqual((await host.app.inject({method:'GET',url:base+'/'+id,headers})).json(),{status:'expired'})
  await store.saveIfAbsent('feishuconnect:'+id,JSON.stringify({uid:other,device_code:'synthetic-device-code'}),60)
  assert.equal((await host.app.inject({method:'GET',url:base+'/'+id,headers})).statusCode,403)
  noRedis=await startServer({...env,GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:''});assert.equal((await noRedis.app.inject({method:'POST',url:base})).statusCode,401);assert.equal((await noRedis.app.inject({method:'POST',url:base,headers})).statusCode,503);assert.equal((await noRedis.app.inject({method:'GET',url:base+'/'+id,headers})).statusCode,503)
  assert.equal(outbound,0,'此生产批次不得触发官方授权请求；完整业务使用显式注入合成门户的独立回归')
 }finally{await noRedis?.close();await host?.close();await store.delete('feishuconnect:'+id);await new Promise<void>(r=>deny.close(()=>r()));await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
