import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {ProviderTransport} from '@gugu/core/providers'
import {parseOwnerDailyEntries} from '@gugu/core/owner-daily-compaction'
import {renderGroupDailyEntries} from '@gugu/core/im-group-daily-compaction'
import {createNodeImHostRuntime} from '../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../src/adapters/cache/redis-stream-commands.js'
import {imMemoryMaintenanceScopeFileKey} from '../../../src/modules/admin/memory-apply.js'
import {createImProductionFixture} from './production.fixtures.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
const blocked=(signal:AbortSignal):Promise<never>=>new Promise((_resolve,reject)=>{const stop=()=>reject(Error('合成owner轮询停止'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true})})
async function until(check:()=>Promise<boolean>,detail:()=>Promise<unknown>){for(let i=0;i<1200;i++){if(await check())return;await delay(25)}assert.fail(JSON.stringify(await detail()))}

test('正式owner daily：实际owner私聊Run→250条追加沉淀/本人词法历史参考/空JSON重试用量/持久计划恢复',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需任务专用隔离PG/Redis与离线ORM解释器',timeout:180000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,baseline:Set<string>|undefined,initial=true,mainCalls=0,sent=0,reflectionCalls=0,compactionCalls=0,rejectThird=true
 const diagnostics:string[]=[],batches:number[]=[],referenceInputs:string[]=[]
 const dailyPath=join(f.storageRoot,f.ownerId,'.agent','daily.md'),memoryPath=join(f.storageRoot,f.ownerId,'.agent','memory.md')
 const oldMemory='## 记录长期记忆：合成茶会背景\n\n2026-01-01 合成茶会背景哨兵：已确认周末茶会。\n'
 const otherMarker='合成跨用户禁止读取哨兵',groupMarker='合成群范围禁止读取哨兵'
 const detail=async()=>({mainCalls,sent,reflectionCalls,compactionCalls,batches,diagnostics,jobs:(await f.pool.query('SELECT window_key,state,attempts,plan_payload IS NOT NULL AS planned FROM gugu_im_reflection_jobs ORDER BY created_at')).rows})
 const provider:ProviderTransport={async request(request){const body=request.body as Record<string,unknown>,wire=JSON.stringify(body)
  assert.doesNotMatch(wire,new RegExp(`${otherMarker}|${groupMarker}`),'owner维护不能读取另一owner或群scope')
  if(body.stream){mainCalls++;return response(`data: ${JSON.stringify({choices:[{delta:{content:'合成owner主回复'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:2}})}\n\ndata: [DONE]\n\n`)}
  const messages=Array.isArray(body.messages)?body.messages:[],texts=messages.flatMap(message=>message&&typeof message==='object'&&typeof message.content==='string'?[message.content]:[])
  const delta=texts.find(text=>text.startsWith('相关历史事件参考：\n'))
  let output:unknown
  if(delta){compactionCalls++;assert.equal(messages.length,2,'owner沉淀不借主对话快照');assert.ok(!Array.isArray(body.tools)||body.tools.length===0)
   if(compactionCalls<=2){assert.match(delta,/【历史事件参考，仅用于去重和背景核对】/);assert.match(delta,/合成茶会背景哨兵/,'首批真实Core BM25必须提供本人历史事件参考')}
   else assert.match(delta,/【历史事件参考，仅用于去重和背景核对】|（暂无相关历史事件参考）/,'后续批次重排或无匹配均沿真实RAG结果，不要求固定命中旧事件')
   referenceInputs.push(delta)
   const marker='要追加的近期记录（只从这里提取新增事件，不要丢掉日期）：\n',start=delta.indexOf(marker);assert.ok(start>=0)
   const daily=delta.slice(start+marker.length).split('\n\n请只输出本批次要追加的事件章节。')[0]!
   batches.push(daily.split('\n').filter((line:string)=>line.startsWith('- ')).length)
   output=compactionCalls===1?{}:rejectThird&&compactionCalls===3?{entries:''}:{entries:`## 记录长期记忆：合成owner批次-${compactionCalls}\n\n${daily}`}
  }else{reflectionCalls++;output={summary:'合成owner摘要',daily:'合成新增owner茶会记录'}}
  return response({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3}})
 }}
 const platform:ProviderTransport={async request(request,signal){const path=new URL(request.url).pathname
  if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
  if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
  if(path.endsWith('/getUpdates')){if(!initial)return blocked(signal);initial=false;return response({ok:true,result:[{update_id:99001,message:{message_id:99002,date:Math.floor(Date.now()/1000),from:{id:202,first_name:'合成owner'},chat:{id:202,type:'private'},text:'合成owner茶会问题'}}]})}
  if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
  if(path.endsWith('/sendMessage')){sent++;return response({ok:true,result:{message_id:99003}})}
  throw Error('未配置的合成owner平台请求')
 }}
 const make=()=>createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},mcpRuntime:{async invalidate(){}},diagnose:code=>diagnostics.push(code),testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'9.9.9.9',family:4}]}}})
 const forceDue=()=>f.pool.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp() WHERE state IN('pending','ready','retry','deferred')")
 try{
  await mkdir(dirname(dailyPath),{recursive:true});await writeFile(dailyPath,renderGroupDailyEntries(Array.from({length:249},(_,i)=>['2026-01-01',`合成茶会待沉淀-${i}`] as [string,string])));await writeFile(memoryPath,oldMemory)
  const otherPath=join(f.storageRoot,f.otherOwnerId,'.agent','memory.md');await mkdir(dirname(otherPath),{recursive:true});await writeFile(otherPath,`## 记录长期记忆：合成茶会\n\n2026-01-01 合成茶会 ${otherMarker}\n`)
  const groupPath=join(f.storageRoot,imMemoryMaintenanceScopeFileKey({owner_user_id:f.ownerId,platform:'telegram',bot_id:f.botId,scope_type:'group',scope_id:'-717'},'memory.md'))
  await mkdir(dirname(groupPath),{recursive:true});await writeFile(groupPath,`## 记录长期记忆：合成茶会\n\n2026-01-01 合成茶会 ${groupMarker}\n`)
  await f.pool.query(`CREATE FUNCTION synthetic_reject_owner_daily_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.window_key LIKE 'daily:%' AND NEW.state='completed' THEN RAISE EXCEPTION 'synthetic-owner-daily-finish';END IF;RETURN NEW;END $$;
   CREATE TRIGGER synthetic_reject_owner_daily_finish BEFORE UPDATE ON gugu_im_reflection_jobs FOR EACH ROW EXECUTE FUNCTION synthetic_reject_owner_daily_finish()`)
  baseline=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-owner-daily-cleanup']) as string[])
  runtime=make();await runtime.start()
  await until(async()=>sent===1&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state='ready'")).rowCount===1,detail);await forceDue()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE window_key LIKE 'daily:%' AND state='retry' AND plan_payload IS NOT NULL")).rowCount===1,detail)
  assert.equal(reflectionCalls,1);assert.equal(compactionCalls,2);assert.equal(parseOwnerDailyEntries(await readFile(dailyPath,'utf8')).length,150)
  const firstMemory=await readFile(memoryPath,'utf8');assert.ok(firstMemory.startsWith(`${oldMemory.trim()}\n\n`),'owner既有主档保持原正文，仅追加')
  assert.equal((await f.pool.query("SELECT 1 FROM agent_usage WHERE scenario='compaction'")).rowCount,2,'首次空JSON与随后成功均按实际响应记账')
  await f.pool.query('DROP TRIGGER synthetic_reject_owner_daily_finish ON gugu_im_reflection_jobs;DROP FUNCTION synthetic_reject_owner_daily_finish()')
  await runtime.stop();runtime=make();await runtime.start();await forceDue()
  await until(async()=>compactionCalls===3&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE window_key LIKE 'daily:%' AND state='retry' AND plan_payload IS NULL")).rowCount===1,detail)
  assert.equal(reflectionCalls,1);assert.equal(await readFile(memoryPath,'utf8'),firstMemory);assert.equal(parseOwnerDailyEntries(await readFile(dailyPath,'utf8')).length,150)
  assert.equal((await f.pool.query("SELECT 1 FROM agent_usage WHERE scenario='compaction'")).rowCount,3,'无效非空结果已有响应成本，同retry状态事务记录')
  rejectThird=false;await runtime.stop();runtime=make();await runtime.start();await forceDue()
  await until(async()=>compactionCalls===5&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state NOT IN('completed','cancelled','dead')")).rowCount===0,detail)
  assert.deepEqual(batches,[100,100,100,100,50]);assert.equal(await readFile(dailyPath,'utf8'),'')
  const memory=await readFile(memoryPath,'utf8');assert.ok(memory.startsWith(`${oldMemory.trim()}\n\n`));assert.equal((memory.match(/合成茶会背景哨兵/gu)??[]).length,1)
  for(let i=0;i<249;i++)assert.equal((memory.match(new RegExp(`合成茶会待沉淀-${i}(?![0-9])`,'gu'))??[]).length,1)
  assert.equal((memory.match(/合成新增owner茶会记录/gu)??[]).length,1);assert.equal(mainCalls,1);assert.equal(reflectionCalls,1);assert.equal(sent,1)
  assert.equal(referenceInputs.length,5);assert.equal((await f.pool.query("SELECT 1 FROM agent_usage WHERE scenario='compaction'")).rowCount,5)
  assert.equal((await f.pool.query("SELECT 1 FROM gugu_im_reflection_cursor_positions")).rowCount,1,'维护不推进消息反思水位')
 }finally{try{await runtime?.stop()}finally{
  if(baseline)for(const key of(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-owner-daily-cleanup']) as string[]).filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])
  await redis.close();await f.close()
 }}
})
