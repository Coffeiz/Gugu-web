import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {PoolClient} from 'pg'
import type {CanonicalRunContext} from '@gugu/core/agent'
import {createAgentRunCodec} from '@gugu/core/agent/run/codec'
import type {ProviderTransport} from '@gugu/core/providers'
import {createNodeImHostRuntime} from '../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../src/adapters/cache/redis-stream-commands.js'
import {createImReflectionCodec} from '../../../src/modules/im/gateway/reflection-codec.js'
import {reflectionFileKey} from '../../../src/modules/im/gateway/reflection-files.js'
import type {ImReflectionJob} from '../../../src/modules/im/gateway/reflection-contracts.js'
import {decryptAgentDispatchInput} from '../../../src/modules/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import {createImProductionFixture} from './production.fixtures.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
const blocked=(signal:AbortSignal):Promise<never>=>new Promise((_resolve,reject)=>{const stop=()=>reject(Error('合成混合批次轮询停止'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true})})
async function until(check:()=>Promise<boolean>,detail:()=>Promise<unknown>){for(let i=0;i<1200;i++){if(await check())return;await delay(25)}assert.fail(JSON.stringify(await detail()))}

test('真实混合owner/member批次的被动反思：owner不误入成员记忆，后续solo owner前缀恢复owner窗口',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需专用隔离PG/Redis与离线ORM解释器',timeout:150000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,baseline:Set<string>|undefined,wake:(()=>void)|undefined
 let releaseGate:PoolClient|undefined,gateInstalled=false
 const gateBytes=randomBytes(8),gateKeys=[gateBytes.readInt32BE(0),gateBytes.readInt32BE(4)]
 async function openReleaseGate(){const client=releaseGate;if(!client)return;releaseGate=undefined
  try{await client.query('SELECT pg_advisory_unlock($1,$2)',gateKeys)}finally{client.release()}}
 let mainCalls=0,sent=0,initial=true,wave:unknown[]|undefined
 const diagnostics:string[]=[],reflections:{scope:'group'|'member'|'owner';wire:string}[]=[],mainWires:string[]=[]
 const groupId='-707',profilePath=join(f.storageRoot,f.ownerId,'.agent','profile.json'),summaryPath=join(f.storageRoot,f.ownerId,'.agent','summary.json')
 const privateMarker='合成owner私有配置哨兵',profile=JSON.stringify([{type:'note',text:privateMarker,ts:1}])
 function packet(n:number,sender:number,kind:'mixed'|'passive'|'owner'){
  // 当前Bot的单独mention按Python契约逐条成段；双Bot结构化mention才保留ordinary混合批次。
  const text=kind==='mixed'?`@synthetic_bot @other_bot 合成混合主动-${sender}`:kind==='owner'?'@synthetic_bot 合成solo-owner主动':'合成混合被动-'+n
  const entities=kind==='mixed'?[{type:'mention',offset:0,length:14},{type:'text_mention',offset:15,length:10,user:{id:999,is_bot:true,first_name:'合成其他Bot'}}]
   :kind==='owner'?[{type:'mention',offset:0,length:14}]:undefined
  return{update_id:75000+n,message:{message_id:76000+n,date:Math.floor(Date.now()/1000),from:{id:sender,first_name:sender===202?'合成owner':'合成member'},chat:{id:Number(groupId),type:'group'},text,...(entities?{entities}:{})}}
 }
 const provider:ProviderTransport={async request(request){const body=request.body as Record<string,unknown>,wire=JSON.stringify(body)
  if(body.stream){mainCalls++;mainWires.push(wire);return response(`data: ${JSON.stringify({choices:[{delta:{content:'合成混合群回复'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:2}})}\n\ndata: [DONE]\n\n`)}
  const messages=Array.isArray(body.messages)?body.messages:[],text=messages.flatMap(message=>message&&typeof message==='object'&&typeof message.content==='string'?[message.content]:[]).join('\n')
  const scopeMatch=/目标scope:(\{[^\n]+\})/u.exec(text);assert.ok(scopeMatch,'真实反思请求必须携带scope元数据')
  const scope=JSON.parse(scopeMatch[1]!) as {type:string;id:string}
  assert.ok(['owner','group','platform-user'].includes(scope.type))
  if(scope.type==='platform-user')assert.equal(scope.id,`${groupId}:404`,'owner不能作为成员反思目标')
  const kind=scope.type==='platform-user'?'member':scope.type as 'group'|'owner'
  reflections.push({scope:kind,wire})
  return response({choices:[{message:{content:JSON.stringify({summary:`合成${kind}窗口记忆`,daily:`合成${kind}窗口日记`})},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3}})
 }}
 const platform:ProviderTransport={async request(request,signal){const path=new URL(request.url).pathname
  if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
  if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
  if(path.endsWith('/getUpdates')){
   if(initial){initial=false;return response({ok:true,result:[packet(1,202,'mixed'),packet(2,404,'mixed')]})}
   if(!wave)await Promise.race([new Promise<void>(resolve=>wake=resolve),blocked(signal)])
   const packets=wave;wave=undefined;return response({ok:true,result:packets})
  }
  if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
  if(path.endsWith('/sendMessage')){sent++;return response({ok:true,result:{message_id:77000+sent}})}
  throw Error('未配置的合成混合反思平台请求')
 }}
 const reflectionCodec=createImReflectionCodec(f.secretKey),checkpointCodec=createAgentRunCodec(f.secretKey)
 async function jobs(){return(await f.pool.query('SELECT * FROM gugu_im_reflection_jobs ORDER BY created_at,id')).rows.map(row=>({row,job:reflectionCodec.open(row,row.nonce,row.payload,'job') as ImReflectionJob}))}
 const forceDue=()=>f.pool.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp() WHERE state IN('pending','ready','retry','deferred')")
 const detail=async()=>({mainCalls,sent,reflectionScopes:reflections.map(r=>r.scope),diagnostics,
  states:(await f.pool.query('SELECT active_generation,last_active_run_id FROM gugu_im_reflection_trigger_states')).rows,
  windows:(await f.pool.query('SELECT reason,status,next_attempt_at,run_id FROM gugu_im_reflection_trigger_windows')).rows,jobs:(await jobs()).map(({row,job})=>({state:row.state,scope:job.scope,role:job.actor.role}))})
 try{
  await mkdir(join(f.storageRoot,f.ownerId,'.agent'),{recursive:true});await writeFile(profilePath,profile)
  await f.pool.query('UPDATE user_bots SET group_requires_at=true,group_read_enabled=false,group_memory_enabled=true,member_memory_enabled=true,group_owner_memory_enabled=true WHERE user_id=$1 AND id=$2',[f.ownerId,f.botId])
  baseline=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-mixed-reflection-cleanup']) as string[])
  runtime=createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
   mcpRuntime:{async invalidate(){}},diagnose:code=>diagnostics.push(code),testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'9.9.9.9',family:4}]}}})
  await runtime.start()
  await until(async()=>sent===1&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===1,detail)
  const first=(await f.pool.query('SELECT * FROM agent_run_dispatch')).rows;assert.equal(first.length,1,'真实混合批次只能生成一个Run')
  const dispatch=decryptAgentDispatchInput(f.secretKey,{ownerId:f.ownerId,sessionId:String(first[0].session_id),runId:first[0].run_id},first[0].nonce,first[0].payload)
  assert.equal(dispatch.v,3);assert.equal(dispatch.source,'im');assert.ok(dispatch.v===3&&dispatch.source==='im');assert.equal(dispatch.im.batch?.messageIds.length,2)
  const checkpointRow=(await f.pool.query('SELECT * FROM agent_run_checkpoints')).rows[0]
  const checkpoint=checkpointCodec.decryptCheckpoint<CanonicalRunContext>({ownerId:f.ownerId,sessionId:String(checkpointRow.session_id),runId:checkpointRow.run_id},Number(checkpointRow.version),checkpointRow.nonce,checkpointRow.payload)
  assert.equal(checkpoint.status,'completed');assert.ok(checkpoint.context)
  const initialJobs=await jobs();assert.ok(initialJobs.length>=2)
  for(const{job}of initialJobs){assert.equal(job.actor.role,'member');assert.equal(job.actor.verifiedOwner,false)
   // 这里是混批后effective权限，两人均降为member；单人身份另由真实Bot绑定解析。
   assert.deepEqual(job.actor.speakerRoles?.map(speaker=>[speaker.platformUserId,speaker.role]).sort(),[['202','member'],['404','member']])}
  assert.doesNotMatch(JSON.stringify(checkpoint.context.prepared),new RegExp(privateMarker))
  assert.doesNotMatch(mainWires[0]!,new RegExp(privateMarker),'真实member最低权限不能加载owner个人记忆')
  const seeds=await jobs();assert.equal(seeds.length,2)
  for(const{job}of seeds){assert.equal(job.actor.role,'member');assert.deepEqual(job.actor.speakerRoles?.map(s=>[s.platformUserId,s.role]).sort(),[['202','member'],['404','member']])}
  assert.deepEqual(seeds.map(({job})=>job.scope).sort((a,b)=>a.type.localeCompare(b.type)),[{type:'group',id:groupId},{type:'platform-user',id:`${groupId}:404`}])
  wave=Array.from({length:50},(_,i)=>packet(i+3,i===49?202:404,'passive'));wake?.()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE reason='threshold' AND status='pending'")).rowCount===1&&(await jobs()).some(({job})=>job.scope.type==='platform-user'),detail)
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE next_attempt_at>clock_timestamp() AND status='pending'")).rowCount===1,detail)
  await forceDue()
  await until(async()=>reflections.length===2&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state='completed'")).rowCount===2,detail)
  assert.deepEqual(reflections.map(r=>r.scope).sort(),['group','member']);assert.equal(sent,1);assert.equal(mainCalls,1)
  for(const wire of reflections.map(r=>r.wire)){assert.doesNotMatch(wire,new RegExp(privateMarker));for(let n=3;n<=52;n++)assert.equal((wire.match(new RegExp(`合成混合被动-${n}(?![0-9])`,'gu'))??[]).length,1)}
  const prior=await jobs();assert.equal(prior.some(({job})=>job.scope.type==='platform-user'&&job.scope.id===`${groupId}:202`),false)
  assert.equal(prior.some(({job})=>job.scope.type==='owner'),false)
  assert.equal((await readFile(profilePath,'utf8')),profile);await assert.rejects(readFile(summaryPath),{code:'ENOENT'})
  assert.equal((await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE status='pending'")).rowCount,1,'无合格owner前缀不能吞掉owner窗口')
  const memberBefore=reflections.filter(r=>r.scope==='member').length
  // 只门控真实lease.release的Session清空；成功history/observeActive必须先实际提交，不能被此门阻塞。
  releaseGate=await f.pool.connect();await releaseGate.query('SELECT pg_advisory_lock($1,$2)',gateKeys)
  const gatePid=(await releaseGate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  await f.pool.query(`CREATE FUNCTION synthetic_hold_session_idle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF OLD.active_run_id IS NOT NULL AND NEW.active_run_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(TG_ARGV[0]::integer,TG_ARGV[1]::integer);
   END IF; RETURN NEW; END $$;
   CREATE TRIGGER synthetic_hold_session_idle BEFORE UPDATE ON conversation_sessions FOR EACH ROW
    EXECUTE FUNCTION synthetic_hold_session_idle('${gateKeys[0]}','${gateKeys[1]}')`)
  gateInstalled=true
  wave=[packet(53,202,'owner')];wake?.()
  await until(async()=>mainCalls===2&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===2
   &&Number((await f.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[gatePid])).rowCount)>0,detail)
  const held=(await f.pool.query('SELECT active_run_id,execution_state FROM conversation_sessions WHERE id=$1',[first[0].session_id])).rows[0]
  assert.ok(held.active_run_id);assert.equal(held.execution_state,'running','真实Run尚未提交lease释放，反思窗口必须看到busy')
  await until(async()=>Number((await f.pool.query(`SELECT extract(epoch FROM next_attempt_at-clock_timestamp()) AS seconds
   FROM gugu_im_reflection_trigger_windows WHERE status='pending' AND next_attempt_at>clock_timestamp()`)).rows[0]?.seconds)>0,detail)
  const postponed=(await f.pool.query(`SELECT extract(epoch FROM next_attempt_at-clock_timestamp()) AS seconds
   FROM gugu_im_reflection_trigger_windows WHERE status='pending'`)).rows[0]
  assert.ok(Number(postponed.seconds)<=5,'临时Session忙只能短重试，不能误用缺少快照的240秒延期')
  await openReleaseGate()
  await f.pool.query('DROP TRIGGER synthetic_hold_session_idle ON conversation_sessions;DROP FUNCTION synthetic_hold_session_idle()');gateInstalled=false
  assert.match(mainWires[1]!,new RegExp(privateMarker),'solo owner授权前缀应实际读取owner记忆')
  await until(async()=>sent===2&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE status='pending'")).rowCount===0,detail)
  await forceDue()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state IN('pending','ready','retry','deferred','running','prepared')")).rowCount===0,detail)
  assert.ok(reflections.some(r=>r.scope==='owner'),'后续真实owner快照必须完成owner记忆反思')
  assert.equal(reflections.filter(r=>r.scope==='member').length,memberBefore,'旧member窗口已由Seq游标覆盖，不能重复请求')
  assert.match(await readFile(summaryPath,'utf8'),/合成owner窗口记忆/)
  const completed=await jobs();assert.equal(completed.some(({job})=>job.scope.type==='platform-user'&&job.scope.id===`${groupId}:202`),false)
  for(const{job}of completed.filter(value=>value.job.scope.type==='owner')){assert.equal(job.actor.role,'owner');assert.equal(job.actor.verifiedOwner,true)}
  for(const{row,job}of completed)if(row.state==='completed')assert.match(await readFile(join(f.storageRoot,reflectionFileKey(job,'summary')),'utf8'),/合成(?:group|member|owner)窗口记忆/)
  assert.equal(sent,2,'反思只能更新文件，不产生额外群回复')
 }finally{try{
  await openReleaseGate()
  if(gateInstalled)await f.pool.query('DROP TRIGGER synthetic_hold_session_idle ON conversation_sessions;DROP FUNCTION synthetic_hold_session_idle()')
  await runtime?.stop()
 }finally{
  if(baseline)for(const key of(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-mixed-reflection-cleanup']) as string[]).filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])
  await redis.close();await f.close()
 }}
})
