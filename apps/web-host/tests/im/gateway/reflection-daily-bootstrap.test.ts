import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {ProviderTransport} from '@gugu/core/providers'
import {parseGroupDailyEntries,renderGroupDailyEntries} from '@gugu/core/im-group-daily-compaction'
import {createNodeImHostRuntime} from '../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../src/adapters/cache/redis-stream-commands.js'
import {imMemoryMaintenanceScopeFileKey} from '../../../src/modules/admin/memory-apply.js'
import {createImProductionFixture} from './production.fixtures.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
const blocked=(signal:AbortSignal):Promise<never>=>new Promise((_resolve,reject)=>{const stop=()=>reject(Error('合成沉淀轮询停止'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true})})
async function until(check:()=>Promise<boolean>,detail:()=>Promise<unknown>){for(let i=0;i<1200;i++){if(await check())return;await delay(25)}assert.fail(JSON.stringify(await detail()))}

test('正式群daily沉淀：250条分批、文件计划事务失败恢复、Provider空结果保留、跨进程不依赖主快照',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需任务专用隔离PG/Redis与离线ORM解释器',timeout:180000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,baseline:Set<string>|undefined,initial=true,mainCalls=0,sent=0,reflectionCalls=0,compactionCalls=0,failSecond=true
 const diagnostics:string[]=[],batches:number[]=[]
 const scope={owner_user_id:f.ownerId,platform:'telegram',bot_id:f.botId,scope_type:'group' as const,scope_id:'-909'}
 const dailyPath=join(f.storageRoot,imMemoryMaintenanceScopeFileKey(scope,'daily.md')),memoryPath=join(f.storageRoot,imMemoryMaintenanceScopeFileKey(scope,'memory.md'))
 const detail=async()=>({mainCalls,sent,reflectionCalls,compactionCalls,batches,diagnostics,jobs:(await f.pool.query('SELECT window_key,state,attempts,plan_payload IS NOT NULL AS planned FROM gugu_im_reflection_jobs ORDER BY created_at')).rows})
 const provider:ProviderTransport={async request(request){const body=request.body as Record<string,unknown>
  if(body.stream){mainCalls++;return response(`data: ${JSON.stringify({choices:[{delta:{content:'合成沉淀主回复'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:2}})}\n\ndata: [DONE]\n\n`)}
  const messages=Array.isArray(body.messages)?body.messages:[],texts=messages.flatMap(message=>message&&typeof message==='object'&&typeof message.content==='string'?[message.content]:[])
  const delta=texts.find(text=>text.startsWith('已有长期记忆：\n'))
  let output:unknown
  if(delta){compactionCalls++;assert.equal(messages.length,2,'独立沉淀仅有正式system与范围记忆，不能伪造主请求快照');assert.ok(!Array.isArray(body.tools)||body.tools.length===0,'沉淀不能调用工具')
   const split=delta.indexOf('\n\n近期群聊记录：\n');assert.ok(split>=0)
   const prior=delta.slice('已有长期记忆：\n'.length,split),daily=delta.slice(split+'\n\n近期群聊记录：\n'.length)
   batches.push(parseGroupDailyEntries(daily).length)
   output=failSecond&&compactionCalls===2?{memory:''}:{memory:`${prior}\n\n## 记录长期记忆：合成沉淀批次-${compactionCalls}\n\n${daily}`}
  }else{reflectionCalls++;output={summary:'合成群公开摘要',daily:'合成新增群记录'}}
  return response({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3}})
 }}
 const platform:ProviderTransport={async request(request,signal){const path=new URL(request.url).pathname
  if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
  if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
  if(path.endsWith('/getUpdates')){if(!initial)return blocked(signal);initial=false;return response({ok:true,result:[{update_id:98001,message:{message_id:98002,date:Math.floor(Date.now()/1000),from:{id:404,first_name:'合成人物'},chat:{id:-909,type:'group'},text:'@synthetic_bot 合成沉淀问题',entities:[{type:'mention',offset:0,length:14}]}}]})}
  if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
  if(path.endsWith('/sendMessage')){sent++;return response({ok:true,result:{message_id:98003}})}
  throw Error('未配置的合成沉淀平台请求')
 }}
 const make=()=>createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},mcpRuntime:{async invalidate(){}},diagnose:code=>diagnostics.push(code),testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'9.9.9.9',family:4}]}}})
 const forceDue=()=>f.pool.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp() WHERE state IN('pending','ready','retry','deferred')")
 try{
  await f.pool.query('UPDATE user_bots SET group_requires_at=true,group_read_enabled=false,group_memory_enabled=true,member_memory_enabled=false,group_owner_memory_enabled=false WHERE user_id=$1 AND id=$2',[f.ownerId,f.botId])
  await mkdir(dirname(dailyPath),{recursive:true});await writeFile(dailyPath,renderGroupDailyEntries(Array.from({length:249},(_,i)=>['2026-01-01',`合成待沉淀-${i}`] as [string,string])))
  await f.pool.query(`CREATE FUNCTION synthetic_reject_daily_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.window_key LIKE 'daily:%' AND NEW.state='completed' THEN RAISE EXCEPTION 'synthetic-daily-finish';END IF;RETURN NEW;END $$;
   CREATE TRIGGER synthetic_reject_daily_finish BEFORE UPDATE ON gugu_im_reflection_jobs FOR EACH ROW EXECUTE FUNCTION synthetic_reject_daily_finish()`)
  baseline=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-daily-cleanup']) as string[])
  runtime=make();await runtime.start()
  await until(async()=>sent===1&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state='ready'")).rowCount===1,detail)
  await forceDue()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE window_key LIKE 'daily:%' AND state='retry' AND plan_payload IS NOT NULL")).rowCount===1,detail)
  assert.equal(reflectionCalls,1);assert.equal(compactionCalls,1);assert.equal(parseGroupDailyEntries(await readFile(dailyPath,'utf8')).length,150)
  const firstMemory=await readFile(memoryPath,'utf8')
  await f.pool.query('DROP TRIGGER synthetic_reject_daily_finish ON gugu_im_reflection_jobs;DROP FUNCTION synthetic_reject_daily_finish()')
  await runtime.stop();runtime=make();await runtime.start();await forceDue()
  await until(async()=>compactionCalls===2&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE window_key LIKE 'daily:%' AND state='retry' AND plan_payload IS NULL")).rowCount===1,detail)
  assert.equal(reflectionCalls,1,'恢复已写计划不能重发反思');assert.equal(await readFile(memoryPath,'utf8'),firstMemory)
  assert.equal(parseGroupDailyEntries(await readFile(dailyPath,'utf8')).length,150,'无效模型结果不能删本批daily')
  failSecond=false;await runtime.stop();runtime=make();await runtime.start();await forceDue()
  await until(async()=>compactionCalls===4&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state NOT IN('completed','cancelled','dead')")).rowCount===0,detail)
  assert.deepEqual(batches,[100,100,100,50]);assert.equal(await readFile(dailyPath,'utf8'),'')
  const memory=await readFile(memoryPath,'utf8')
  for(let i=0;i<249;i++)assert.equal((memory.match(new RegExp(`合成待沉淀-${i}(?![0-9])`,'gu'))??[]).length,1)
  assert.equal((memory.match(/合成新增群记录/gu)??[]).length,1);assert.equal(mainCalls,1);assert.equal(reflectionCalls,1);assert.equal(sent,1)
  assert.equal((await f.pool.query("SELECT 1 FROM agent_usage WHERE scenario='compaction'")).rowCount,3,'持久计划恢复不能重复记账')
  assert.equal((await f.pool.query("SELECT 1 FROM gugu_im_reflection_cursor_positions")).rowCount,1,'沉淀维护不推进消息反思水位')
 }finally{try{await runtime?.stop()}finally{
  if(baseline)for(const key of(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-daily-cleanup']) as string[]).filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])
  await redis.close();await f.close()
 }}
})
