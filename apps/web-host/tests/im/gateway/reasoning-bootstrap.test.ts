import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {ProviderTransport,ProviderHttpRequest} from '@gugu/core/providers'
import {createAgentRunCodec} from '@gugu/core/agent/run/codec'
import {createNodeImHostRuntime} from '../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../src/adapters/cache/redis-stream-commands.js'
import {createImProductionFixture} from './production.fixtures.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
function blocked(signal:AbortSignal):Promise<never>{return new Promise((_resolve,reject)=>{if(signal.aborted)reject(Error('合成轮询已停止'));else signal.addEventListener('abort',()=>reject(Error('合成轮询已停止')),{once:true})})}
async function until(check:()=>Promise<boolean>,diagnostic:()=>unknown){for(let i=0;i<400;i++){if(await check())return;await delay(40)}assert.fail(`合成生产Run未完成：${JSON.stringify(await diagnostic())}`)}

test('正式bootstrap Responses跨Run：两次成功私有续接→第三Run协议拒绝CAS失效，checkpoint/outbox不泄露',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需本任务专用隔离PG/Redis及离线ORM解释器；不等同真实平台验收',timeout:120000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!,platform:'telegram'}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,previous:Set<string>|undefined,polls=0,mainCalls=0
 const delivered:string[]=[],diagnostics:string[]=[],requests:ProviderHttpRequest[]=[]
 let allowSecond!:()=>void,allowThird!:()=>void
 const second=new Promise<void>(resolve=>allowSecond=resolve)
 const third=new Promise<void>(resolve=>allowThird=resolve)
 try{
  const document=JSON.parse(await readFile(f.configPath,'utf8'))
  document.ai={...document.ai,api_format:'responses',provider:'openai',reasoning_persistence:'continuation',thinking:true}
  await writeFile(f.configPath,JSON.stringify(document))
  const provider:ProviderTransport={async request(request){
   const body=request.body as Record<string,unknown>
   if(!body.stream)return response({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]})
   requests.push(request);mainCalls++
   assert.match(new URL(request.url).pathname,/\/responses$/)
   if(mainCalls===1)assert.equal(JSON.stringify(body).includes('synthetic-private-first'),false)
   if(mainCalls===2){assert.match(JSON.stringify(body),/synthetic-private-first/);assert.match(JSON.stringify(body),/合成第一条回答/)}
   if(mainCalls===3){assert.match(JSON.stringify(body),/synthetic-private-second/);return{...response({error:{message:'Responses API does not support encrypted_content'}}),status:400}}
   const result={type:'response.completed',response:{id:`response-synthetic-${mainCalls}`,status:'completed',
    output:[{type:'reasoning',id:`reasoning-synthetic-${mainCalls}`,status:'completed',summary:[],encrypted_content:mainCalls===1?'synthetic-private-first':'synthetic-private-second'},
     {type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:mainCalls===1?'合成第一条回答':'合成第二条回答'}]}],
    usage:{input_tokens:20,output_tokens:5}}}
   return response(`data: ${JSON.stringify(result)}\n\n`)
  }}
  const platform:ProviderTransport={async request(request,signal){
   const path=new URL(request.url).pathname
   if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
   if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
   if(path.endsWith('/getUpdates')){
    polls++
    if(polls===2)await Promise.race([second,blocked(signal)])
    if(polls===3)await Promise.race([third,blocked(signal)])
    if(polls>3)return blocked(signal)
    return response({ok:true,result:[{update_id:5000+polls,message:{message_id:5100+polls,date:Math.floor(Date.now()/1000),
     chat:{id:202,type:'private'},from:{id:202,first_name:'合成人物'},text:polls===1?'合成第一条问题':polls===2?'合成第二条问题':'合成第三条问题'}}]})
   }
   if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
   if(path.endsWith('/sendMessage')){const body=JSON.parse(Buffer.from(request.body as Uint8Array).toString());delivered.push(body.text);return response({ok:true,result:{message_id:5200+delivered.length}})}
   throw Error('未配置的合成平台请求')
  }}
  previous=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-reasoning-cleanup']) as string[])
  runtime=createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
   mcpRuntime:{async invalidate(){throw Error('本回归不使用MCP')}},diagnose:code=>diagnostics.push(code),
   testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'11.22.33.44',family:4}]}}})
  await runtime.start()
  const diagnostic=async()=>({diagnostics,health:runtime!.health(),mainCalls,delivered:delivered.length,
   dispatch:(await f.pool.query('SELECT state,blocked_reason FROM agent_run_dispatch')).rows,checkpoints:(await f.pool.query('SELECT status FROM agent_run_checkpoints')).rows})
  await until(async()=>delivered.length===1&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===1,diagnostic)
  const first=(await f.pool.query('SELECT * FROM provider_reasoning_states')).rows
  assert.equal(first.length,1);assert.equal(first[0].version,1);assert.equal(first[0].status,'active')
  assert.equal(JSON.stringify(first).includes('synthetic-private-first'),false);assert.equal(mainCalls,1)
  allowSecond()
  await until(async()=>delivered.length===2&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===2,diagnostic)
  assert.equal(mainCalls,2);assert.equal(requests.length,2)
  assert.equal((await f.pool.query('SELECT version FROM provider_reasoning_states')).rows[0]!.version,2)
  assert.match(delivered[0]!,/合成第一条回答/);assert.match(delivered[1]!,/合成第二条回答/)
  allowThird()
  await until(async()=>(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='failed'")).rowCount===1,diagnostic)
  assert.equal(mainCalls,3,'明确协议不兼容不能重发Provider请求')
  const rejected=(await f.pool.query('SELECT version,status,invalidated_reason,encrypted_payload,encrypted_data_key FROM provider_reasoning_states')).rows[0]!
  assert.equal(rejected.status,'invalidated');assert.equal(rejected.invalidated_reason,'responses_incompatible');assert.equal(rejected.version,3)
  assert.equal(rejected.encrypted_payload,'');assert.equal(rejected.encrypted_data_key,'')
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM agent_run_checkpoints WHERE status='completed'")).rows[0].n,2)
  const codec=createAgentRunCodec(f.secretKey)
  for(const row of(await f.pool.query('SELECT * FROM agent_run_checkpoints')).rows){
   const value=codec.decryptCheckpoint({ownerId:row.user_id,sessionId:String(row.session_id),runId:row.run_id},Number(row.version),row.nonce,row.payload)
   assert.equal(JSON.stringify(value).includes('synthetic-private-'),false)
   assert.equal(JSON.stringify(value).includes('encrypted_content'),false)
  }
  for(const row of(await f.pool.query('SELECT * FROM agent_run_events')).rows){
   const event=codec.decryptEvent({ownerId:row.user_id,sessionId:String(row.session_id),runId:row.run_id},row.event_id,Number(row.sequence),row.nonce,row.payload)
   assert.equal(JSON.stringify(event).includes('synthetic-private-'),false)
   assert.equal(JSON.stringify(event).includes('encrypted_content'),false)
  }
  for(const row of(await f.pool.query('SELECT * FROM agent_run_events')).rows){
   const value=codec.decryptEvent({ownerId:row.user_id,sessionId:String(row.session_id),runId:row.run_id},row.event_id,Number(row.sequence),row.nonce,row.payload)
   assert.equal(JSON.stringify(value).includes('synthetic-private-'),false)
  }
  assert.equal((await f.pool.query('SELECT version FROM provider_reasoning_states')).rows[0].version,3)
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM gugu_agent_active_reasoning')).rows[0].n,0)
 }finally{try{allowSecond?.();await runtime?.stop()}finally{
  if(previous){const keys=await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-reasoning-cleanup']) as string[]
   for(const key of keys.filter(key=>!previous!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])}
  await redis.close();await f.close()
 }}
})
