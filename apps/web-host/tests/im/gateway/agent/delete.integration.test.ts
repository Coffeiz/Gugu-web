import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {ProviderTransport} from '@gugu/core/providers'
import {createApp} from '../../../../src/app.js'
import {signedUserToken} from '../../../helpers/auth.js'
import {createNodeImHostRuntime} from '../../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../../src/adapters/cache/redis-stream-commands.js'
import {createImProductionFixture} from '../production.fixtures.js'
const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
function blocked(signal:AbortSignal):Promise<never>{return new Promise((_resolve,reject)=>{if(signal.aborted)reject(Error('合成请求取消'));else signal.addEventListener('abort',()=>reject(Error('合成请求取消')),{once:true})})}
async function until(check:()=>Promise<boolean>,detail:()=>Promise<unknown>){for(let i=0;i<800;i++){if(await check())return;await delay(25)}assert.fail(JSON.stringify(await detail()))}

for(const mode of ['completed','active','bot-disabled','owner-unbound','group-disabled'] as const)test(`正式显式删除/${mode}：认证owner取消与删除→Redis丢失后旧事件不复活`,{
 skip:!(databaseUrl&&redisUrl&&python)&&'需专用隔离PG/Redis及离线ORM解释器',timeout:120000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),redis=createRedisStreamCommands(redisUrl!)
 const active=mode!=='completed',revoked=!['completed','active'].includes(mode),group=mode==='group-disabled'
 const config=JSON.parse(await readFile(f.configPath,'utf8'));config.agent.memory_enabled=false;await writeFile(f.configPath,JSON.stringify(config))
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,baseline:Set<string>|undefined,mainCalls=0,sent=0,polls=0,aborted=false,initial=true,legacyCalls=0
 let accessRevoked=false
 const revokedRequests:string[]=[]
 const diagnostics:string[]=[]
 const packet={update_id:33000,message:{message_id:33001,date:Math.floor(Date.now()/1000),from:{id:202,first_name:'合成人物'},chat:group?{id:-404,type:'group'}:{id:202,type:'private'},text:'合成会话删除问题'}}
 const provider:ProviderTransport={async request(request,signal){const body=request.body as Record<string,unknown>
  if(!body.stream)return response({choices:[{message:{content:'{}'}}]})
  mainCalls++
  if(active){try{return await blocked(signal)}finally{aborted=true}}
  return response(`data: ${JSON.stringify({choices:[{delta:{content:'合成删除前回复'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)
 }}
 const platform:ProviderTransport={async request(request,signal){const path=new URL(request.url).pathname
  if(accessRevoked&&(path.endsWith('/sendChatAction')||path.endsWith('/sendMessage')))revokedRequests.push(path.split('/').at(-1)!)
  if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
  if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
  if(path.endsWith('/getUpdates')){polls++;if(initial){initial=false;return response({ok:true,result:[packet]})}return blocked(signal)}
  if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
  if(path.endsWith('/sendMessage')){sent++;return response({ok:true,result:{message_id:34000+sent}})}
  throw Error('未配置的合成删除平台请求')
 }}
 const make=()=>createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
  mcpRuntime:{async invalidate(){}},testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'9.9.9.9',family:4}]}},diagnose:code=>diagnostics.push(code)})
 const ports={async removeIfUnreferenced(){legacyCalls++;return false},async clearReflection(){legacyCalls++}}
 const app=createApp({appName:'合成删除测试',isReady:async()=>true,userAuth:{secret:f.secretKey,async lookupUser(id){return{id,username:'moon_example',displayName:null,email:'moon@example.test',avatarUrl:null,createdAt:null,timezone:null,emailSubscribed:false,imChannels:[],isActive:true}}},
  deleteAgentSession:{remove:(owner,sid)=>runtime!.removeSession(owner,sid,ports,async()=>{legacyCalls++;return false})}})
 const remove=(owner:string,sid:number)=>app.inject({method:'DELETE',url:`/api/v1/agent/sessions/${sid}`,headers:{authorization:`Bearer ${signedUserToken(f.secretKey,owner)}`}})
 try{
  baseline=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-delete-cleanup']) as string[])
  runtime=make();await runtime.start()
  await until(async()=>mainCalls===1&&(active||(sent===1&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===1)),async()=>({mainCalls,sent,diagnostics}))
  const session=(await f.pool.query("SELECT id FROM conversation_sessions WHERE source='telegram' AND user_id=$1",[f.ownerId])).rows[0];assert.ok(session)
  if(!active)await until(async()=>(await f.pool.query(`SELECT 1 FROM conversation_sessions s WHERE s.id=$1 AND s.active_run_id IS NULL AND s.execution_state='idle'
    AND NOT EXISTS(SELECT 1 FROM agent_run_dispatch d WHERE d.user_id=s.user_id AND d.session_id=s.id AND d.state<>'done')
    AND NOT EXISTS(SELECT 1 FROM agent_run_events e LEFT JOIN gugu_im_run_delivery r ON r.user_id=e.user_id AND r.session_id=e.session_id AND r.run_id=e.run_id
      WHERE e.user_id=s.user_id AND e.session_id=s.id AND e.sequence>coalesce(r.cursor,0))`,[session.id])).rowCount===1,
    async()=>({diagnostics,session:(await f.pool.query('SELECT execution_state,active_run_id FROM conversation_sessions WHERE id=$1',[session.id])).rows}))
  assert.equal((await remove(f.otherOwnerId,Number(session.id))).statusCode,404)
  assert.equal((await f.pool.query('SELECT 1 FROM conversation_sessions WHERE id=$1',[session.id])).rowCount,1)
  if(mode==='bot-disabled')await f.pool.query('UPDATE user_bots SET enabled=false WHERE user_id=$1 AND id=$2',[f.ownerId,f.botId])
  if(mode==='owner-unbound')await f.pool.query('UPDATE user_bots SET owner_platform_user_id=NULL WHERE user_id=$1 AND id=$2',[f.ownerId,f.botId])
  if(group)await f.pool.query('UPDATE user_bots SET group_chat_enabled=false WHERE user_id=$1 AND id=$2',[f.ownerId,f.botId])
  accessRevoked=revoked
  const deleted=await remove(f.ownerId,Number(session.id))
  assert.equal(deleted.statusCode,204,JSON.stringify({body:deleted.body,diagnostics,checkpoints:(await f.pool.query('SELECT status FROM agent_run_checkpoints')).rows}))
  assert.equal(aborted,active);assert.equal(legacyCalls,0)
  if(revoked)assert.equal(sent,0,'owner删除授权不能恢复平台出站权限或发送取消文本')
  assert.deepEqual(revokedRequests,[],'撤权后文本与typing平台API都不能恢复发送')
  assert.equal((await f.pool.query('SELECT 1 FROM conversation_sessions WHERE id=$1',[session.id])).rowCount,0)
  assert.equal((await f.pool.query('SELECT 1 FROM gugu_im_retired_inbound WHERE user_id=$1',[f.ownerId])).rowCount,1)
  const sentBefore=sent
  await runtime.stop();runtime=undefined
  // 仅恢复合成Bot，让重放确实经过平台入站和永久去重，而不是因停用根本没有消费。
  if(revoked)await f.pool.query("UPDATE user_bots SET enabled=true,group_chat_enabled=true,owner_platform_user_id='202' WHERE user_id=$1 AND id=$2",[f.ownerId,f.botId])
  accessRevoked=false
  for(const key of(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-delete-cleanup']) as string[]).filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])
  initial=true;polls=0;runtime=make();await runtime.start()
  await until(async()=>polls>1&&await redis.sendCommand(['EVAL',"return redis.call('XLEN',KEYS[1])",'1','im:node:inbound'])===1
   &&(await redis.sendCommand(['EVAL',"return redis.call('XPENDING',KEYS[1],ARGV[1])",'1','im:node:inbound','gugu-node-im-v1']) as unknown[])?.[0]===0,async()=>({polls,mainCalls,diagnostics}))
  assert.equal(mainCalls,1);assert.equal(sent,sentBefore)
  assert.equal((await f.pool.query("SELECT 1 FROM conversation_sessions WHERE source='telegram' AND user_id=$1",[f.ownerId])).rowCount,0)
 }finally{try{await app.close();await runtime?.stop()}finally{
  if(baseline)for(const key of(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-delete-cleanup']) as string[]).filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])
  await redis.close();await f.close()
 }}
})
