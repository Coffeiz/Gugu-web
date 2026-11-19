import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {test} from 'node:test'
import {stableJson,type CanonicalContextPorts,type RunIdentity} from '@gugu/core/agent'
import {ProviderStreamSanitizer,stripThinking} from '@gugu/core/providers'
import {createImProductionFixture} from './production.fixtures.js'
import {createConfiguredImAgentProviderBinding} from '../../../src/modules/im/gateway/agent/provider.js'
import {createPostgresImAccess} from '../../../src/modules/im/gateway/inbound/access.js'
import {createImProductionReflectionBindings} from '../../../src/modules/im/gateway/memory/bindings.js'
import {createImReflectionService} from '../../../src/modules/im/gateway/memory/jobs.js'
import {createImContextReferenceCodec} from '../../../src/modules/im/gateway/agent/references.js'
import {createImInboundEnvelope} from '../../../src/modules/im/gateway/inbound/envelope.js'
import {createImReflectionCodec} from '../../../src/modules/im/gateway/memory/codec.js'
import {reflectionFileKey} from '../../../src/modules/im/gateway/memory/files.js'
import type {ImReflectionJob} from '../../../src/modules/im/gateway/memory/contracts.js'
import {imConversationScopeHash,imConversationDigest,imConversationFingerprint} from '../../../src/modules/im/gateway/agent/identity.js'
import {enqueueAgentRunLocked} from '../../../src/modules/agent/run/dispatch.js'
import {createCanonicalHistoryWriter} from '../../../src/modules/agent/chat/write.js'
import {createPersistentAgentRuntimeWithContextFactory} from '../../../src/modules/agent/run/runtime.js'
import {agentContextSnapshotPrefix} from '@gugu/core/agent'
import {createRedisAgentCancellationCommands} from '../../../src/adapters/cache/redis-events.js'
import {createRedisLiveSubscription} from '../../../src/adapters/cache/redis-live-subscription.js'
import type {ImReflectionService,ImReflectionServiceOptions} from '../../../src/modules/im/gateway/memory/contracts.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const digest=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex')
test('正式配置/Access/PG/Harness/checkpoint→新生产Provider绑定恢复私聊及群成员，隔离原scope且公开群不重建',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需显式隔离PG/Redis及Linux真实FS配置锁环境',timeout:120000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!,platform:'qq'})
 let service:ImReflectionService|undefined
 try{
  await f.pool.query('UPDATE user_bots SET member_memory_enabled=true,group_memory_enabled=true WHERE id=$1',[f.botId])
  const access=createPostgresImAccess({query:(q,p)=>f.pool.query(q,p),supportedPlatforms:()=>['qq']})
  const model=await createConfiguredImAgentProviderBinding({pool:f.pool,configPath:f.configPath,versionSecret:f.secretKey,promptRoot:f.promptRoot,
   environment:f.environment,permissionIdentity:'synthetic-member-reflection',defaultLimit6h:null})
  async function route(query:Pick<typeof f.pool,'query'>,id:RunIdentity){
   const rows=(await query.query(`SELECT r.sealed_payload FROM gugu_im_inbound_receipts r JOIN conversation_sessions s ON s.id=r.session_id AND s.user_id=r.user_id
    WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.platform='qq' AND r.bot_id=$4`,[id.ownerId,id.sessionId,id.runId,f.botId])).rows
   if(rows.length!==1)return null
   const binding={ownerId:id.ownerId,botId:f.botId,platform:'qq' as const}
   return{binding,payload:createImInboundEnvelope(f.secretKey).open(binding,rows[0].sealed_payload)}
  }
  const readRoute:ImReflectionServiceOptions['readRoute']=id=>route(f.pool,id)
  let calls=0
  const provider={transport:{async request(request:import('@gugu/core/providers').ProviderHttpRequest){
   calls++;const body=request.body as Record<string,unknown>
   const output=body.stream===true?'data: {"choices":[{"delta":{"content":"合成成员回答"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'
    :JSON.stringify({choices:[{message:{content:JSON.stringify({profile_add:[{type:'note',text:'合成成员喜好'}],summary:'合成成员范围总结'})},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}})
   return{status:200,headers:{},body:(async function*(){yield Buffer.from(output)})(),cancel(){}}
  }}}
  const bindings=createImProductionReflectionBindings({...f,access,model,memoryEnabled:async()=>true,redisUrl:redisUrl!,readRoute,
   publicAppUrl:null,diagnose(){},provider,voice:null,voiceCache:null,ownerSessions:null,sender:()=>null,controls:null,nativeInteraction:null,retention:null} as never)
  const serviceOptions:ImReflectionServiceOptions={pool:f.pool,secretKey:f.secretKey,storageRoot:f.storageRoot,supportedPlatforms:()=>['qq'],
   readRoute,async readRouteLocked(client,id){return route(client,id)},memoryEnabled:async()=>true,...bindings,diagnose(){},leaseMs:1000,pollMs:10}
  service=createImReflectionService(serviceOptions)
  for(const group of[false,true]){
   const sender='synthetic-member',groupId=group?'synthetic-member-group':null
   const session=await f.insert('conversation_sessions',{user_id:f.ownerId,source:'qq',bot_id:f.botId,chat_type:group?'group':'c2c',chat_id:groupId,
    platform_user_id:sender,execution_state:'idle',last_message_seq:1})
   const identity:RunIdentity={ownerId:f.ownerId,sessionId:String(session.id),runId:randomUUID()}
   const scope={ownerId:f.ownerId,botId:f.botId,platform:'qq' as const,chatType:group?'group' as const:'c2c' as const,chatId:groupId,platformUserId:sender}
   const actorInput={...scope,botMentioned:group,mentionsOtherBot:false},snapshot=await access.snapshot(actorInput),actor=snapshot.actor(actorInput)
   assert.equal(actor.role,'member')
   const bound=await model.bindRun(identity,actor,snapshot.bot,true,'zh-CN'),selected=await bound.resolve(identity,bound.selection.modelIdentity,new AbortController().signal)
   assert.ok(bound.selection.contextScopeKey)
   const binding={ownerId:f.ownerId,botId:f.botId,platform:'qq' as const},payload={owner_user_id:f.ownerId,platform:'qq',bot_id:f.botId,channel_id:f.botId,
    platform_user_id:sender,chat_type:scope.chatType,chat_id:groupId,message_id:`synthetic-${identity.runId}`,platform_message_id:`synthetic-${identity.runId}`,
    bot_mentioned:group,text:'合成成员本轮原话',_node_stream_event_id:'1791000000000-1'}
   const anchor=await f.insert('conversation_messages',{session_id:session.id,conversation_seq:1,role:'user',content:payload.text,
    platform_user_id:sender,chat_type:scope.chatType,im_platform_message_id:payload.message_id,run_id:identity.runId})
   const hash=imConversationScopeHash(f.secretKey,binding,payload)
   await f.pool.query(`INSERT INTO gugu_im_inbound_receipts(user_id,session_id,message_id,run_id,state,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,sealed_payload)
    VALUES($1,$2,$3,$4,'dispatched','qq',$5,$6,$7,$8,$9,$10)`,[f.ownerId,session.id,anchor.id,identity.runId,f.botId,scope.chatType,hash,
     imConversationDigest(f.secretKey,[hash,sender,payload.message_id]),imConversationFingerprint(f.secretKey,hash,payload,[]),createImInboundEnvelope(f.secretKey).seal(binding,payload)])
   const client=await f.pool.connect();try{await client.query('BEGIN');await enqueueAgentRunLocked(client,f.secretKey,identity,{v:3,source:'im',userMessageId:anchor.id,
    locale:'zh-CN',origin:null,accessVersion:bound.selection.contextScopeKey,im:{platform:'qq',botId:f.botId,chatType:scope.chatType,chatId:groupId,platformUserId:sender}},600);await client.query('COMMIT')}finally{client.release()}
   const authorize=()=>access.authorizeDelivery(actor,snapshot.bot),references=createImContextReferenceCodec({pool:f.pool,identity,scope,authorize})
   const frozen='合成成员上下文：仅当前平台、Bot与当前会话公开内容。',prefix=agentContextSnapshotPrefix(frozen)
   const prepareRequest:CanonicalContextPorts['prepareRequest']=async()=>({prefix,dynamicTail:[]})
   const current=service,writer=createCanonicalHistoryWriter(async()=>bound.usageConfig,{afterSuccess:(...args)=>current.historyHook(...args),usageSource:'qq'})
   const runtime=await createPersistentAgentRuntimeWithContextFactory({pool:f.pool,secretKey:f.secretKey,redis:createRedisAgentCancellationCommands(redisUrl!),
    subscribe:createRedisLiveSubscription(redisUrl!),scheduling:{mode:'direct'},history:{writeHistory:writer},
    provider:{...provider,resolve:bound.resolve},context:{services:{digest,nextId:randomUUID,references,prepareRequest},async createContext(providerRuntime){return{
     digest,nextId:randomUUID,references,prepareRequest,async load(){return{modelIdentity:bound.selection.modelIdentity,contextWindow:bound.selection.contextWindow,
      accessScopeHash:selected.accessScopeHash,input:{...identity,fixedPrefix:prefix,history:[],historyBaseline:{baselineSeq:0,baselineHash:null,snapshotHash:null},
       currentUser:{persistedMessageId:String(anchor.id),message:{role:'user',content:payload.text}},preparedRag:{tail:[]}},capabilities:{tools:[],toolNames:[]},
      sourceEffects:{sessionSnapshot:{expectedEpoch:Number(session.context_epoch),expectedSnapshotHash:null,phase:'rebuild',state:{ownerId:f.ownerId,sessionId:identity.sessionId,contextEpoch:Number(session.context_epoch)+1,
       context:{access_scope_hash:selected.accessScopeHash,snapshot_context:frozen},snapshotHash:'synthetic-snapshot',sessionInfoHash:null,snapshotExpiresAt:null,baselineMessageSeq:0}}}} as never},
     preparation:{buildRag:async()=>({tail:[]})},compaction:{async summarize(){throw Error('本测试无压缩')}},finalization:await current.createFinalizer({identity,modelIdentity:bound.selection.modelIdentity,provider:providerRuntime}),
     currentRequest:()=>null,stageContinuation:providerRuntime.stageContinuation,releaseContinuations:providerRuntime.releaseContinuations,diagnoseCompactionFailure(){}}}},
    executor:{async authorize(){throw Error('本测试无执行请求')},executor:{async execute(){throw Error('本测试无执行请求')}}},
    runtime:{clock:{now:()=>new Date().toISOString()},tools:{async dispatch(){throw Error('本测试无工具')},async reconcile(){return{kind:'unknown'}}},
     interactions:{async activate(_id,request){return request}},sanitizeText:stripThinking,createStreamSanitizer:()=>new ProviderStreamSanitizer(),presentError:()=>({code:'failed',text:'合成失败'}),presentToolResult:async value=>value,publish:async()=>{},diagnose(){}}})
   try{await runtime.startup.register(identity);for await(const _event of runtime.harness.start(identity)){};assert.equal((await runtime.store.read(identity))?.status,'completed')}
   finally{await runtime.close();bound.release()}
   await f.pool.query("UPDATE agent_run_dispatch SET state='done' WHERE user_id=$1 AND session_id=$2 AND run_id=$3",[f.ownerId,session.id,identity.runId])
   await service.stop();service=createImReflectionService(serviceOptions)
   await f.pool.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp() WHERE session_id=$1",[session.id])
   const before=calls
   for(let i=0;i<(group?2:1);i++)assert.equal(await service.runOnce(),true)
   const jobs=(await f.pool.query('SELECT * FROM gugu_im_reflection_jobs WHERE session_id=$1',[session.id])).rows
   assert.equal(jobs.filter(row=>row.state==='completed').length,1);assert.equal(calls,before+1)
   if(group)assert.equal(jobs.filter(row=>row.state==='deferred').length,1)
   const completed=jobs.find(row=>row.state==='completed')!,job=createImReflectionCodec(f.secretKey).open(completed,completed.nonce,completed.payload,'job') as unknown as ImReflectionJob
   assert.equal(job.scope.type,'platform-user');assert.equal(job.scope.id,group?`${groupId}:${sender}`:sender)
   assert.match(await readFile(join(f.storageRoot,reflectionFileKey(job,'summary')),'utf8'),/合成成员范围总结/)
   const signal=new AbortController().signal,guarded=await bindings.resolveRuntime(job,signal,async()=>await authorize()
    &&await model.accessVersion(identity,actor,snapshot.bot,true)===bound.selection.contextScopeKey)
   try{
    const prior=calls
    assert.equal(await bindings.rebuildMemberSnapshot!({...job,scope:{type:'platform-user',id:group?'other-group:synthetic-member':'other-member'}},guarded,signal),null)
    assert.equal(await bindings.rebuildMemberSnapshot!({...job,scope:{type:'group',id:groupId??'other-group'}},guarded,signal),null)
    await assert.rejects(bindings.rebuildMemberSnapshot!({...job,identity:{...identity,ownerId:f.otherOwnerId}},guarded,signal))
    await f.pool.query('UPDATE user_bots SET enabled=false WHERE id=$1',[f.botId])
    await assert.rejects(bindings.rebuildMemberSnapshot!(job,guarded,signal))
    assert.equal(calls,prior,'拒绝/快照重建本身均不能发Provider HTTP')
   }finally{await guarded.release();await f.pool.query('UPDATE user_bots SET enabled=true WHERE id=$1',[f.botId])}
  }
 }finally{await service?.stop();await f.close()}
})
