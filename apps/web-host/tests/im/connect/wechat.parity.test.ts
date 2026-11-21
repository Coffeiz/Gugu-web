import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {Pool} from 'pg'
import {createServer} from 'node:https'
import {NodeProviderTransport} from '../../../../../packages/core/src/agent/providers/transport/node.js'
import {createPostgresRuntime} from '../../../../../packages/core/src/data/postgres.js'
import {createWechatConnector} from '../../../src/modules/im/connect/platforms/wechat/index.js'
import {createRedisExpiringValueStore} from '../../../src/adapters/cache/redis-events.js'
import {encryptEncryptedString,decryptEncryptedString} from '../../../src/adapters/security/encrypted-string.js'
import type {ProviderHttpRequest,ProviderTransport} from '../../../../../packages/core/src/agent/providers/contracts.js'

test('微信真实Python协议、owner挑战、加密PG与gateway消费，事务失败不清挑战或发布',async()=>{
 const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(databaseUrl);assert.ok(redisUrl);assert.ok(redisUrl.endsWith('/9'));if(!python)throw new Error('缺少 Python golden runner')
 const schema=`wechat_connect_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID(),secret='synthetic-wechat-secret',root=await mkdtemp(join(tmpdir(),'wechat-connect-')),path=join(root,'config.json'),admin=new Pool({connectionString:databaseUrl,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:3}),runtime=await createPostgresRuntime({url:databaseUrl,schema}),store=createRedisExpiringValueStore(redisUrl)
 const env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:path,GUGU_WEBUI_SECRET_KEY:secret,APP_SECRET:secret,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other}
 await writeFile(path,JSON.stringify({secret_key:secret,im:{wechat:true}}));execFileSync(python,[resolve('../../compat/support/qq_bot_create.py'),'setup'],{cwd:resolve('../../backend'),env})
 let task=randomUUID().replaceAll('-',''),payload:Record<string,unknown>={qrcode:'synthetic-challenge',qrcode_img_content:'https://scan.example.invalid/q/synthetic'},httpStatus=200,published=0;const requests:ProviderHttpRequest[]=[],keys:string[]=[]
 const cert=join(root,'cert.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'})
 const relay=createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(cert)},(_request,response)=>{response.setHeader('content-type','application/json');response.writeHead(httpStatus);response.end(JSON.stringify(payload))});await new Promise<void>(done=>relay.listen(0,'127.0.0.1',done));const address=relay.address();assert.ok(address&&typeof address!=='string')
 const network=new NodeProviderTransport({allowLocal:true,environment:()=>({SSL_CERT_FILE:cert})})
 const transport:ProviderTransport={request:async(request,signal)=>{requests.push(request);return network.request(request,signal)}}

 const connect=createWechatConnector(runtime.db,{transport,store,portalBase:`https://127.0.0.1:${address.port}`,allowLocal:true,generateId:()=>task,randomUin:()=>123,encrypt:value=>encryptEncryptedString(secret,value),platforms:()=>['wechat'],publishChanged:async who=>{assert.equal(who,owner);assert.equal(await store.get(`wechatconnect:${task}`),null);published++}})
 const reference=(action:string,who=owner)=>JSON.parse(execFileSync(python,[resolve('tests/im/fixtures/wechat_connect_python.py'),action],{cwd:resolve('../../backend'),env:{...env,TEST_OWNER:who,TEST_TASK:task,TEST_RESPONSE:JSON.stringify(payload),TEST_HTTP_STATUS:String(httpStatus)},encoding:'utf8'}))
 const start=async()=>{const result=await connect.start(owner);keys.push(`wechatconnect:${task}`);return result}
 try{
  const pythonStart=reference('start',other);keys.push(`wechatconnect:${task}`);assert.equal(pythonStart.result.scan_url,payload.qrcode_img_content)
  task=randomUUID().replaceAll('-','');const started=await start();assert.equal(started.task_id,task);assert.equal(started.scan_url,payload.qrcode_img_content);assert.doesNotMatch(JSON.stringify(started),/synthetic-challenge/)
  const request=requests.at(-1)!;assert.equal(new URL(request.url).pathname,pythonStart.requests[0].path);assert.deepEqual(Object.fromEntries(new URL(request.url).searchParams),{bot_type:'3'});assert.deepEqual(request.headers,pythonStart.requests[0].headers);assert.equal(request.timeoutMs,15000)
  assert.equal(JSON.parse((await store.get(keys.at(-1)!))!).uid,owner);const challenge=reference('state');assert.ok(challenge.ttl>580&&challenge.ttl<=600);assert.equal(challenge.owner,owner);const before=requests.length;await assert.rejects(()=>connect.poll(other,task),(e:any)=>e.statusCode===403);assert.equal(requests.length,before)
  assert.deepEqual(await connect.poll(owner,'missing'),{status:'expired'})
  payload={status:'scanned'};assert.deepEqual(await connect.poll(owner,task),{status:'waiting'});assert.equal(requests.at(-1)!.timeoutMs,60000)
  payload={status:'confirmed',baseurl:'https://api.example.invalid',bot_token:'synthetic-wechat-token'}
  const result=await connect.poll(owner,task);assert.equal(result.status,'success');assert.equal(published,1);assert.equal(await store.get(keys.at(-1)!),null)
  const row=(await pool.query('SELECT * FROM user_bots WHERE user_id=$1',[owner])).rows[0];assert.match(row.app_secret,/^gcm1:/);assert.equal(decryptEncryptedString(secret,row.app_secret),'synthetic-wechat-token');assert.equal(row.app_id,payload.baseurl)
  const consumed=reference('consume');assert.equal(consumed.secret_sha,createHash('sha256').update('synthetic-wechat-token').digest('hex'));assert.equal(consumed.gateway_token_sha,consumed.secret_sha);assert.equal(consumed.gateway_base_url,payload.baseurl);assert.equal(consumed.owner,owner)
  const snapshots=(await pool.query('SELECT source,context_epoch FROM conversation_sessions WHERE user_id=$1 ORDER BY id',[owner])).rows;assert.equal(snapshots.find(row=>row.source==='web').context_epoch,4);assert.ok(snapshots.filter(row=>row.source!=='web').every(row=>row.context_epoch===5));assert.equal((await pool.query('SELECT context_epoch FROM conversation_sessions WHERE user_id=$1',[other])).rows[0].context_epoch,4)
  task=randomUUID().replaceAll('-','');payload={qrcode:'synthetic-retry',qrcode_img_content:'https://scan.example.invalid/q/retry'};await start();payload={status:'confirmed',baseurl:'https://changed.example.invalid',bot_token:'synthetic-replacement'}
  await pool.query("CREATE FUNCTION fail_wechat_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-secret';END $$;CREATE TRIGGER fail_wechat_write BEFORE UPDATE ON user_bots FOR EACH ROW EXECUTE FUNCTION fail_wechat_write()")
  await assert.rejects(()=>connect.poll(owner,task));assert.ok(await store.get(keys.at(-1)!));assert.equal(published,1);assert.equal((await pool.query('SELECT app_id FROM user_bots WHERE user_id=$1',[owner])).rows[0].app_id,'https://api.example.invalid')
  await pool.query('DROP TRIGGER fail_wechat_write ON user_bots');await Promise.all([connect.poll(owner,task),connect.poll(owner,task)]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_bots WHERE user_id=$1',[owner])).rows[0].n,1)
  task=randomUUID().replaceAll('-','');payload={qrcode:'synthetic-expired',qrcode_img_content:'https://scan.example.invalid/q/expired'};await start();payload={status:'expired'};assert.deepEqual(await connect.poll(owner,task),{status:'expired'});assert.equal(await store.get(keys.at(-1)!),null)
  task=randomUUID().replaceAll('-','');payload={qrcode:'synthetic-python',qrcode_img_content:'https://scan.example.invalid/q/python'};const py=reference('start',other);keys.push(`wechatconnect:${py.result.task_id}`);payload={status:'confirmed',bot_token:'synthetic-python-token',baseurl:'https://python.example.invalid'};assert.equal(reference('poll',other).result.status,'success')
 }finally{await network.close();await new Promise<void>(done=>relay.close(()=>done()));for(const key of keys)await store.delete(key);await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
