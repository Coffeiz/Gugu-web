import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {ProviderTransport} from '@gugu/core/providers'
import {createAgentRunCodec} from '@gugu/core/agent/run/codec'
import {createNodeImHostRuntime} from '../../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../../src/adapters/cache/redis-stream-commands.js'
import {createImProductionFixture} from '../production.fixtures.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
function blocked(signal:AbortSignal):Promise<never>{return new Promise((_resolve,reject)=>{if(signal.aborted)reject(Error('合成轮询停止'));else signal.addEventListener('abort',()=>reject(Error('合成轮询停止')),{once:true})})}
async function until(check:()=>Promise<boolean>,detail:()=>Promise<unknown>){for(let n=0;n<600;n++){if(await check())return;await delay(40)}assert.fail(JSON.stringify(await detail()))}
function stream(blocks:Record<string,unknown>[],tool:boolean){
 const events:unknown[]=[{type:'message_start',message:{id:'synthetic-anthropic-response',type:'message',role:'assistant',content:[],usage:{input_tokens:20,output_tokens:0}}}]
 for(const [index,block] of blocks.entries())events.push({type:'content_block_start',index,content_block:block},{type:'content_block_stop',index})
 events.push({type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:8}},{type:'message_stop'})
 return response(events.map(value=>`data: ${JSON.stringify(value)}\n\n`).join(''))
}

test('正式Anthropic私有续接：真实工具轮/成功跨进程与跨Run，off失效旧成功但当前工具仍可完成且无签名外泄',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需专用隔离PG/Redis与离线ORM解释器；仅平台/Provider网络为替身',timeout:180000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),redis=createRedisStreamCommands(redisUrl!)
 await f.insert('user_preferences', { user_id: f.ownerId, data_json: JSON.stringify({ tool_injection_mode: 'full' }) })
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,baseline:Set<string>|undefined,phase=1,emitted=0,mainCalls=0
 const delivered:string[]=[],diagnostics:string[]=[],privateMarker='synthetic-private-anthropic-'
 try{
  const document=JSON.parse(await readFile(f.configPath,'utf8'))
  document.ai={...document.ai,api_format:'anthropic',provider:'anthropic',reasoning_persistence:'continuation',thinking:true}
  await writeFile(f.configPath,JSON.stringify(document))
  const provider:ProviderTransport={async request(request){
   const body=request.body as Record<string,unknown>
   assert.match(new URL(request.url).pathname,/\/messages$/)
   if(!body.stream)return response({content:[{type:'text',text:'{}'}],usage:{input_tokens:3,output_tokens:1}})
   mainCalls++
   assert.ok((body.tools as Array<{name:string}>).some(tool=>tool.name==='get_current_time'))
   const wire=JSON.stringify(body.messages)
   if(mainCalls===1||mainCalls===4)assert.equal(wire.includes(privateMarker),false)
   if(mainCalls===2){assert.match(wire,/synthetic-private-anthropic-tool/);assert.equal((wire.match(/"type":"tool_use"/g)??[]).length,1);assert.match(wire,/"type":"tool_result"/)}
   if(mainCalls===3){assert.match(wire,/synthetic-private-anthropic-tool/);assert.match(wire,/synthetic-private-anthropic-tail-2/);assert.equal((wire.match(/"type":"tool_use"/g)??[]).length,1)}
   if(mainCalls===5){assert.match(wire,/synthetic-private-anthropic-off/);assert.equal(wire.includes(`${privateMarker}tail-3`),false)}
   assert.ok(mainCalls<=5,'不得因私有状态存储失败重发模型')
   if(mainCalls===1||mainCalls===4)return stream([{type:'text',text:'合成工具前说明'},
    {type:'thinking',thinking:'合成私有思考',signature:`${privateMarker}${mainCalls===1?'tool':'off'}`},
    {type:'tool_use',id:`synthetic-clock-${mainCalls}`,name:'get_current_time',input:{}}],true)
   return stream([{type:'redacted_thinking',data:`${privateMarker}redacted-${mainCalls}`},
    {type:'thinking',thinking:'合成最终推理',signature:`${privateMarker}tail-${mainCalls}`},{type:'text',text:`合成公开答复${phase}`}],false)
  }}
  const platform:ProviderTransport={async request(request,signal){const path=new URL(request.url).pathname
   if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,is_bot:true,username:'synthetic_bot'}})
   if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
   if(path.endsWith('/getUpdates')){
    if(emitted===phase)return blocked(signal)
    emitted=phase
    return response({ok:true,result:[{update_id:16000+phase,message:{message_id:16100+phase,date:Math.floor(Date.now()/1000),
     chat:{id:202,type:'private'},from:{id:202,first_name:'合成人物'},text:`合成当前问题${phase}`}}]})
   }
   if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
   if(path.endsWith('/sendMessage')){const body=JSON.parse(Buffer.from(request.body as Uint8Array).toString());delivered.push(body.text);return response({ok:true,result:{message_id:16200+delivered.length}})}
   throw Error('未配置合成平台请求')
  }}
  baseline=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-anthropic-cleanup']) as string[])
  const start=async()=>{
   runtime=createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
    mcpRuntime:{async invalidate(){throw Error('本回归不用MCP')}},diagnose:code=>diagnostics.push(code),
    testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'11.22.33.44',family:4}]}}})
   await runtime.start()
  }
  const detail=async()=>({mainCalls,delivered:delivered.length,diagnostics,health:runtime?.health(),checkpoints:(await f.pool.query('SELECT status,phase FROM agent_run_checkpoints')).rows})
  const complete=async(n:number)=>until(async()=>(await f.pool.query("SELECT count(*)::int AS n FROM agent_run_checkpoints WHERE status='completed'")).rows[0].n===n
   &&delivered.some(text=>text.includes(`合成公开答复${n}`)),detail)
  await start();await complete(1)
  assert.equal(mainCalls,2)
  assert.equal((await f.pool.query('SELECT version,state_kind FROM provider_reasoning_states')).rows[0].state_kind,'anthropic_thinking_blocks')
  await runtime!.stop();phase=2;await start();await complete(2)
  assert.equal(mainCalls,3)
  assert.equal((await f.pool.query('SELECT version FROM provider_reasoning_states')).rows[0].version,2)
  await runtime!.stop();document.ai.reasoning_persistence='off';await writeFile(f.configPath,JSON.stringify(document));phase=3
  await start();await complete(3)
  assert.equal(mainCalls,5)
  const successful=(await f.pool.query('SELECT * FROM provider_reasoning_states')).rows
  assert.equal(successful[0].status,'invalidated');assert.equal(successful[0].version,3);assert.equal(successful[0].encrypted_payload,'')
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM gugu_agent_active_reasoning')).rows[0].n,0)
  const codec=createAgentRunCodec(f.secretKey)
  for(const row of(await f.pool.query('SELECT * FROM agent_run_checkpoints')).rows){
   const checkpoint=codec.decryptCheckpoint({ownerId:row.user_id,sessionId:String(row.session_id),runId:row.run_id},Number(row.version),row.nonce,row.payload)
   assert.equal(JSON.stringify(checkpoint).includes(privateMarker),false)
  }
  for(const row of(await f.pool.query('SELECT * FROM agent_run_events')).rows){
   const event=codec.decryptEvent({ownerId:row.user_id,sessionId:String(row.session_id),runId:row.run_id},row.event_id,Number(row.sequence),row.nonce,row.payload)
   assert.equal(JSON.stringify(event).includes(privateMarker),false)
  }
  assert.equal(JSON.stringify((await f.pool.query('SELECT content,content_json FROM conversation_messages')).rows).includes(privateMarker),false)
  assert.equal(JSON.stringify(delivered).includes(privateMarker),false);assert.equal(JSON.stringify(diagnostics).includes(privateMarker),false)
 }finally{try{await runtime?.stop()}finally{
  if(baseline){const keys=await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-anthropic-cleanup']) as string[]
   for(const key of keys.filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])}
  await redis.close();await f.close()
 }}
})

for(const protocol of ['openai','ollama'] as const)test(`正式${protocol}私有工具轮：当前Run可恢复但不发布跨Run状态，思考不进入消息或checkpoint`,{
 skip:!(databaseUrl&&redisUrl&&python)&&'需专用隔离PG/Redis与离线ORM解释器；平台/Provider网络替身',timeout:180000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,baseline:Set<string>|undefined,mainCalls=0,emitted=false
 const delivered:string[]=[],diagnostics:string[]=[],marker=`synthetic-private-${protocol}-tool`
 try{
  const document=JSON.parse(await readFile(f.configPath,'utf8'))
  document.ai={...document.ai,provider:protocol,api_format:'openai',ollama_api_mode:'native',reasoning_persistence:'continuation',thinking:true}
  await writeFile(f.configPath,JSON.stringify(document))
  const provider:ProviderTransport={async request(request){const body=request.body as Record<string,unknown>
   if(!body.stream)return response(protocol==='ollama'?{message:{role:'assistant',content:'{}'},done:true}:{choices:[{message:{role:'assistant',content:'{}'}}]})
   mainCalls++
   assert.ok(mainCalls<=2,'不因私有格式不支持而重发模型')
   if(mainCalls===1)assert.equal(JSON.stringify(body.messages).includes(marker),false)
   else{
    assert.match(JSON.stringify(body.messages),new RegExp(marker))
    // Ollama原生结果按tool_name配对，投影会移除tool_call_id；OpenAI保留id。
    assert.equal((JSON.stringify(body.messages).match(/synthetic-clock/g)??[]).length,protocol==='ollama'?1:2)
    const results=(body.messages as Array<Record<string,unknown>>).filter(message=>message.role==='tool')
    assert.equal(results.length,1,'工具结果恰好一次')
    if(protocol==='ollama')assert.equal(results[0].tool_name,'get_current_time')
    else assert.equal(results[0].tool_call_id,'synthetic-clock')
   }
   const tool=mainCalls===1
   if(protocol==='ollama'){
    assert.match(new URL(request.url).pathname,/\/api\/chat$/)
    return response(JSON.stringify({message:{role:'assistant',content:tool?'':'合成协议公开答复',thinking:tool?marker:'',
     ...(tool?{tool_calls:[{id:'synthetic-clock',type:'function',function:{name:'get_current_time',arguments:{}}}]}:{})},done:true,prompt_eval_count:20,eval_count:5})+'\n')
   }
   assert.match(new URL(request.url).pathname,/\/chat\/completions$/)
   return response(`data: ${JSON.stringify({choices:[{index:0,delta:tool?{reasoning_content:marker,tool_calls:[{index:0,id:'synthetic-clock',type:'function',function:{name:'get_current_time',arguments:'{}'}}]}:{content:'合成协议公开答复'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:5}})}\n\ndata: [DONE]\n\n`)
  }}
  const platform:ProviderTransport={async request(request,signal){const path=new URL(request.url).pathname
   if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,is_bot:true,username:'synthetic_bot'}})
   if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
   if(path.endsWith('/getUpdates')){if(emitted)return blocked(signal);emitted=true;return response({ok:true,result:[{update_id:17001,message:{message_id:17101,date:Math.floor(Date.now()/1000),chat:{id:202,type:'private'},from:{id:202,first_name:'合成人物'},text:'合成协议工具问题'}}]})}
   if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
   if(path.endsWith('/sendMessage')){const body=JSON.parse(Buffer.from(request.body as Uint8Array).toString());delivered.push(body.text);return response({ok:true,result:{message_id:17200+delivered.length}})}
   throw Error('未配置合成平台请求')
  }}
  baseline=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-private-cleanup']) as string[])
  runtime=createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
   mcpRuntime:{async invalidate(){throw Error('本回归不用MCP')}},diagnose:code=>diagnostics.push(code),testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'11.22.33.44',family:4}]}}})
  await runtime.start()
  await until(async()=>(await f.pool.query("SELECT count(*)::int AS n FROM agent_run_checkpoints WHERE status='completed'")).rows[0].n===1&&delivered.some(text=>text.includes('合成协议公开答复')),
   async()=>({mainCalls,diagnostics,delivered:delivered.length,health:runtime?.health(),checkpoints:(await f.pool.query('SELECT status,phase FROM agent_run_checkpoints')).rows}))
  assert.equal(mainCalls,2)
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM provider_reasoning_states')).rows[0].n,0,'Python不支持此协议跨Run私有续接')
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM gugu_agent_active_reasoning')).rows[0].n,0)
  const codec=createAgentRunCodec(f.secretKey)
  for(const row of(await f.pool.query('SELECT * FROM agent_run_checkpoints')).rows)assert.equal(JSON.stringify(codec.decryptCheckpoint({ownerId:row.user_id,sessionId:String(row.session_id),runId:row.run_id},Number(row.version),row.nonce,row.payload)).includes(marker),false)
  for(const row of(await f.pool.query('SELECT * FROM agent_run_events')).rows)assert.equal(JSON.stringify(codec.decryptEvent({ownerId:row.user_id,sessionId:String(row.session_id),runId:row.run_id},row.event_id,Number(row.sequence),row.nonce,row.payload)).includes(marker),false)
  assert.equal(JSON.stringify((await f.pool.query('SELECT content,content_json FROM conversation_messages')).rows).includes(marker),false)
  assert.equal(JSON.stringify(delivered).includes(marker),false);assert.equal(JSON.stringify(diagnostics).includes(marker),false)
 }finally{try{await runtime?.stop()}finally{
  if(baseline){const keys=await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-private-cleanup']) as string[]
   for(const key of keys.filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])}
  await redis.close();await f.close()
 }}
})
