import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {ProviderTransport} from '@gugu/core/providers'
import {createNodeImHostRuntime} from '../../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../../src/adapters/cache/redis-stream-commands.js'
import {createImOwnerSessions} from '../../../../src/modules/im/gateway/agent/owner.js'
import {createImProductionFixture} from '../production.fixtures.js'
import {createPostgresImAccess} from '../../../../src/modules/im/gateway/inbound/access.js'
import {imActorInputFromPayload} from '@gugu/core/im/access'
import {createImInboundEnvelope} from '../../../../src/modules/im/gateway/inbound/envelope.js'
import {decryptAgentDispatchInput} from '../../../../src/modules/agent/run/dispatch.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
const stream=(delta:unknown,finish='stop')=>response(`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`)
function blocked(signal:AbortSignal):Promise<never>{return new Promise((_resolve,reject)=>{if(signal.aborted)reject(Error('合成轮询停止'));else signal.addEventListener('abort',()=>reject(Error('合成轮询停止')),{once:true})})}
test('真实owner绑定工具→本人Web历史继续；拒绝他人会话、成员/群路由、过期与错误Bot，重放不改新绑定',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需专用隔离PG/Redis与离线ORM解释器',timeout:120000,
},async()=>{
 const f=await createImProductionFixture({python:python!,databaseUrl,platform:'telegram'}),redis=createRedisStreamCommands(redisUrl!)
 await f.insert('user_preferences', { user_id: f.ownerId, data_json: JSON.stringify({ tool_injection_mode: 'full' }) })
 const marker='合成网页事实：下周计划去虚构月城',delivered:string[]=[],diagnostics:string[]=[],bodies:Record<string,unknown>[]=[]
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,previous:Set<string>|undefined,polls=0,mainCalls=0,summaryCalls=0,bindingChecksComplete=false
 try{
  const web=await f.insert('conversation_sessions',{user_id:f.ownerId,title:'合成网页会话',source:'web',summary:'',last_message_seq:32})
  const other=await f.insert('conversation_sessions',{user_id:f.otherOwnerId,title:'他人秘密',source:'web',summary:''})
  const later=await f.insert('conversation_sessions',{user_id:f.ownerId,title:'合成后来绑定',source:'web',summary:''})
  await f.insert('conversation_messages',{session_id:web.id,conversation_seq:1,role:'user',content:marker})
  await f.insert('conversation_messages',{session_id:web.id,conversation_seq:2,role:'assistant',content:'合成网页回答'})
  for(let i=3;i<=32;i++)await f.insert('conversation_messages',{session_id:web.id,conversation_seq:i,role:i%2?'user':'assistant',content:`合成历史事实${i}`})
  const provider:ProviderTransport={async request(request){
   const body=structuredClone(request.body) as Record<string,unknown>
   if(!body.stream){
    if(JSON.stringify(body.messages).includes('只输出摘要正文')){summaryCalls++;return response({choices:[{message:{content:'合成压缩摘要：保留月城计划和已确认事实'},finish_reason:'stop'}],usage:{prompt_tokens:24,completion_tokens:12}})}
    return response({choices:[{message:{content:'{}'},finish_reason:'stop'}]})
   }
   bodies.push(body);mainCalls++
   const names=(body.tools as {function:{name:string}}[]??[]).map(tool=>tool.function.name)
   assert.ok(names.includes('bind_web_session'),'必须从生产注册器暴露真实工具')
   if(mainCalls===1){assert.ok(!JSON.stringify(body.messages).includes(marker));return stream({tool_calls:[
    {index:0,id:'synthetic-cross-owner',type:'function',function:{name:'bind_web_session',arguments:JSON.stringify({session_id:other.id})}},
    {index:1,id:'synthetic-bind-web',type:'function',function:{name:'bind_web_session',arguments:JSON.stringify({session_id:web.id})}},
   ]},'tool_calls')}
   if(mainCalls===2){
    assert.match(JSON.stringify(body.messages),/已绑定/);assert.match(JSON.stringify(body.messages),/不存在/)
    const selected=(await f.pool.query("SELECT * FROM agent_run_dispatch WHERE state='selected'")).rows[0]!
    const identity={ownerId:selected.user_id,sessionId:String(selected.session_id),runId:selected.run_id}
    const input=decryptAgentDispatchInput(f.secretKey,identity,selected.nonce,selected.payload)
    const binding={ownerId:f.ownerId,botId:f.botId,platform:'telegram' as const}
    const receipt=(await f.pool.query('SELECT sealed_payload FROM gugu_im_inbound_receipts WHERE user_id=$1 AND run_id=$2',[f.ownerId,selected.run_id])).rows[0]!
    const payload=createImInboundEnvelope(f.secretKey).open(binding,receipt.sealed_payload)
    const access=createPostgresImAccess({query:(sql,args)=>f.pool.query(sql,args),supportedPlatforms:()=>['telegram']})
    const actor=await access.resolveActor(imActorInputFromPayload(binding,payload))
    const sessions=createImOwnerSessions({pool:f.pool,secretKey:f.secretKey,supportedPlatforms:()=>['telegram']})
    const port=sessions.tool({lease:{identity,input,token:selected.token,fence:Number(selected.fence),mode:'start',cancelRequested:false},actor,payload,messageIds:[String(input.userMessageId)],authorize:async()=>true})
    const original=(await f.pool.query("SELECT round_id,call_id FROM gugu_im_owner_session_receipts WHERE call_id='synthetic-bind-web'")).rows[0]!
    const first={identity,roundId:original.round_id,toolCallId:original.call_id,sessionId:web.id}
    assert.equal(await port.recover(first),'bound')
    assert.equal(await port.bind({...first,toolCallId:'synthetic-later-binding',sessionId:later.id},new AbortController().signal),'bound')
    assert.equal(await port.bind(first,new AbortController().signal),'bound')
    assert.equal((await f.pool.query('SELECT session_id FROM gugu_im_owner_sessions')).rows[0]!.session_id,later.id,'旧工具重放不能覆盖后来绑定')
    assert.equal(await port.bind({...first,sessionId:later.id},new AbortController().signal),'unknown','同一工具坐标不能改参数')
    await f.pool.query(`CREATE FUNCTION synthetic_revoke_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.call_id='synthetic-revoked-binding' THEN UPDATE user_bots SET owner_platform_user_id='999' WHERE id=${Number(f.botId)}; END IF;
      RETURN NEW; END $$`)
    await f.pool.query('CREATE TRIGGER synthetic_revoke_binding AFTER INSERT ON gugu_im_owner_session_receipts FOR EACH ROW EXECUTE FUNCTION synthetic_revoke_binding()')
    assert.equal(await port.bind({...first,toolCallId:'synthetic-revoked-binding'},new AbortController().signal),'unknown')
    assert.equal((await f.pool.query('SELECT session_id FROM gugu_im_owner_sessions')).rows[0]!.session_id,later.id,'写后撤权必须回滚绑定与工具收据')
    assert.equal((await f.pool.query("SELECT 1 FROM gugu_im_owner_session_receipts WHERE call_id='synthetic-revoked-binding'")).rowCount,0)
    assert.equal((await f.pool.query('SELECT owner_platform_user_id FROM user_bots WHERE id=$1',[f.botId])).rows[0]!.owner_platform_user_id,'202')
    await f.pool.query('DROP TRIGGER synthetic_revoke_binding ON gugu_im_owner_session_receipts');await f.pool.query('DROP FUNCTION synthetic_revoke_binding()')
    assert.equal(await port.bind({...first,toolCallId:'synthetic-restore-binding'},new AbortController().signal),'bound')
    bindingChecksComplete=true
    for(let i=0;i<400;i++){if((await f.pool.query('SELECT 1 FROM agent_run_dispatch')).rowCount===2)break;await delay(25)}
    const pending=(await f.pool.query(`SELECT d.token,d.fence::text,EXISTS(SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id) AS started FROM agent_run_dispatch d WHERE d.session_id=$1`,[web.id])).rows[0]
    assert.deepEqual(pending,{token:null,fence:'0',started:false},'同一私聊切换Web目标不能与旧Run并行')
    assert.equal(mainCalls,2,'新目标只能在旧Run结束后调用Provider')
    return stream({content:'合成绑定成功'})
   }
   assert.match(JSON.stringify(body.messages),/合成网页事实/);assert.ok(!JSON.stringify(body.messages).includes('他人秘密'))
   return stream({content:'合成继续网页会话成功'})
  }}
  const platform:ProviderTransport={async request(request,signal){
   const path=new URL(request.url).pathname
   if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
   if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
   if(path.endsWith('/getUpdates')){
    const index=++polls
    if(index>3)return blocked(signal)
    if(index===2){for(let i=0;i<400&&!bindingChecksComplete;i++){signal.throwIfAborted();await delay(25)}assert.ok(bindingChecksComplete)}
    if(index===3){for(let i=0;i<400;i++){signal.throwIfAborted();if(delivered.length===2&&(await f.pool.query("SELECT 1 FROM agent_run_dispatch WHERE state<>'done'")).rowCount===0)break;await delay(25)}assert.equal(delivered.length,2)}
    return response({ok:true,result:[{update_id:3100+index,message:{message_id:3200+index,date:Math.floor(Date.now()/1000),from:{id:202,first_name:'合成人物'},chat:{id:202,type:'private'},text:index===1?'将私聊绑定到指定网页会话':index===2?'继续刚才的网页计划':'/compact'}}]})
   }
   if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
   if(path.endsWith('/sendMessage')){const body=JSON.parse(Buffer.from(request.body as Uint8Array).toString());delivered.push(body.text);return response({ok:true,result:{message_id:3400+delivered.length}})}
   throw Error('未配置的合成平台请求')
  }}
  previous=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-owner-session']) as string[])
  runtime=createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
   mcpRuntime:{async invalidate(){throw Error('不用MCP')}},diagnose:code=>diagnostics.push(code),testing:{intervalMs:100,provider:{transport:provider},platform:{transport:()=>platform,resolve:async()=>[{address:'11.22.33.44',family:4}]}}})
  await runtime.start()
  for(let i=0;i<500;i++){if(delivered.length===3&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rows.length===2)break;await delay(40)}
  assert.equal(delivered.length,3,JSON.stringify({diagnostics,health:runtime.health(),mainCalls,summaryCalls,delivered}))
  assert.equal(mainCalls,3,JSON.stringify({diagnostics,delivered,toolMessages:bodies.map(body=>(body.messages as {role:string;content:unknown}[]).filter(m=>m.role==='tool')),
   receipts:(await f.pool.query('SELECT status,target_session_id FROM gugu_im_owner_session_receipts')).rows,
   dispatch:(await f.pool.query('SELECT state,blocked_reason,session_id FROM agent_run_dispatch')).rows}));assert.match(delivered[1]!,/继续网页/)
  assert.equal(summaryCalls,1);assert.match(delivered[2]!,/已经整理/)
  assert.equal((await f.pool.query("SELECT 1 FROM agent_run_startups")).rowCount,2,'整理命令不能伪造第三个Agent Run')
  assert.equal((await f.pool.query("SELECT 1 FROM gugu_im_compact_commands WHERE state='compacted' AND session_id=$1",[web.id])).rowCount,1)
  assert.match((await f.pool.query("SELECT content FROM conversation_messages WHERE role='summary' AND session_id=$1",[web.id])).rows[0]!.content,/合成压缩摘要/)
  const dispatch=(await f.pool.query('SELECT session_id FROM agent_run_dispatch ORDER BY sequence')).rows
  assert.notEqual(dispatch[0]!.session_id,web.id);assert.equal(dispatch[1]!.session_id,web.id)
  const receipts=(await f.pool.query('SELECT status,target_session_id FROM gugu_im_owner_session_receipts')).rows
  assert.equal(receipts.length,4);assert.ok(receipts.some(row=>row.target_session_id===other.id&&row.status==='denied'));assert.ok(receipts.some(row=>row.target_session_id===web.id&&row.status==='bound'))
  const services=createImOwnerSessions({pool:f.pool,secretKey:f.secretKey,supportedPlatforms:()=>['telegram']}),client=await f.pool.connect()
  try{
   const binding={ownerId:f.ownerId,botId:f.botId,platform:'telegram' as const},payload={owner_user_id:f.ownerId,bot_id:f.botId,platform:'telegram',chat_type:'c2c',platform_user_id:'202',text:'合成读路由',message_id:'3999'}
   assert.equal(await services.readLocked(client,binding,payload),web.id)
   assert.equal(await services.readLocked(client,binding,{...payload,platform_user_id:'999'}),null)
   assert.equal(await services.readLocked(client,binding,{...payload,chat_type:'group',chat_id:'-500'}),null)
   const otherBot=await f.insert('user_bots',{user_id:f.ownerId,platform:'telegram',name:'合成第二机器人',app_id:'synthetic-second',app_secret:'synthetic-not-used',enabled:true,owner_platform_user_id:'202'})
   assert.equal(await services.readLocked(client,{...binding,botId:String(otherBot.id)},{...payload,bot_id:String(otherBot.id)}),null)
   await f.pool.query("UPDATE gugu_im_owner_sessions SET expires_at=clock_timestamp()-interval '1 second'")
   assert.equal(await services.readLocked(client,binding,payload),null)
   await f.pool.query("UPDATE gugu_im_owner_sessions SET expires_at=clock_timestamp()+interval '12 hours'")
   await f.pool.query("UPDATE user_bots SET owner_platform_user_id='999' WHERE id=$1",[f.botId])
   assert.equal(await services.readLocked(client,binding,payload),null)
  }finally{client.release()}
  assert.equal(bodies.length,3)
 }finally{
  try{await runtime?.stop()}finally{
   if(previous){const keys=await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-owner-session']) as string[];for(const key of keys.filter(key=>!previous!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])}
   await redis.close();await f.close()
  }
 }
})
