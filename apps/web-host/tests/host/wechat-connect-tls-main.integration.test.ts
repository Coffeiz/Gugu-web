import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {createServer as createSocket,connect} from 'node:net'
import {createServer as createProxy} from 'node:http'
import type {Duplex} from 'node:stream'
import {Pool} from 'pg'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
import {createRedisExpiringValueStore} from '../../src/adapters/redis-events.js'
async function freePort(){const socket=createSocket();await new Promise<void>(done=>socket.listen(0,'127.0.0.1',done));const addr=socket.address();assert.ok(addr&&typeof addr!=='string');await new Promise<void>(done=>socket.close(()=>done()));return addr.port}

test('生产微信扫码TLS→Redis→PG→实际Python gateway，真实SSE刷新、无Redis及平台热开关',async()=>{
 const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(databaseUrl);assert.ok(redisUrl);assert.ok(redisUrl.endsWith('/9'));if(!python)throw new Error('缺少 Python golden runner')
 const schema=`wechat_connect_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID(),secret='synthetic-wechat-production-secret',root=await mkdtemp(join(tmpdir(),'wechat-connect-')),path=join(root,'config.json'),cert=join(root,'cert.pem')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',cert,'-days','1','-subj','/CN=ilinkai.weixin.qq.com','-addext','subjectAltName=DNS:ilinkai.weixin.qq.com'],{stdio:'ignore'})
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`);const scoped=new URL(databaseUrl);scoped.searchParams.set('options',`-c search_path=${schema}`);const pool=new Pool({connectionString:scoped.toString(),max:2}),store=createRedisExpiringValueStore(redisUrl),keys:string[]=[]
 let payload:Record<string,unknown>={qrcode:'synthetic-production-challenge',qrcode_img_content:'https://scan.example.invalid/q/synthetic'},status=200,requests=0,redirect=false
 const relay=createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(cert)},(request,response)=>{requests++;assert.equal(request.headers.host,'ilinkai.weixin.qq.com');assert.equal(request.method,'GET');assert.equal(request.headers.authorization,undefined);assert.equal(request.headers.authorizationtype,'ilink_bot_token');assert.match(Buffer.from(String(request.headers['x-wechat-uin']),'base64').toString(),/^\d+$/);response.setHeader('content-type','application/json');if(redirect){response.writeHead(302,{location:'/secret-redirect'});response.end('{}');return}response.writeHead(status);response.end(JSON.stringify(payload))})
 await new Promise<void>(done=>relay.listen(0,'127.0.0.1',done));const addr=relay.address();assert.ok(addr&&typeof addr!=='string')
 const tunnels=new Set<Duplex>(),targets:string[]=[]
 const proxy=createProxy((_request,response)=>{response.writeHead(405);response.end()})
 proxy.on('connect',(request,socket,head)=>{
  targets.push(request.url!);const upstream=connect(addr.port,'127.0.0.1');tunnels.add(socket);tunnels.add(upstream)
  socket.on('close',()=>{tunnels.delete(socket);upstream.destroy()});upstream.on('close',()=>{tunnels.delete(upstream);socket.destroy()});socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy())
  upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket)})
 })
 await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));const proxyAddress=proxy.address();assert.ok(proxyAddress&&typeof proxyAddress!=='string')
 const env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:path,APP_SECRET:secret,GUGU_WEBUI_SECRET_KEY:secret,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other}
 const bridge=(action:string,task='')=>JSON.parse(execFileSync(python,[resolve('tests/im/fixtures/wechat_connect_python.py'),action],{encoding:'utf8',cwd:resolve('../../backend'),env:{...env,TEST_TASK:task},timeout:20000}))
 const abort=new AbortController();let host:Awaited<ReturnType<typeof startServer>>|undefined,noRedis:Awaited<ReturnType<typeof startServer>>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined
 try{
  const document={secret_key:secret,im:{wechat:true}};await writeFile(path,JSON.stringify(document));execFileSync(python,[resolve('../../compat/support/qq_bot_create.py'),'setup'],{cwd:resolve('../../backend'),env})
  const runtimeEnv={GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:path,SSL_CERT_FILE:cert,HTTPS_PROXY:`http://127.0.0.1:${proxyAddress.port}`,NO_PROXY:'',STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:redisUrl}
  host=await startServer(runtimeEnv);const url='/api/v1/me/wechat/connect',headers={authorization:`Bearer ${signedUserToken(secret,owner)}`}
  assert.equal((await host.app.inject({method:'POST',url})).statusCode,401);assert.equal((await host.app.inject({method:'GET',url:url+'/missing'})).statusCode,401);assert.equal(requests,0)
  const live=await fetch(`http://127.0.0.1:${runtimeEnv.GUGU_WEBUI_PORT}/api/v1/live/stream`,{headers,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)])});assert.equal(live.status,200);reader=live.body!.getReader();const decoder=new TextDecoder();assert.match(decoder.decode((await reader.read()).value),/: connected/)
  const started=await host.app.inject({method:'POST',url,headers});assert.equal(started.statusCode,200,started.body);const task=started.json().task_id;keys.push(`wechatconnect:${task}`);assert.match(task,/^[0-9a-f]{32}$/);assert.doesNotMatch(started.body,/synthetic-production-challenge/);const stored=bridge('state',task);assert.equal(stored.owner,owner);assert.ok(stored.ttl>580&&stored.ttl<=600)
  const before=requests;assert.equal((await host.app.inject({method:'GET',url:url+'/'+task,headers:{authorization:`Bearer ${signedUserToken(secret,other)}`}})).statusCode,403);assert.equal(requests,before)
  payload={status:'scanned'};assert.deepEqual((await host.app.inject({method:'GET',url:url+'/'+task,headers})).json(),{status:'waiting'})
  payload={status:'confirmed',bot_token:'synthetic-production-token',baseurl:'https://gateway.example.invalid'};const result=await host.app.inject({method:'GET',url:url+'/'+task,headers});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().status,'success');assert.doesNotMatch(result.body,/synthetic-production-token|gcm1:/);assert.equal(await store.get(keys.at(-1)!),null)
  let frames='';while(!frames.includes('"resource":"im_channels"')){const next: ReadableStreamReadResult<Uint8Array> = await reader.read();assert.equal(next.done,false);frames+=decoder.decode(next.value)}assert.match(frames,/"operation":"refresh"/);assert.doesNotMatch(frames,/synthetic-production-token|synthetic-production-challenge|gcm1:/)
  const consumed=bridge('consume');assert.equal(consumed.secret_sha,createHash('sha256').update('synthetic-production-token').digest('hex'));assert.equal(consumed.gateway_token_sha,consumed.secret_sha);assert.equal(consumed.gateway_base_url,'https://gateway.example.invalid')
  assert.equal((await pool.query("SELECT context_epoch FROM conversation_sessions WHERE user_id=$1 AND source='wechat'",[owner])).rows[0].context_epoch,5)
  payload={qrcode:'synthetic-new-challenge',qrcode_img_content:'https://scan.example.invalid/q/new'};document.im.wechat=false;await writeFile(path,JSON.stringify(document));const gated=requests;assert.equal((await host.app.inject({method:'POST',url,headers})).statusCode,503);assert.equal(requests,gated);document.im.wechat=true;await writeFile(path,JSON.stringify(document))
  redirect=true;assert.equal((await host.app.inject({method:'POST',url,headers})).statusCode,502);assert.equal(requests,gated+1);redirect=false;status=500;payload={error:'synthetic-upstream-secret'};const failure=await host.app.inject({method:'POST',url,headers});assert.equal(failure.statusCode,502);assert.doesNotMatch(failure.body,/synthetic-upstream-secret/)
  noRedis=await startServer({...runtimeEnv,GUGU_WEBUI_REDIS_URL:'',GUGU_WEBUI_PORT:String(await freePort())});const noCalls=requests;assert.equal((await noRedis.app.inject({method:'POST',url,headers})).statusCode,503);assert.equal(requests,noCalls);assert.ok(targets.length>0);assert.ok(targets.every(target=>/^(?:\d+\.){3}\d+:443$/.test(target)||/^\[[0-9a-f:]+\]:443$/i.test(target)))
 }finally{abort.abort();await reader?.cancel().catch(()=>undefined);await noRedis?.close();await host?.close();for(const key of keys)await store.delete(key);for(const tunnel of tunnels)tunnel.destroy();await new Promise<void>(done=>proxy.close(()=>done()));await new Promise<void>(done=>relay.close(()=>done()));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
