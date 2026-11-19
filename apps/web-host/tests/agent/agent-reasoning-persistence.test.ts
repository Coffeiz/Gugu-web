import { agentReasoningSql } from '@gugu/database/postgres/migrations/0012_agent_reasoning'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {test} from 'node:test'
import type {Pool} from 'pg'
import {prepareContext,savePreparedContext,stableJson,type CanonicalRunContext,type RunCheckpoint,type RunIdentity,type Lease,type ProviderEvent,type RunCapabilities} from '@gugu/core/agent'
import {ProviderRuntime,type ProviderHttpRequest} from '@gugu/core/providers'
import {createProviderReasoningPersistence,AgentReasoningUnavailableError} from '../../src/modules/agent/run/reasoning/active.js'
import {createPostgresAgentRunStore} from '../../src/modules/agent/run/store.js'
import type {ResponsesReasoningBinding} from '../../src/modules/agent/run/reasoning/bridge.js'

const digest=(v:unknown)=>createHash('sha256').update(stableJson(v)).digest('hex')
const owner='00000000-0000-4000-8000-000000000501',other='00000000-0000-4000-8000-000000000502'
const identity:RunIdentity={ownerId:owner,sessionId:'1',runId:'synthetic-reasoning-run'}
const lease:Lease={token:'synthetic-lease',fence:1},signal=()=>new AbortController().signal
const capabilities=(kind:'string'|'number'='string'):RunCapabilities=>({toolNames:['lookup','status'],tools:[
 {name:'lookup',schema:{type:'function',function:{name:'lookup',description:'合成查询',parameters:{type:'object',properties:{query:{type:kind}}}}}},
 {name:'status',schema:{type:'function',function:{name:'status',description:'合成状态',parameters:{type:'object',properties:{}}}}}]})
const refs={async hydrate(entry:{message:CanonicalRunContext['prepared']['area']['entries'][number]['message']}){return structuredClone(entry.message)},async dehydrate(entry:{message:CanonicalRunContext['prepared']['area']['entries'][number]['message']}){return structuredClone(entry.message)}}
async function context(id=identity):Promise<CanonicalRunContext>{
 const prepared=await prepareContext({...id,fixedPrefix:[{role:'system',content:'合成规则'}],history:[{...id,id:'old-user',conversationSeq:1,role:'user',content:'旧问题'},
  {...id,id:'old-assistant',conversationSeq:2,role:'assistant',content:'旧回答'}],currentUser:{persistedMessageId:'current-user',message:{role:'user',content:'合成当前问题'}}},
 {digest,nextId:randomUUID,buildRag:async()=>({tail:[]})})
 return{identity:id,modelIdentity:'selection',accessScopeHash:'scope',contextWindow:4096,capabilities:null,replyContext:{userRequest:'合成当前问题',locale:'zh-CN',decisionGuardEnabled:false},
  prepared:await savePreparedContext(prepared,id,refs),compactions:[],continuationRef:null,pendingRound:null,failedCompactionInput:null,sourceEffects:null,providerCacheAnchor:null,currentProviderInput:null}
}
function checkpoint(version:number,ctx:CanonicalRunContext|null):RunCheckpoint<CanonicalRunContext>{
 return{identity,version,sequence:0,status:'running',phase:'provider',round:1,context:ctx,text:'',roundTexts:[],displayTimeline:[],anchorMessageId:null,
  usage:{input:0,output:0,cacheRead:0,cacheWrite:0,contextInput:null},totalUsage:{input:0,output:0,cacheRead:0,cacheWrite:0,contextInput:null},usageAppliedRound:0,
  providerCursor:null,sanitizerCheckpoint:{kind:'clean'},mutated:false,unpersistedToolResult:null,files:[],providerRounds:[],calls:[],callIndex:0,
  inflightCall:null,inflightCalls:[],parallelLimit:null,pending:null,queuedInteractions:[],replayCall:null,replayResultReady:false,toolResults:[],toolsDispatched:false,
  parallelCallIds:[],serialCallIds:[],isolatedCallIds:[],resolution:null,resolutionClosure:null,emptyRetries:0,replyState:{},overflowRetries:0,overflowRecoveryPending:false,
  maxRounds:null,goalMode:false,replyChoice:'disabled',roundRequiresTools:false,completedToolCount:0,remoteStatusUnknown:false,errorCode:null,earlyExitReason:null} as unknown as RunCheckpoint<CanonicalRunContext>
}
const dbUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL??process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('隔离PG：真实Provider私有状态与checkpoint原子保存、重启精确恢复、成功跨Run与off失效',{
 skip:!dbUrl&&'未运行：需显式隔离PG验证checkpoint/CAS/加密；query替身不能证明持久恢复',
},async t=>{
 const{Pool}=await import('pg'),admin=new Pool({connectionString:dbUrl}),schema=`reasoning_active_${randomUUID().replaceAll('-','')}`
 let pool:Pool|undefined;const runtimes:ProviderRuntime[]=[]
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:dbUrl,options:`-c search_path=${schema} -c lock_timeout=2000`,max:4})
  const db=pool
  await db.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean);
   CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid REFERENCES users(id));
   CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text);
   CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id varchar(128),token text,fence bigint,expires_at timestamptz);
   CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id varchar(128),version bigint,sequence bigint,status text,phase text,nonce bytea,payload bytea,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
   CREATE TABLE agent_run_events(user_id uuid,session_id integer,run_id varchar(128),event_id text,sequence bigint,nonce bytea,payload bytea,created_at timestamptz,acknowledged_at timestamptz);
   CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id varchar(128),receipt text,created_at timestamptz);
   CREATE TABLE synthetic_history(body text);
   CREATE TABLE provider_reasoning_states(user_id uuid,session_id integer UNIQUE,version integer,state_version integer,status text,provider text,api_format text,model_id text,
    reasoning_persistence text,config_digest text,reasoning_config_digest text,source_run_id text,source_round_id text,sequence integer,state_kind text,encrypted_payload text,payload_nonce text,
    encrypted_data_key text,key_version integer,payload_digest text,payload_size integer,state_summary jsonb,invalidated_reason text,invalidated_at timestamptz,created_at timestamptz,last_used_at timestamptz,expires_at timestamptz,updated_at timestamptz)`)
  await db.query(agentReasoningSql.agentReasoningActive)
  await db.query('INSERT INTO users VALUES($1,true),($2,true);',[owner,other]);await db.query('INSERT INTO conversation_sessions VALUES(1,$1),(2,$2)',[owner,other])
  await db.query("INSERT INTO agent_run_leases VALUES($1,1,$2,$3,1,clock_timestamp()+interval '1 hour')",[owner,identity.runId,lease.token])
  const binding=(id=identity):ResponsesReasoningBinding=>({identity:{ownerId:id.ownerId,sessionId:id.sessionId,provider:'openai',apiFormat:'responses',model:'synthetic-model',configDigest:'a'.repeat(64),reasoningConfigDigest:'b'.repeat(64)},
   runId:id.runId,modelIdentity:'selection',accessScopeHash:'scope',expectedVersion:0})
  const authorize=async()=>!!(await db.query('SELECT 1 FROM users WHERE id=$1 AND is_active IS TRUE',[owner])).rows.length
  let service:ReturnType<typeof createProviderReasoningPersistence>,failure=false
  const sent:ProviderHttpRequest[]=[]
  function provider(){
   const runtime=new ProviderRuntime({digest,nextId:randomUUID,references:refs,prepareRequest:async()=>({prefix:[],dynamicTail:[]}),
    resolve:async(_id,modelIdentity)=>({modelIdentity,accessScopeHash:'scope',config:{provider:'openai',api_format:'responses',model:'synthetic-model',reasoning_persistence:'continuation',base_url:'https://provider.example/v1'},systemPrompt:'合成规则'}),
    ensureContinuation:async(ctx,s)=>service.ensure(ctx,s),transport:{async request(request){sent.push(request)
     const response={type:'response.completed',response:{status:'completed',output:[{type:'reasoning',id:'rs-synthetic',encrypted_content:'synthetic-private-native'},
      {type:'message',content:[{type:'output_text',text:'合成回答'}]}]}}
     return{status:200,headers:{},body:(async function*(){yield Buffer.from(`data: ${JSON.stringify(response)}\n\n`)})(),cancel(){}}
    }}});runtimes.push(runtime);return runtime
  }
  let runtime=provider();service=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:runtime,binding:binding(),mode:'continuation',authorize})
  let store=createPostgresAgentRunStore<CanonicalRunContext>(db,'synthetic-checkpoint-secret',{persistPrivateContext:(...args)=>service.checkpointHook(...args),async writeHistory(client,_id,history){
   if(history.outcome==='success')await service.commitSuccess(client,history.context)
   await client.query('INSERT INTO synthetic_history VALUES($1)',[history.text]);if(failure)throw Error('synthetic-private-history-failure')
  }})
  let ctx=await context(),current=checkpoint(0,null),activeCipher:{nonce:Buffer;payload:Buffer}|undefined
  await store.create(current,lease,[])
  await t.test('真实Responses输出的私有continuation只经Provider内存→同checkpoint事务加密，正文/私有值不在明文列',async()=>{
   assert.equal(await service.initialize(ctx,signal(),ctx.prepared.area.digest),null)
   const events:ProviderEvent[]=[];for await(const e of runtime.stream({identity,context:ctx,round:1,signal:signal(),replyChoice:'disabled'}))events.push(e)
   const done=events.find(e=>e.type==='complete');assert.ok(done&&done.type==='complete'&&done.continuation)
   const ref=await runtime.stageContinuation({identity,modelIdentity:'selection',accessScopeHash:'scope',round:1,areaDigest:'original-source-area-digest',value:done.continuation})
   ctx={...ctx,continuationRef:ref};current=checkpoint(1,ctx)
   await store.commit({identity,lease,expectedVersion:0,checkpoint:current,events:[],history:null,interactionReceipt:null})
   const raw=JSON.stringify((await db.query('SELECT * FROM gugu_agent_active_reasoning')).rows)
   activeCipher=(await db.query('SELECT nonce,payload FROM gugu_agent_active_reasoning')).rows[0]
   assert.equal(raw.includes('synthetic-private-native'),false);assert.equal(raw.includes(ref),false)
   assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_reasoning_states')).rows[0].n,0,'活动状态尚未发布成成功会话状态')
  })
  await t.test('重启后checkpoint提交先于Provider时按精确previous续存，原ref/sourceRound/area保持；ensure后真实HTTP重放',async()=>{
   await runtime.close();runtime=provider();service=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:runtime,binding:binding(),mode:'continuation',authorize})
   ctx={...ctx,failedCompactionInput:45};const next=checkpoint(2,ctx)
   await store.commit({identity,lease,expectedVersion:1,checkpoint:next,events:[],history:null,interactionReceipt:null});current=next
   const staged=await runtime.withStagedContinuation(ctx,async item=>item)
   assert.equal(staged.round,1);assert.equal(staged.areaDigest,'original-source-area-digest')
   runtime.finishRun(identity)
   for await(const _event of runtime.stream({identity,context:ctx,round:2,signal:signal(),replyChoice:'disabled'})){}
   assert.equal(sent.length,2);assert.match(JSON.stringify(sent[1]!.body),/synthetic-private-native/)
   assert.equal(ctx.continuationRef,current.context!.continuationRef)
  })
  await t.test('CAS/私有行写失败不推进任一状态，跨context/ref/owner、损坏与过期均固定拒绝',async()=>{
   await db.query("CREATE FUNCTION reject_active() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic-private-sql';END$$;CREATE TRIGGER reject_active BEFORE UPDATE ON gugu_agent_active_reasoning FOR EACH ROW EXECUTE FUNCTION reject_active()")
   await assert.rejects(store.commit({identity,lease,expectedVersion:2,checkpoint:checkpoint(3,ctx),events:[],history:null,interactionReceipt:null}),AgentReasoningUnavailableError)
   assert.equal((await store.read(identity))!.version,2);assert.equal(Number((await db.query('SELECT checkpoint_version FROM gugu_agent_active_reasoning')).rows[0].checkpoint_version),2)
   await db.query('DROP TRIGGER reject_active ON gugu_agent_active_reasoning;DROP FUNCTION reject_active()')
   await assert.rejects(service.ensure({...ctx,continuationRef:'provider:other'},signal()),AgentReasoningUnavailableError)
   await assert.rejects(service.ensure({...ctx,accessScopeHash:'foreign'},signal()),AgentReasoningUnavailableError)
   await assert.rejects(service.ensure({...ctx,capabilities:capabilities()},signal()),AgentReasoningUnavailableError)
   await assert.rejects(service.ensure({...ctx,identity:{...identity,ownerId:other}},signal()),AgentReasoningUnavailableError)
   const raw=(await db.query('SELECT payload FROM gugu_agent_active_reasoning')).rows[0].payload
   await db.query("UPDATE gugu_agent_active_reasoning SET payload=decode(repeat('00',16),'hex')")
   await assert.rejects(service.ensure(ctx,signal()),e=>e instanceof AgentReasoningUnavailableError&&!('cause'in e))
   await db.query('UPDATE gugu_agent_active_reasoning SET payload=$1,expires_at=clock_timestamp()-interval \'1 second\'',[raw]);await assert.rejects(service.ensure(ctx,signal()),AgentReasoningUnavailableError)
   await db.query("UPDATE gugu_agent_active_reasoning SET expires_at=clock_timestamp()+interval '1 hour'")
   await db.query('UPDATE users SET is_active=false WHERE id=$1',[owner]);await assert.rejects(service.ensure(ctx,signal()),AgentReasoningUnavailableError)
   await db.query('UPDATE users SET is_active=true WHERE id=$1',[owner])
  })
  await t.test('成功history、私有成功表与checkpoint同事务：失败回滚后可重试且版本冲突拒绝',async()=>{
   failure=true;const final={...checkpoint(3,ctx),status:'completed' as const,phase:'idle' as const}
   await assert.rejects(store.commit({identity,lease,expectedVersion:2,checkpoint:final,events:[],history:{outcome:'success',context:ctx,text:'合成最终回复'},interactionReceipt:null}))
   assert.equal((await store.read(identity))!.version,2);assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_reasoning_states')).rows[0].n,0)
   failure=false;await store.commit({identity,lease,expectedVersion:2,checkpoint:final,events:[],history:{outcome:'success',context:ctx,text:'合成最终回复'},interactionReceipt:null});current=final
   assert.equal((await db.query('SELECT version FROM provider_reasoning_states')).rows[0].version,1)
   assert.equal((await db.query('SELECT count(*)::int AS n FROM gugu_agent_active_reasoning WHERE user_id=$1',[owner])).rows[0].n,0,'终态清理当前Run私有行，不留每Run大payload')
   const client=await db.connect();try{await client.query('BEGIN');await assert.rejects(service.commitSuccess(client,ctx),AgentReasoningUnavailableError);await client.query('ROLLBACK')}finally{client.release()}
  })
  await t.test('成功状态跨Run加载到新ref/round0，无新round不重写；off真实失效阻止切回后复活',async()=>{
   const nextIdentity={...identity,runId:'synthetic-next-run'},nextCtx=await context(nextIdentity),nextRuntime=provider()
   const nextService=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:nextRuntime,binding:binding(nextIdentity),mode:'continuation',authorize})
   const ref=await nextService.initialize(nextCtx,signal(),nextCtx.prepared.area.digest);assert.ok(ref);assert.notEqual(ref,ctx.continuationRef)
   const loaded={...nextCtx,continuationRef:ref};assert.equal((await nextRuntime.withStagedContinuation(loaded,async item=>item)).round,0)
   const client=await db.connect();try{await client.query('BEGIN');await nextService.commitSuccess(client,loaded);await client.query('COMMIT')}finally{client.release()}
   assert.equal((await db.query('SELECT version FROM provider_reasoning_states')).rows[0].version,1)
   const off=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:nextRuntime,binding:binding(nextIdentity),mode:'off',authorize})
   assert.equal(await off.initialize(nextCtx,signal(),nextCtx.prepared.area.digest),null)
   const row=(await db.query('SELECT status,version,encrypted_payload FROM provider_reasoning_states')).rows[0]
   assert.equal(row.status,'invalidated');assert.equal(row.version,2);assert.equal(row.encrypted_payload,'')
   await off.invalidate(nextCtx,signal())
   assert.equal((await db.query('SELECT version FROM provider_reasoning_states')).rows[0].version,2,'off协议拒绝仍复用真实冻结版本CAS，已失效状态不重复推进版本')
   assert.equal(await nextService.initialize(nextCtx,signal(),nextCtx.prepared.area.digest),null)
  })
  await t.test('未知协议明确拒绝；真实另一owner/Run密文错置即使元数据有效也不能解密恢复',async()=>{
   const unsupported=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:runtime,
    binding:{...binding(),identity:{...binding().identity,apiFormat:'unsupported'}},mode:'continuation',authorize})
   await assert.rejects(unsupported.initialize({...ctx,continuationRef:null},signal(),ctx.prepared.area.digest),AgentReasoningUnavailableError)
   const otherIdentity={ownerId:other,sessionId:'2',runId:'synthetic-other-owner-run'},otherRuntime=provider(),otherCtx=await context(otherIdentity)
   const otherRef=await otherRuntime.stageContinuation({identity:otherIdentity,modelIdentity:'selection',accessScopeHash:'scope',round:1,areaDigest:'other-source-area',
    value:{state_kind:'openai_responses_reasoning',reasoning_items:[{type:'reasoning',id:'rs-other-private'}]}})
   const target={...otherCtx,continuationRef:otherRef},otherService=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:otherRuntime,
    binding:binding(otherIdentity),mode:'continuation',authorize})
   await db.query("INSERT INTO agent_run_leases VALUES($1,2,$2,$3,1,clock_timestamp()+interval '1 hour')",[other,otherIdentity.runId,lease.token])
   const otherStore=createPostgresAgentRunStore<CanonicalRunContext>(db,'synthetic-checkpoint-secret',{persistPrivateContext:otherService.checkpointHook,async writeHistory(){assert.fail('本回归不写成功历史')}})
   await otherStore.create({...checkpoint(0,target),identity:otherIdentity},lease,[])
   await otherService.ensure(target,signal())
   assert.ok(activeCipher)
   await db.query('UPDATE gugu_agent_active_reasoning SET nonce=$1,payload=$2 WHERE user_id=$3',[activeCipher.nonce,activeCipher.payload,other])
   await assert.rejects(otherService.ensure(target,signal()),AgentReasoningUnavailableError)
  })
  await t.test('实际prepared工具Schema变化失效成功状态；工具集合排序不影响同一Schema版本',async()=>{
   const id={...identity,runId:'schema-producer'},producer=provider(),prepared={...await context(id),capabilities:capabilities()}
   const persistence=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:producer,binding:binding(id),mode:'continuation',authorize})
   assert.equal(await persistence.initialize(prepared,signal(),prepared.prepared.area.digest),null)
   const reference=await producer.stageContinuation({identity:id,modelIdentity:'selection',accessScopeHash:'scope',round:1,areaDigest:'schema-source-area',
    value:{state_kind:'openai_responses_reasoning',reasoning_items:[{type:'reasoning',id:'rs-schema-private'}]}})
   const client=await db.connect();try{await client.query('BEGIN');await persistence.commitSuccess(client,{...prepared,continuationRef:reference});await client.query('COMMIT')}finally{client.release()}
   const storedVersion=(await db.query('SELECT version FROM provider_reasoning_states')).rows[0].version
   const sameId={...id,runId:'schema-reorder'},same={...prepared,identity:sameId,capabilities:{toolNames:[...prepared.capabilities.toolNames].reverse(),tools:[...prepared.capabilities.tools].reverse()}}
   const sameService=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:provider(),binding:binding(sameId),mode:'continuation',authorize})
   assert.ok(await sameService.initialize(same,signal(),same.prepared.area.digest))
   const changedId={...id,runId:'schema-changed'},changed={...prepared,identity:changedId,capabilities:capabilities('number')}
   const changedService=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:provider(),binding:binding(changedId),mode:'continuation',authorize})
   assert.equal(await changedService.initialize(changed,signal(),changed.prepared.area.digest),null)
   const row=(await db.query('SELECT version,status,encrypted_payload FROM provider_reasoning_states')).rows[0]
   assert.equal(row.status,'invalidated');assert.equal(row.version,storedVersion+1);assert.equal(row.encrypted_payload,'')
   assert.equal(await sameService.initialize(same,signal(),same.prepared.area.digest),null,'切回原Schema不能复活已失效的旧私有状态')
  })
  await t.test('协议失效只CAS冻结成功版本，旧Run不能清新成功；保留active至真实失败终态再仅清本Run',async()=>{
   async function instance(runId:string){const id={...identity,runId},providerRuntime=provider(),input=await context(id)
    const persistence=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:providerRuntime,binding:binding(id),mode:'continuation',authorize})
    const ref=await persistence.initialize(input,signal(),input.prepared.area.digest)
    return{id,runtime:providerRuntime,persistence,context:{...input,continuationRef:ref}}
   }
   async function publish(runId:string){const item=await instance(runId)
    const ref=await item.runtime.stageContinuation({identity:item.id,modelIdentity:'selection',accessScopeHash:'scope',round:1,areaDigest:`source-${runId}`,
     value:{state_kind:'openai_responses_reasoning',reasoning_items:[{type:'reasoning',id:`rs-${runId}`}]}})
    const client=await db.connect();try{await client.query('BEGIN');await item.persistence.commitSuccess(client,{...item.context,continuationRef:ref});await client.query('COMMIT')}finally{client.release()}
   }
   await publish('invalidation-seed')
   const stale=await instance('stale-incompatible-run');assert.ok(stale.context.continuationRef)
   await publish('newer-success-run')
   const latest=(await db.query('SELECT version,encrypted_payload FROM provider_reasoning_states')).rows[0]
   await assert.rejects(stale.persistence.invalidate(stale.context,signal()),AgentReasoningUnavailableError)
   const preserved=(await db.query('SELECT version,status,encrypted_payload FROM provider_reasoning_states')).rows[0]
   assert.equal(preserved.version,latest.version);assert.equal(preserved.status,'active');assert.equal(preserved.encrypted_payload,latest.encrypted_payload)
   const target=await instance('current-incompatible-run');assert.ok(target.context.continuationRef)
   await db.query('UPDATE agent_run_leases SET run_id=$1 WHERE user_id=$2 AND session_id=1',[target.id.runId,owner])
   const targetStore=createPostgresAgentRunStore<CanonicalRunContext>(db,'synthetic-checkpoint-secret',{persistPrivateContext:target.persistence.checkpointHook,
    async writeHistory(_client,_id,history){assert.equal(history.outcome,'interruption')}})
   const initial={...checkpoint(0,target.context),identity:target.id};await targetStore.create(initial,lease,[])
   await assert.rejects(target.persistence.invalidate({...target.context,identity:{...target.id,ownerId:other}},signal()),AgentReasoningUnavailableError)
   await target.persistence.invalidate(target.context,signal())
   const invalidated=(await db.query('SELECT version,status,invalidated_reason,encrypted_payload FROM provider_reasoning_states')).rows[0]
   assert.equal(invalidated.version,latest.version+1);assert.equal(invalidated.status,'invalidated');assert.equal(invalidated.invalidated_reason,'responses_incompatible');assert.equal(invalidated.encrypted_payload,'')
   assert.equal((await db.query('SELECT count(*)::int AS n FROM gugu_agent_active_reasoning WHERE run_id=$1',[target.id.runId])).rows[0].n,1,'清内存前失效时保留精确active供失败CAS续存')
   target.runtime.finishRun(target.id)
   await targetStore.commit({identity:target.id,lease,expectedVersion:0,checkpoint:{...initial,version:1,status:'failed',phase:'idle'},events:[],interactionReceipt:null,
    history:{outcome:'interruption',context:target.context,text:''}})
   assert.equal((await db.query('SELECT count(*)::int AS n FROM gugu_agent_active_reasoning WHERE run_id=$1',[target.id.runId])).rows[0].n,0)
   await publish('invalidation-database-fault-seed')
   const faulty=await instance('invalidation-database-fault'),before=(await db.query('SELECT version,encrypted_payload FROM provider_reasoning_states')).rows[0]
   await db.query("CREATE FUNCTION reject_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic-private-sql-token';END$$;CREATE TRIGGER reject_invalidation BEFORE UPDATE ON provider_reasoning_states FOR EACH ROW EXECUTE FUNCTION reject_invalidation()")
   await assert.rejects(faulty.persistence.invalidate(faulty.context,signal()),error=>error instanceof AgentReasoningUnavailableError&&!error.message.includes('synthetic-private')&&!('cause'in error))
   await db.query('DROP TRIGGER reject_invalidation ON provider_reasoning_states;DROP FUNCTION reject_invalidation()')
   await db.query('UPDATE users SET is_active=false WHERE id=$1',[owner]);await assert.rejects(faulty.persistence.invalidate(faulty.context,signal()),AgentReasoningUnavailableError)
   await db.query('UPDATE users SET is_active=true WHERE id=$1',[owner])
   assert.deepEqual((await db.query('SELECT version,encrypted_payload FROM provider_reasoning_states')).rows[0],before)
  })
  await t.test('Anthropic/OpenAI/Ollama活动私有值在off与continuation下精确重启；仅Anthropic发布Python同形跨Run状态',async()=>{
   for(const format of ['anthropic','openai','ollama'] as const)for(const mode of ['off','continuation'] as const){
    await db.query('DELETE FROM provider_reasoning_states WHERE user_id=$1 AND session_id=1',[owner])
    const id={...identity,runId:`synthetic-${format}-${mode}`},ctx=await context(id),first=provider()
    const trusted={...binding(id),identity:{...binding(id).identity,provider:format,apiFormat:format}}
    let persistence=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:first,binding:trusted,mode,authorize})
    assert.equal(await persistence.initialize(ctx,signal(),ctx.prepared.area.digest),null)
    const signature='synthetic-private-signature',thinking={type:'thinking',thinking:'合成私有推理',signature,_block_position:1}
    const payload={history_thinking_by_tool_id:{'synthetic-tool':[thinking]},tail_blocks:[{type:'redacted_thinking',data:'synthetic-private-redacted'}],
     history_response_blocks_by_tool_id:{'synthetic-tool':[{type:'text',text:'合成片段'},thinking,{type:'tool_use',id:'synthetic-tool',name:'synthetic',input:{ratio:0.25}}]},
     tail_response_blocks:[{type:'text',text:'合成最终答复'}]}
    const value=format==='anthropic'?{state_kind:'anthropic_thinking_blocks',model_identity:ctx.modelIdentity,owner_id:owner,session_id:'1',access_scope_hash:'scope',provider:format,payload}
     :format==='openai'?{kind:'openai',reasoningByCall:{'synthetic-tool':signature}}
      :{protocol:'ollama',thinkingByToolCallId:{'synthetic-tool':signature},assistant:{role:'assistant',content:'合成答复',thinking:signature,tool_calls:[]}}
    const ref=await first.stageContinuation({identity:id,modelIdentity:ctx.modelIdentity,accessScopeHash:ctx.accessScopeHash,round:1,areaDigest:ctx.prepared.area.digest,value})
    const active={...ctx,continuationRef:ref}
    await db.query('UPDATE agent_run_leases SET run_id=$1 WHERE user_id=$2 AND session_id=1',[id.runId,owner])
    const targetStore=createPostgresAgentRunStore<CanonicalRunContext>(db,'synthetic-checkpoint-secret',{
     persistPrivateContext:(...args)=>persistence.checkpointHook(...args),async writeHistory(client,_id,history){if(history.context)await persistence.commitSuccess(client,history.context)}})
    await targetStore.create({...checkpoint(0,active),identity:id},lease,[])
    const encrypted=(await db.query('SELECT payload FROM gugu_agent_active_reasoning WHERE user_id=$1 AND run_id=$2',[owner,id.runId])).rows[0].payload
    assert.equal(encrypted.includes(Buffer.from(signature)),false)
    await first.close()
    const restarted=provider()
    persistence=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:restarted,binding:trusted,mode,authorize})
    await persistence.ensure(active,signal())
    assert.deepEqual((await restarted.withStagedContinuation(active,async item=>item)).value,value,'活动值保留所有原块，包括非整数工具参数')
    const wrong={...trusted,identity:{...trusted.identity,apiFormat:format==='anthropic'?'openai':'anthropic'}}
    const mismatched=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:restarted,binding:wrong,mode,authorize})
    await assert.rejects(mismatched.ensure(active,signal()),AgentReasoningUnavailableError)
    await targetStore.commit({identity:id,lease,expectedVersion:0,checkpoint:{...checkpoint(1,active),identity:id,status:'completed',phase:'idle'},events:[],interactionReceipt:null,
     history:{outcome:'success',context:active,text:'合成最终答复'}})
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gugu_agent_active_reasoning WHERE user_id=$1 AND run_id=$2',[owner,id.runId])).rows[0].n,0)
    const published=(await db.query('SELECT * FROM provider_reasoning_states WHERE user_id=$1 AND session_id=1',[owner])).rows
    assert.equal(published.length,format==='anthropic'&&mode==='continuation'?1:0)
    if(format==='anthropic'&&mode==='continuation'){
     assert.equal(published[0].state_kind,'anthropic_thinking_blocks')
     assert.equal(JSON.stringify(published).includes(signature),false)
     const next={...id,runId:'synthetic-anthropic-next'},nextCtx={...await context(next),modelIdentity:'next-selection'},nextRuntime=provider()
     const nextBinding={...trusted,runId:next.runId,modelIdentity:nextCtx.modelIdentity}
     const nextPersistence=createProviderReasoningPersistence({pool:db,secretKey:'synthetic-reasoning-secret',provider:nextRuntime,binding:nextBinding,mode,authorize})
     const nextRef=await nextPersistence.initialize(nextCtx,signal(),nextCtx.prepared.area.digest)
     assert.ok(nextRef)
     const staged=await nextRuntime.withStagedContinuation({...nextCtx,continuationRef:nextRef},async item=>item)
     assert.equal(staged.round,0)
     assert.deepEqual(staged.value,{state_kind:'anthropic_thinking_blocks',model_identity:'next-selection',owner_id:owner,session_id:'1',access_scope_hash:'scope',provider:'anthropic',
      payload:{history_thinking_by_tool_id:payload.history_thinking_by_tool_id,tail_blocks:payload.tail_blocks}})
    }
   }
  })
 }finally{for(const runtime of runtimes)await runtime.close();await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
})
