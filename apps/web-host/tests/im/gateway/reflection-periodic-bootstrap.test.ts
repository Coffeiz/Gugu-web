import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {ProviderTransport} from '@gugu/core/providers'
import {createNodeImHostRuntime} from '../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../src/adapters/cache/redis-stream-commands.js'
import type {ImReflectionService} from '../../../src/modules/im/gateway/reflection-contracts.js'
import {createImProductionFixture} from './production.fixtures.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
const blocked=(signal:AbortSignal):Promise<never>=>new Promise((_resolve,reject)=>{const stop=()=>reject(Error('合成周期轮询停止'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true})})
async function until(check:()=>Promise<boolean>,detail:()=>Promise<unknown>){for(let i=0;i<1200;i++){if(await check())return;await delay(25)}assert.fail(JSON.stringify(await detail()))}

test('正式owner周期维护：两field独立水位/纠正/失败冷却/仅活跃触发/计划重启/业务revision',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需任务专用隔离PG/Redis与离线ORM解释器',timeout:240000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,reflection:ImReflectionService|undefined,baseline:Set<string>|undefined,wake:(()=>void)|undefined
 let initial=true,wave:unknown[]|undefined,mainCalls=0,sent=0,reflectionCalls=0,patternCalls=0,profileCalls=0,validProfile=false
 let profilePrompt='',patternPrompt=''
 const diagnostics:string[]=[],requests:{field:string;corrective:boolean}[]=[],root=join(f.storageRoot,f.ownerId,'.agent')
 const profilePath=join(root,'profile.json'),patternPath=join(root,'pattern.json'),statePath=join(root,'pattern_maintenance.json')
 const profile=(count:number,offset=0)=>Array.from({length:count},(_,i)=>({type:'note',text:`合成画像-${offset+i}`,ts:1}))
 const patterns=(count:number,offset=0)=>Array.from({length:count},(_,i)=>({id:`p-${offset+i}`,text:`合成行为-${offset+i}`,kind:i%2?'inferred':'observed',conf:.8,imp:3,ts:1}))
 const read=async(path:string)=>JSON.parse(await readFile(path,'utf8'))
 const detail=async()=>({mainCalls,sent,reflectionCalls,patternCalls,profileCalls,requests,diagnostics,jobs:(await f.pool.query('SELECT window_key,state,attempts,plan_payload IS NOT NULL AS planned FROM gugu_im_reflection_jobs ORDER BY created_at')).rows})
 const packet=(n:number)=>({update_id:110000+n,message:{message_id:111000+n,date:Math.floor(Date.now()/1000),from:{id:202,first_name:'合成owner'},chat:{id:202,type:'private'},text:`合成周期问题-${n}`}})
 const provider:ProviderTransport={async request(request){const body=request.body as Record<string,unknown>
  if(body.stream){mainCalls++;return response(`data: ${JSON.stringify({choices:[{delta:{content:'合成周期回复'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:2}})}\n\ndata: [DONE]\n\n`)}
  const messages=Array.isArray(body.messages)?body.messages:[],texts:string[]=messages.map(message=>typeof message.content==='string'?message.content:
   Array.isArray(message.content)?message.content.filter((part:Record<string,unknown>)=>part.type==='text'&&typeof part.text==='string').map((part:{text:string})=>part.text).join(''):'')
  const delta=texts.at(-1)??'',system=texts[0]??''
  let output:unknown
  if(delta.startsWith('[0] ')){
   const items=delta.split('\n').map(line=>JSON.parse(line.replace(/^\[[0-9]+\] /u,''))) as Record<string,unknown>[]
   assert.equal(messages.length,2,'独立整理不能借主快照或聊天历史');assert.ok(!Array.isArray(body.tools)||body.tools.length===0)
   const field=Object.hasOwn(items[0]!,'id')?'pattern':'profile',corrective=system.includes('修正项：reason=')
   requests.push({field,corrective});assert.ok(system.startsWith((field==='pattern'?patternPrompt:profilePrompt).trim()),'实际协议可裁剪提示词首尾空白，正文仍须完整来自正式维护提示词')
   if(field==='pattern'){
    patternCalls++
    if(patternCalls===2){assert.equal(corrective,true);assert.match(system,/pattern_source_id_invalid/);assert.doesNotMatch(system,/foreign-pattern|合成禁止回显的错误输出/)}
    output={pattern:patternCalls===1?[{...items[0],id:'foreign-pattern',text:'合成禁止回显的错误输出'}]:items.slice(0,70)}
   }else{profileCalls++;if(!validProfile&&profileCalls===2)assert.match(system,/profile_result_empty/);output={profile:validProfile?items.slice(0,70):[]}}
  }else{reflectionCalls++;output={summary:`合成周期反思摘要-${mainCalls}`}}
  return response({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3}})
 }}
 const platform:ProviderTransport={async request(request,signal){const path=new URL(request.url).pathname
  if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
  if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
  if(path.endsWith('/getUpdates')){if(initial){initial=false;return response({ok:true,result:[packet(1)]})}
   if(!wave)await Promise.race([new Promise<void>(resolve=>wake=resolve),blocked(signal)])
   const next=wave;wave=undefined;return response({ok:true,result:next})}
  if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
  if(path.endsWith('/sendMessage')){sent++;return response({ok:true,result:{message_id:112000+sent}})}
  throw Error('未配置的合成周期平台请求')
 }}
 const make=()=>createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},mcpRuntime:{async invalidate(){}},onReflection(value){reflection=value},diagnose:code=>diagnostics.push(code),testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'9.9.9.9',family:4}]}}})
 const forceDue=()=>f.pool.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp() WHERE state IN('pending','ready','retry','deferred')")
 async function active(n:number){wave=[packet(n)];wake?.();await until(async()=>mainCalls===n&&sent===n&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE window_key='run'")).rowCount===n,detail)
  await forceDue();await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE window_key='run' AND state='completed'")).rowCount===n,detail)}
 try{
  await mkdir(root,{recursive:true});await writeFile(profilePath,JSON.stringify(profile(100)));await writeFile(patternPath,JSON.stringify(patterns(100)))
  await writeFile(statePath,JSON.stringify({synthetic_extra:{keep:true}}))
  profilePrompt=await readFile(join(f.promptRoot,'profile_compact.md'),'utf8');patternPrompt=await readFile(join(f.promptRoot,'pattern_compact.md'),'utf8')
  await f.pool.query(`CREATE FUNCTION synthetic_reject_periodic_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.window_key LIKE 'periodic:pattern:%' AND NEW.state='completed' THEN RAISE EXCEPTION 'synthetic-periodic-finish';END IF;RETURN NEW;END $$;
   CREATE TRIGGER synthetic_reject_periodic_finish BEFORE UPDATE ON gugu_im_reflection_jobs FOR EACH ROW EXECUTE FUNCTION synthetic_reject_periodic_finish()`)
  baseline=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-periodic-cleanup']) as string[])
  runtime=make();await runtime.start();await until(async()=>sent===1&&(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE window_key='run'")).rowCount===1,detail);await forceDue()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE window_key LIKE 'periodic:pattern:%' AND state='retry' AND plan_payload IS NOT NULL")).rowCount===1,detail)
  assert.equal(patternCalls,2);assert.equal(profileCalls,0,'旧prepared计划尚未恢复，另一field不能提前调用模型')
  assert.equal((await read(patternPath)).length,70);assert.equal((await read(statePath)).reviewed_count,70)
  await f.pool.query('DROP TRIGGER synthetic_reject_periodic_finish ON gugu_im_reflection_jobs;DROP FUNCTION synthetic_reject_periodic_finish()')
  await runtime.stop();runtime=make();await runtime.start();await forceDue()
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE window_key LIKE 'periodic:profile:%' AND state='dead'")).rowCount===1,detail)
  assert.equal(patternCalls,2,'恢复文件计划不重发模型');assert.equal(profileCalls,2);assert.deepEqual(await read(profilePath),profile(100))
  const state1=await read(statePath);assert.equal(state1.reviewed_count,70);assert.ok(state1.last_review_at>0);assert.ok(state1.profile_last_attempt_at>0)
  assert.equal(state1.profile_last_compact_at,undefined);assert.equal(state1.profile_compacted_count,undefined);assert.deepEqual(state1.synthetic_extra,{keep:true})
  assert.equal((await f.pool.query("SELECT 1 FROM agent_usage WHERE scenario='compaction'")).rowCount,4)
  await active(2);assert.equal(patternCalls+profileCalls,4,'失败不到一小时的新活跃反思不能再次发维护模型')
  const aged=await read(statePath);aged.profile_last_attempt_at=Date.now()/1000-3601;await writeFile(statePath,JSON.stringify(aged))
  assert.equal(await reflection!.runOnce(),false,'没有新活跃反思，不扫描沉默owner自动重试')
  validProfile=true;await active(3)
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE window_key LIKE 'periodic:profile:%' AND state='completed'")).rowCount===1,detail)
  const state2=await read(statePath);assert.equal((await read(profilePath)).length,70);assert.equal(state2.profile_compacted_count,70);assert.ok(state2.profile_last_compact_at>0)
  assert.equal(state2.last_review_at,state1.last_review_at);assert.equal(state2.reviewed_count,70);assert.deepEqual(state2.synthetic_extra,{keep:true})
  await writeFile(profilePath,JSON.stringify([...(await read(profilePath)),...profile(30,100)]));await writeFile(patternPath,JSON.stringify([...(await read(patternPath)),...patterns(30,100)]))
  await active(4);assert.equal(patternCalls+profileCalls,5,'增长30条但未满七天，不能重复整理')
  const expired=await read(statePath);expired.last_review_at=expired.profile_last_compact_at=Date.now()/1000-8*86400;expired.pattern_last_attempt_at=expired.profile_last_attempt_at=Date.now()/1000-3601
  await writeFile(statePath,JSON.stringify(expired));assert.equal(await reflection!.runOnce(),false)
  await active(5)
  await until(async()=>(await f.pool.query("SELECT 1 FROM gugu_im_reflection_jobs WHERE state NOT IN('completed','cancelled','dead')")).rowCount===0,detail)
  assert.equal(patternCalls,3);assert.equal(profileCalls,4);assert.equal((await read(patternPath)).length,70);assert.equal((await read(profilePath)).length,70)
  const state3=await read(statePath);assert.equal(state3.reviewed_count,70);assert.equal(state3.profile_compacted_count,70);assert.deepEqual(state3.synthetic_extra,{keep:true})
  assert.equal((await f.pool.query("SELECT 1 FROM agent_usage WHERE scenario='compaction'")).rowCount,7)
  assert.equal((await f.pool.query("SELECT 1 FROM gugu_im_reflection_cursor_positions")).rowCount,5,'周期维护不推进消息反思水位')
  await until(async()=>Number(await redis.sendCommand(['GET',`context-revision:${f.ownerId}`]))>=5,detail)
  assert.equal(mainCalls,5);assert.equal(sent,5);assert.equal(reflectionCalls,5);assert.deepEqual(requests.slice(0,4).map(row=>row.field),['pattern','pattern','profile','profile'])
 }finally{try{await runtime?.stop()}finally{
  if(baseline)for(const key of(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-periodic-cleanup']) as string[]).filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])
  await redis.close();await f.close()
 }}
})
