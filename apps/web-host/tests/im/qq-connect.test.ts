import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,randomBytes,createCipheriv,createHash} from 'node:crypto'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync,execFile} from 'node:child_process'
import {createServer} from 'node:https'
import {Pool} from 'pg'
import {createPostgresRuntime} from '../../../../packages/core/src/data/postgres.js'
import {createQqConnector} from '../../../../packages/core/src/im/qq-connect.js'
import {NodeProviderTransport} from '../../../../packages/core/src/agent/providers/transport/node.js'
import {createRedisExpiringValueStore} from '../../src/adapters/cache/redis-events.js'
import {encryptEncryptedString,decryptEncryptedString} from '../../src/adapters/security/encrypted-string.js'
import {createQqConnectHostOptions} from '../../src/modules/im/qq-connect.js'
import {temporarySmtp} from '../admin/fixtures/temporary-smtp.js'
test('QQ扫码完整HTTP→Redis挑战→AES解密→PG加密持久化，隔离owner、过期、碰撞和失败副作用',async()=>{
 const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(url);assert.ok(redisUrl);assert.ok(python)
 const schema=`qq_connect_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID(),secret='synthetic-qq-connect-key',root=await mkdtemp(join(tmpdir(),'qq-connect-')),smtp=await temporarySmtp(root),path=join(root,'override.json')
 const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:3}),runtime=await createPostgresRuntime({url,schema}),env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:join(root,'absent.env'),GUGU_CONFIG_OVERRIDE_FILE:path,GUGU_WEBUI_SECRET_KEY:secret,APP_SECRET:secret,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other}
 await writeFile(path,JSON.stringify({secret_key:secret,im:{qq:true}}));execFileSync(python,[resolve('../../compat/support/qq_bot_create.py'),'setup'],{cwd:resolve('../../backend'),env})
 const store=createRedisExpiringValueStore(redisUrl),keys:string[]=[],requests:string[]=[];let task=`synthetic-${randomUUID()}`,status=0,remoteError=false,redirect=false,appId='synthetic-qq-app',badCipher=false;const taskKeys=new Map<string,string>()
 const server=createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(smtp.cert)},async(req,res)=>{
  requests.push(req.url!);let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw)
  res.setHeader('content-type','application/json')
  if(redirect){res.writeHead(302,{location:'/credentials'});res.end('synthetic-secret');return}
  if(remoteError){res.writeHead(500);res.end('synthetic-secret');return}
  if(req.url==='/lite/create_bind_task'){taskKeys.set(task,body.key);res.end(JSON.stringify({retcode:0,data:{task_id:task}}));return}
  const key=Buffer.from(taskKeys.get(body.task_id)!,'base64'),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([iv,cipher.update('synthetic-qq-secret'),cipher.final(),cipher.getAuthTag()]).toString('base64')
  res.end(JSON.stringify({retcode:0,data:{status,bot_appid:appId,bot_encrypt_secret:badCipher?'broken':encrypted}}))
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address();assert.ok(addr&&typeof addr!=='string');const base=`https://127.0.0.1:${addr.port}`
 const transport=new NodeProviderTransport({allowLocal:true,environment:()=>({SSL_CERT_FILE:smtp.cert})});let notifications=0
 const connect=createQqConnector(runtime.db,{transport,store,portalBase:base,allowLocal:true,generateKey:()=>randomBytes(32).toString('base64'),encrypt:value=>encryptEncryptedString(secret,value),platforms:()=>['qq'],publishChanged:async who=>{assert.equal(who,owner);assert.equal(await store.get(`qqconnect:${task}`),null);notifications++}})
 async function reference(action:string,who:string){const child=execFile(python!,[resolve('tests/im/fixtures/qq_connect_python.py'),action],{cwd:resolve('../../backend'),env:{...env,TEST_OWNER:who,TEST_QQ_PORTAL:base,TEST_TASK:task,SSL_CERT_FILE:smtp.cert},timeout:20000});return new Promise<any>((yes,no)=>{let out='',err='';child.stdout!.on('data',c=>out+=c);child.stderr!.on('data',c=>err+=c);child.on('exit',code=>code===0?yes(JSON.parse(out)):no(Error(err)))})}
 const start=async()=>{const result=await connect.start(owner);keys.push(`qqconnect:${result.task_id}`);return result}
 try{
  const first=await start();assert.equal(first.task_id,task);const scan=new URL(first.scan_url);assert.equal(scan.pathname,'/qqbot/openclaw/connect.html');assert.equal(scan.searchParams.get('source'),'Gugu');assert.equal(scan.searchParams.get('_wv'),'2');assert.equal(first.scan_url.includes(taskKeys.get(task)!),false)
  const unavailable=createQqConnectHostOptions({QQ_PORTAL_HOST:new URL(base).host,SSL_CERT_FILE:smtp.cert},'')
  const noRedis=createQqConnector(runtime.db,{...unavailable,encrypt:value=>encryptEncryptedString(secret,value),platforms:()=>['qq'],publishChanged:async()=>{}})
  const noRedisBefore=requests.length;try{await assert.rejects(noRedis.start(owner),(error:any)=>error.statusCode===503);assert.equal(requests.length,noRedisBefore,'未配置Redis不得先创建上游挑战')}finally{await unavailable.transport.close()}
  const initial=await store.get(keys[0]!);assert.ok(initial);assert.equal(JSON.parse(initial).uid,owner)
  await assert.rejects(connect.start(other));assert.equal(await store.get(keys[0]!),initial,'上游重复task_id不能覆盖原有owner密钥');taskKeys.set(task,JSON.parse(initial).key)
  const before=requests.length;await assert.rejects(connect.poll(other,task),(e:any)=>e.statusCode===403);assert.equal(requests.length,before)
  assert.deepEqual(await connect.poll(owner,task),{status:'waiting'});status=2;badCipher=true;assert.deepEqual(await connect.poll(owner,task),{status:'fail',reason:'secret 解密失败'});assert.equal(await store.get(keys[0]!),initial);assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_bots')).rows[0].n,0)
  badCipher=false;const result=await connect.poll(owner,task);assert.equal(result.status,'success');assert.equal(notifications,1);const row=(await pool.query('SELECT * FROM user_bots WHERE user_id=$1',[owner])).rows[0];assert.equal(row.app_id,appId);assert.match(row.app_secret,/^gcm1:/);assert.equal(decryptEncryptedString(secret,row.app_secret),'synthetic-qq-secret');assert.equal(await store.get(keys[0]!),null);assert.deepEqual(await connect.poll(owner,task),{status:'expired'})
  const consumed=JSON.parse(execFileSync(python,[resolve('../../compat/support/qq_bot_create.py'),'consume'],{cwd:resolve('../../backend'),env:{...env,TEST_BOT:String(row.id)},encoding:'utf8'}));assert.equal(consumed.gateway_secret_sha,consumed.expected_secret_sha);assert.equal(consumed.gateway_app_id,appId)
  assert.equal((await pool.query("SELECT min(context_epoch)::int AS epoch FROM conversation_sessions WHERE user_id=$1 AND source<>'web'",[owner])).rows[0].epoch,5)
  task=`synthetic-${randomUUID()}`;await start();await pool.query('UPDATE user_bots SET enabled=false WHERE id=$1',[row.id]);assert.equal((await connect.poll(owner,task)).status,'success');assert.equal((await pool.query('SELECT enabled FROM user_bots WHERE id=$1',[row.id])).rows[0].enabled,true);assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_bots')).rows[0].n,1)
  task=`synthetic-${randomUUID()}`;appId='different-app';await start();assert.deepEqual(await connect.poll(owner,task),{status:'fail',reason:'每个咕咕账号只能绑定一个 QQ 机器人'});assert.equal(await store.get(keys.at(-1)!),null)
  task=`synthetic-${randomUUID()}`;await start();status=3;assert.deepEqual(await connect.poll(owner,task),{status:'expired'});assert.equal(await store.get(keys.at(-1)!),null)
  task=`synthetic-${randomUUID()}`;appId='synthetic-qq-app';status=2;await start()
  const epochBefore=(await pool.query("SELECT context_epoch FROM conversation_sessions WHERE user_id=$1 AND source='qq'",[owner])).rows[0].context_epoch,notificationsBefore=notifications
  await pool.query('UPDATE user_bots SET enabled=false WHERE user_id=$1',[owner])
  await pool.query("CREATE FUNCTION fail_qq_scan_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic transaction failure'; END $$;CREATE TRIGGER fail_qq_scan_update BEFORE UPDATE ON user_bots FOR EACH ROW EXECUTE FUNCTION fail_qq_scan_update()")
  await assert.rejects(connect.poll(owner,task));assert.equal((await pool.query('SELECT enabled FROM user_bots WHERE user_id=$1',[owner])).rows[0].enabled,false);assert.ok(await store.get(keys.at(-1)!));assert.equal(notifications,notificationsBefore);assert.equal((await pool.query("SELECT context_epoch FROM conversation_sessions WHERE user_id=$1 AND source='qq'",[owner])).rows[0].context_epoch,epochBefore)
  await pool.query('DROP TRIGGER fail_qq_scan_update ON user_bots')
  const raced=await Promise.all([connect.poll(owner,task),connect.poll(owner,task)]);assert.ok(raced.some(value=>value.status==='success'));assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_bots WHERE user_id=$1',[owner])).rows[0].n,1)
  task=`synthetic-${randomUUID()}`;await start();await pool.query('UPDATE user_bots SET enabled=false WHERE user_id=$1',[owner])
  let failureNotified=0
  const broken=createQqConnector(runtime.db,{transport,store:{...store,delete:async()=>{throw Error('synthetic-secret')}},portalBase:base,allowLocal:true,generateKey:()=>randomBytes(32).toString('base64'),encrypt:value=>encryptEncryptedString(secret,value),platforms:()=>['qq'],publishChanged:async()=>{failureNotified++}})
  await assert.rejects(broken.poll(owner,task),(error:any)=>error.statusCode===503&&!error.message.includes('synthetic-secret'));assert.equal((await pool.query('SELECT enabled FROM user_bots WHERE user_id=$1',[owner])).rows[0].enabled,true,'Redis清理失败不能撤销已经提交的凭据');assert.ok(await store.get(keys.at(-1)!));assert.equal(failureNotified,0)
  task=`synthetic-${randomUUID()}`;appId='synthetic-python-app';status=0
  const pythonStart=await reference('start',other);keys.push(`qqconnect:${pythonStart.result.task_id}`);assert.equal(pythonStart.owner,other);assert.equal(pythonStart.key_bytes,32);assert.ok(pythonStart.ttl>580&&pythonStart.ttl<=600);assert.equal(new URL(pythonStart.result.scan_url).pathname,'/qqbot/openclaw/connect.html');assert.deepEqual((await reference('poll',other)).result,{status:'waiting'})
  status=2;const pythonSuccess=await reference('poll',other);assert.equal(pythonSuccess.result.status,'success');assert.equal(pythonSuccess.secret_sha,createHash('sha256').update('synthetic-qq-secret').digest('hex'));assert.equal(pythonSuccess.publications,1);assert.equal(await store.get(keys.at(-1)!),null)
  assert.equal((await pool.query('SELECT context_epoch FROM conversation_sessions WHERE user_id=$1',[other])).rows[0].context_epoch,5)
  remoteError=true;await assert.rejects(connect.start(owner),(e:any)=>e.statusCode===502&&!e.message.includes('synthetic-secret'));remoteError=false;redirect=true;await assert.rejects(connect.start(owner));assert.equal(requests.includes('/credentials'),false)
 }finally{for(const key of keys)await store.delete(key);await transport.close();await new Promise<void>(r=>server.close(()=>r()));await smtp.close();await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
