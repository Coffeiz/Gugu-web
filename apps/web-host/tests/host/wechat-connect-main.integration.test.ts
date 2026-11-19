import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {createServer as createSocket} from 'node:net'
import {Pool} from 'pg'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
import {createRedisExpiringValueStore} from '../../src/adapters/cache/redis-events.js'
import {createWechatConnectHostOptions} from '../../src/modules/im/connect/wechat.js'
async function freePort(){const socket=createSocket();await new Promise<void>(done=>socket.listen(0,'127.0.0.1',done));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(done=>socket.close(()=>done()));return address.port}

test('生产微信固定官方目标：真实认证/owner/过期/平台热开关及无Redis，禁止外发授权请求',async()=>{
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(url);assert.ok(redisUrl);assert.ok(python)
 const schema=`wechat_connect_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID(),secret='synthetic-wechat-entry-secret',id=randomUUID().replaceAll('-',''),root=await mkdtemp(join(tmpdir(),'wechat-connect-')),path=join(root,'config.json'),store=createRedisExpiringValueStore(redisUrl),admin=new Pool({connectionString:url,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`);const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`)
 let outbound=0;const deny=createServer((_request,response)=>{outbound++;response.writeHead(403);response.end()});deny.on('connect',(_request,socket)=>{outbound++;socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')});await new Promise<void>(done=>deny.listen(0,'127.0.0.1',done));const address=deny.address();assert.ok(address&&typeof address!=='string')
 let host:Awaited<ReturnType<typeof startServer>>|undefined,noRedis:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  await writeFile(path,JSON.stringify({secret_key:secret,im:{wechat:true}}));execFileSync(python,[resolve('../../compat/support/qq_bot_create.py'),'setup'],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:path,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other}})
  const env={GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:path,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:redisUrl,HTTPS_PROXY:`http://127.0.0.1:${address.port}`,NO_PROXY:''}
  const fixed=createWechatConnectHostOptions({...env,WECHAT_API_HOST:'untrusted.example.invalid'},redisUrl);assert.equal(fixed.portalBase,'https://ilinkai.weixin.qq.com');assert.equal(fixed.allowLocal,false);await fixed.transport.close()
  host=await startServer(env);const base='/api/v1/me/wechat/connect',headers={authorization:`Bearer ${signedUserToken(secret,owner)}`}
  assert.equal((await host.app.inject({method:'POST',url:base})).statusCode,401);assert.equal((await host.app.inject({method:'GET',url:base+'/'+id})).statusCode,401)
  assert.deepEqual((await host.app.inject({method:'GET',url:base+'/'+id,headers})).json(),{status:'expired'})
  await store.saveIfAbsent('wechatconnect:'+id,JSON.stringify({uid:other,qrcode:'synthetic-challenge'}),60);assert.equal((await host.app.inject({method:'GET',url:base+'/'+id,headers})).statusCode,403)
  await writeFile(path,JSON.stringify({secret_key:secret,im:{wechat:false}}));assert.equal((await host.app.inject({method:'POST',url:base,headers})).statusCode,503);await writeFile(path,JSON.stringify({secret_key:secret,im:{wechat:true}}))
  noRedis=await startServer({...env,GUGU_WEBUI_REDIS_URL:'',GUGU_WEBUI_PORT:String(await freePort())});assert.equal((await noRedis.app.inject({method:'POST',url:base})).statusCode,401);assert.equal((await noRedis.app.inject({method:'POST',url:base,headers})).statusCode,503);assert.equal((await noRedis.app.inject({method:'GET',url:base+'/'+id,headers})).statusCode,503);assert.equal(outbound,0)
 }finally{await noRedis?.close();await host?.close();await store.delete('wechatconnect:'+id);await new Promise<void>(done=>deny.close(()=>done()));await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
