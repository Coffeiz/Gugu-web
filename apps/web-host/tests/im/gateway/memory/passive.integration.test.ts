import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {ProviderTransport} from '@gugu/core/providers'
import {createNodeImHostRuntime} from '../../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../../src/adapters/cache/redis-stream-commands.js'
import {createImReflectionCodec} from '../../../../src/modules/im/gateway/memory/codec.js'
import {createImInboundEnvelope} from '../../../../src/modules/im/gateway/inbound/envelope.js'
import {imConversationScopeHash,imConversationDigest,imConversationFingerprint} from '../../../../src/modules/im/gateway/agent/identity.js'
import {encryptEncryptedString} from '../../../../src/adapters/security/encrypted-string.js'
import {reflectionFileKey} from '../../../../src/modules/im/gateway/memory/files.js'
import type {ImReflectionJob,ImReflectionService} from '../../../../src/modules/im/gateway/memory/contracts.js'
import {createImProductionFixture} from '../production.fixtures.js'
const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
function blocked(signal:AbortSignal):Promise<never>{return new Promise((_resolve,reject)=>{if(signal.aborted)reject(Error('合成轮询停止'));else signal.addEventListener('abort',()=>reject(Error('合成轮询停止')),{once:true})})}
async function until(check:()=>Promise<boolean>,detail:()=>Promise<unknown>){for(let i=0;i<1200;i++){if(await check())return;await delay(25)}assert.fail(JSON.stringify(await detail()))}

test('正式被动群反思：连续50条窗口/owner与member隔离/idle收束/重启等待新真实Run恢复',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需专用隔离PG/Redis和离线ORM解释器',timeout:180000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,reflection:ImReflectionService|undefined,baseline:Set<string>|undefined
 let initial=true,wake:(()=>void)|undefined,packets:unknown[]|undefined,mainCalls=0,sent=0
 const diagnostics:string[]=[],requests:string[]=[]
 const packet=(n:number,active=n===0)=>({update_id:45000+n,message:{message_id:46000+n,date:Math.floor(Date.now()/1000),from:{id:active||n===50||n===101?202:404,first_name:'合成人物'},
   chat:{id:-404,type:'group',title:'合成反思群'},text:active?'@synthetic_bot 合成主动群问题':`合成被动群消息-${n}`,...(active?{entities:[{type:'mention',offset:0,length:14}]}:{})}})
 const provider:ProviderTransport={async request(request){const body=request.body as Record<string,unknown>
   assert.doesNotMatch(JSON.stringify(body),/合成停用群历史/,'不能读取另一个Bot/群的原始上下文')
   if(body.stream){mainCalls++;return response(`data: ${JSON.stringify({choices:[{delta:{content:'合成主动群回复'},finish_reason:'stop'}],usage:{prompt_tokens:mainCalls===1?31000:7,completion_tokens:2}})}\n\ndata: [DONE]\n\n`)}
   const wire=JSON.stringify(body);requests.push(wire)
   return response({choices:[{message:{content:JSON.stringify({summary:'合成反思结果',daily:'合成被动群日记'})},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3}})
 }}
 const platform:ProviderTransport={async request(request,signal){const path=new URL(request.url).pathname
  if(path.includes("/bot111111111:synthetic-disabled-group/")&&path.endsWith("/getUpdates"))return blocked(signal)
   if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
   if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
   if(path.endsWith('/getUpdates')){if(initial){initial=false;return response({ok:true,result:[packet(0)]})}
    if(!packets)await Promise.race([new Promise<void>(resolve=>wake=resolve),blocked(signal)])
    const result=packets;packets=undefined;return response({ok:true,result})}
   if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
   if(path.endsWith('/sendMessage')){sent++;return response({ok:true,result:{message_id:47000+sent}})}
   throw Error('未配置的合成反思平台请求')
 }}
 const detail=async()=>({mainCalls,sent,requests:requests.length,diagnostics,states:(await f.pool.query('SELECT * FROM gugu_im_reflection_trigger_states')).rows,
   windows:(await f.pool.query('SELECT reason,status FROM gugu_im_reflection_trigger_windows')).rows,jobs:(await f.pool.query('SELECT state,attempts FROM gugu_im_reflection_jobs')).rows})
 try{
  await f.pool.query('UPDATE user_bots SET group_requires_at=true,group_read_enabled=false,group_memory_enabled=true,member_memory_enabled=true,group_owner_memory_enabled=true WHERE user_id=$1 AND id=$2',[f.ownerId,f.botId])
  baseline=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-reflection-cleanup']) as string[])
  const make=()=>createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
    mcpRuntime:{async invalidate(){}},onReflection:value=>reflection=value,diagnose:code=>diagnostics.push(code),
    testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'9.9.9.9',family:4}]}}})
  runtime=make()
  await runtime.start()
  await until(async()=>sent===1&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===1,detail)
  const before=(await f.pool.query('SELECT idle_due_at::text,active_generation::text FROM gugu_im_reflection_trigger_states')).rows[0];assert.ok(before)
  packets=Array.from({length:49},(_,i)=>packet(i+1));wake?.()
  await until(async()=>Number((await f.pool.query('SELECT passive_count FROM gugu_im_reflection_trigger_states')).rows[0]?.passive_count)===49,detail)
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM gugu_im_reflection_trigger_windows')).rows[0].n,0)
  const after=(await f.pool.query('SELECT idle_due_at::text,active_generation::text FROM gugu_im_reflection_trigger_states')).rows[0]
  assert.deepEqual(after,before);assert.equal(mainCalls,1);assert.equal(requests.length,0)
  packets=[packet(50)];wake?.()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE reason='threshold' AND status='completed'")).rowCount===1,detail)
  assert.equal((await f.pool.query('SELECT passive_count FROM gugu_im_reflection_trigger_states')).rows[0].passive_count,0)
  // 只在合成库推进调度截止时间；调用实际后台服务执行，不替换Run/反思/FS端口。
  await f.pool.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp() WHERE state IN('pending','ready')")
  await until(async()=>requests.length===3&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state='completed'")).rowCount===3,detail)
  assert.equal(mainCalls,1);assert.equal(sent,1,'被动反思不能额外回复群聊')
  function assertTail(wires:string[],last:number){for(const wire of wires)for(let n=1;n<=last;n++)assert.equal((wire.match(new RegExp(`合成被动群消息-${n}(?![0-9])`,'gu'))??[]).length,1,'每条真实被动正文只在追加历史出现一次')}
  assertTail(requests,50)
  assert.deepEqual((await f.pool.query('SELECT scope_type FROM memory_reflection_cursors ORDER BY scope_type')).rows.map(row=>row.scope_type),['group','owner','platform-user'])
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM gugu_im_reflection_cursor_positions')).rows[0].n,3)
  const forceDue=()=>f.pool.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp() WHERE state IN('pending','ready','retry','deferred')")
  packets=Array.from({length:50},(_,i)=>packet(i+51));wake?.()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE reason='threshold' AND status='completed'")).rowCount===2,detail)
  await forceDue()
  await until(async()=>requests.length===5&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state='completed'")).rowCount===5,detail)
  assertTail(requests.slice(3),100)
  assert.equal((await f.pool.query('SELECT count(DISTINCT window_key)::integer AS n FROM gugu_im_reflection_jobs')).rows[0].n,3,'原Run及两个阈值窗口保留独立幂等键，第二个窗口不能被吞掉')
  packets=[packet(101),packet(102)];wake?.()
  await until(async()=>(await f.pool.query('SELECT passive_count FROM gugu_im_reflection_trigger_states')).rows[0]?.passive_count===2,detail)
  await f.pool.query("UPDATE gugu_im_reflection_trigger_states SET idle_due_at=clock_timestamp()-interval '1 second'")
  await reflection!.runOnce()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE reason='idle' AND status='completed'")).rowCount===1,detail)
  await forceDue()
  await until(async()=>requests.length===8&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state='completed'")).rowCount===8,detail)
  assertTail(requests.slice(5),102)
  const settled=(await f.pool.query('SELECT passive_count,idle_due_at FROM gugu_im_reflection_trigger_states')).rows[0]
  assert.deepEqual(settled,{passive_count:0,idle_due_at:null})
  // 重启丢失本地群快照后，持久窗口等待真实新Run，不冷造前缀。
  await runtime.stop();runtime=undefined
  packets=Array.from({length:50},(_,i)=>packet(i+103));runtime=make();await runtime.start()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE reason='threshold' AND status='completed'")).rowCount===3,detail)
  await forceDue()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state='deferred'")).rowCount===2,detail)
  assert.equal(requests.length,8);assert.equal(mainCalls,1)
  packets=[packet(153,true)];wake?.()
  await until(async()=>mainCalls===2&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===2,detail)
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE status='pending'")).rowCount===0,detail)
  await forceDue()
  await until(async()=>requests.length===11,detail)
  await forceDue()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state IN('pending','ready','retry','deferred','running','prepared')")).rowCount===0,detail)
  assert.equal(sent,2);assert.equal(requests.length,11,'旧窗口由新真实Run覆盖后不重复请求反思Provider')
  const codec=createImReflectionCodec(f.secretKey)
  for(const row of(await f.pool.query("SELECT * FROM gugu_im_reflection_jobs WHERE state='completed'")).rows){const job=codec.open(row,row.nonce,row.payload,'job') as ImReflectionJob
   assert.match(await readFile(join(f.storageRoot,reflectionFileKey(job,'summary')),'utf8'),/合成反思结果/)}
  assert.equal(await reflection!.runOnce(),false);assert.equal(requests.length,11)
 }finally{try{await runtime?.stop()}finally{
  if(baseline)for(const key of(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-reflection-cleanup']) as string[]).filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])
  await redis.close();await f.close()
 }}
})

test('纯被动50条仅保留持久窗口，重启后真实主动Run提供完整前缀才反思；idle补齐主动回合',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需专用隔离PG/Redis及离线ORM解释器',timeout:120000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,baseline:Set<string>|undefined,served=false,mainCalls=0,sent=0,reflectionCalls=0
 const diagnostics:string[]=[]
 const message=(n:number,active=false)=>({update_id:55000+n,message:{message_id:56000+n,date:Math.floor(Date.now()/1000),from:{id:active||n===50?202:404,first_name:'合成人物'},
  chat:{id:-505,type:'group'},text:active?'@synthetic_bot 合成冷启动主动消息':`合成冷启动被动消息-${n}`,...(active?{entities:[{type:'mention',offset:0,length:14}]}:{})}})
 let wave:unknown[]=Array.from({length:50},(_,i)=>message(i+1))
 const provider:ProviderTransport={async request(request){const body=request.body as Record<string,unknown>
  if(body.stream){mainCalls++;return response(`data: ${JSON.stringify({choices:[{delta:{content:'合成冷启动群回复'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)}
  reflectionCalls++
  const wire=JSON.stringify(body)
  for(let n=1;n<=50;n++)assert.equal((wire.match(new RegExp(`合成冷启动被动消息-${n}(?![0-9])`,'gu'))??[]).length,1,'反思必须复用包含真实被动历史的主Run前缀')
  return response({choices:[{message:{content:JSON.stringify({summary:'合成冷启动反思结果'})},finish_reason:'stop'}]})
 }}
 const platform:ProviderTransport={async request(request,signal){const path=new URL(request.url).pathname
  if(path.includes("/bot111111111:synthetic-disabled-group/")&&path.endsWith("/getUpdates"))return blocked(signal)
  if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
  if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
  if(path.endsWith('/getUpdates')){if(path.includes('111111111:synthetic-disabled-group'))return blocked(signal);if(served)return blocked(signal);served=true;return response({ok:true,result:wave})}
  if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
  if(path.endsWith('/sendMessage')){sent++;return response({ok:true,result:{message_id:57000+sent}})}
  throw Error('未配置的合成冷启动平台请求')
 }}
 const make=()=>createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
  mcpRuntime:{async invalidate(){}},diagnose:code=>diagnostics.push(code),testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'9.9.9.9',family:4}]}}})
 const detail=async()=>({mainCalls,sent,reflectionCalls,diagnostics,windows:(await f.pool.query('SELECT reason,status,run_id FROM gugu_im_reflection_trigger_windows')).rows,
  jobs:(await f.pool.query('SELECT state,attempts FROM gugu_im_reflection_jobs')).rows})
 try{
  await f.pool.query('UPDATE user_bots SET group_requires_at=true,group_read_enabled=false,group_memory_enabled=true,member_memory_enabled=true,group_owner_memory_enabled=true WHERE user_id=$1 AND id=$2',[f.ownerId,f.botId])
  const otherBot=await f.insert('user_bots',{user_id:f.ownerId,platform:'telegram',name:'合成停用群Bot',enabled:true,app_id:'synthetic-disabled-group',
    app_secret:encryptEncryptedString(f.secretKey,'111111111:synthetic-disabled-group'),owner_platform_user_id:'202',group_chat_enabled:false,group_memory_enabled:true})
  const disabled=await f.insert('conversation_sessions',{user_id:f.ownerId,source:'telegram',bot_id:String(otherBot.id),chat_type:'group',chat_id:'-606'})
  const binding={ownerId:f.ownerId,platform:'telegram' as const,botId:String(otherBot.id)},envelope=createImInboundEnvelope(f.secretKey)
  // 最早128条来自随后停用的群，且历史观察通知丢失；不能占满恢复扫描并阻塞后面的正常群。
  for(let i=0;i<128;i++){
    const payload={owner_user_id:f.ownerId,platform:'telegram',bot_id:String(otherBot.id),channel_id:String(otherBot.id),chat_type:'group',chat_id:'-606',platform_user_id:'404',text:'合成停用群历史',message_id:String(66000+i),platform_message_id:String(66000+i)}
    const m=await f.insert('conversation_messages',{session_id:disabled.id,conversation_seq:i+1,role:'user',content:payload.text,platform_user_id:'404',chat_type:'group',im_platform_message_id:payload.message_id})
    const hash=imConversationScopeHash(f.secretKey,binding,payload)
    await f.pool.query(`INSERT INTO gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,session_id,message_id,state,sealed_payload)
      VALUES($1,'telegram',$2,'group',$3,$4,$5,$6,$7,'passive',$8::jsonb)`,[f.ownerId,String(otherBot.id),hash,imConversationDigest(f.secretKey,[hash,'404',payload.message_id]),
      imConversationFingerprint(f.secretKey,hash,payload,[]),disabled.id,m.id,JSON.stringify(envelope.seal(binding,payload))])
  }
  await f.pool.query("CREATE FUNCTION synthetic_observation_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.kind='passive' THEN RAISE EXCEPTION 'synthetic-observation-failure';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_observation_failure BEFORE INSERT ON gugu_im_reflection_trigger_observed FOR EACH ROW EXECUTE FUNCTION synthetic_observation_failure()")
  baseline=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-cold-reflection-cleanup']) as string[])
  runtime=make();await runtime.start()
  await until(async()=>(await f.pool.query("SELECT 1 FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND s.bot_id=$2 AND m.role='user'",[f.ownerId,f.botId])).rowCount===50,detail)
  assert.equal((await f.pool.query('SELECT 1 FROM gugu_im_reflection_trigger_windows')).rowCount,0,'观察故障不能假记为已观察，也不能回滚已经接收的消息')
  await f.pool.query('DROP TRIGGER synthetic_observation_failure ON gugu_im_reflection_trigger_observed;DROP FUNCTION synthetic_observation_failure()')
  await f.pool.query('UPDATE gugu_im_reflection_trigger_states SET observe_after=clock_timestamp()')
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE reason='threshold' AND status='pending' AND run_id IS NULL")).rowCount===1,detail)
  assert.equal((await f.pool.query('SELECT 1 FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[disabled.id])).rowCount,0,'已停用群不进入观察恢复或占用backoff状态')
  const passive=(await f.pool.query('SELECT passive_count,idle_due_at,last_active_run_id FROM gugu_im_reflection_trigger_states')).rows[0]
  assert.deepEqual(passive,{passive_count:0,idle_due_at:null,last_active_run_id:null})
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM agent_run_checkpoints')).rows[0].n,0)
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM agent_run_dispatch')).rows[0].n,0)
  assert.equal(mainCalls+reflectionCalls+sent,0)
  await runtime.stop();runtime=undefined
  wave=[message(51,true)];served=false;runtime=make();await runtime.start()
  await until(async()=>sent===1&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE reason='threshold' AND status='completed'")).rowCount===1,detail)
  await f.pool.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp() WHERE state IN('pending','ready')")
  await until(async()=>reflectionCalls===3&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state='completed'")).rowCount===3,detail)
  await f.pool.query("UPDATE gugu_im_reflection_trigger_states SET idle_due_at=clock_timestamp()-interval '1 second'")
  await until(async()=>reflectionCalls===5&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE reason='idle' AND status='completed'")).rowCount===1,detail)
  assert.equal(mainCalls,1);assert.equal(sent,1)
 }finally{try{await runtime?.stop()}finally{
  if(baseline)for(const key of(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-cold-reflection-cleanup']) as string[]).filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])
  await redis.close();await f.close()
 }}
})
