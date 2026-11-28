import { imReflectionSql } from '@gugu/database/postgres/migrations/0014_im_reflection'
import assert from 'node:assert/strict'
import { createHash,randomUUID } from 'node:crypto'
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Pool,PoolClient } from 'pg'
import { stableJson,type CanonicalContextPorts,type RunIdentity } from '@gugu/core/agent'
import { ProviderRuntime,ProviderStreamSanitizer,stripThinking,type ProviderRuntimeOptions } from '@gugu/core/providers'
import { removeLocalTree } from '@gugu/fs/node'
import { createPersistentAgentRuntimeWithContextFactory } from '../../../../src/modules/agent/run/runtime.js'
import { createCanonicalHistoryWriter } from '../../../../src/modules/agent/chat/write.js'
import { enqueueAgentRunLocked } from '../../../../src/modules/agent/run/dispatch.js'
import { createRedisAgentCancellationCommands } from '../../../../src/adapters/cache/redis-events.js'
import { createRedisLiveSubscription } from '../../../../src/adapters/cache/redis-live-subscription.js'
import { createImReflectionService } from '../../../../src/modules/im/gateway/memory/jobs.js'
import type { ImReflectionServiceOptions } from '../../../../src/modules/im/gateway/memory/contracts.js'
import { createImInboundEnvelope } from '../../../../src/modules/im/gateway/inbound/envelope.js'
import {createImReflectionCodec} from '../../../../src/modules/im/gateway/memory/codec.js'
import type {ImReflectionJob} from '../../../../src/modules/im/gateway/memory/contracts.js'
import { context as sourceContext } from '../run-sender.fixtures.js'
import { imConversationScopeHash,imConversationDigest,imConversationFingerprint } from '../../../../src/modules/im/gateway/agent/identity.js'

const pgUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL
const digest=(v:unknown)=>createHash('sha256').update(stableJson(v)).digest('hex')
test('真实PG/Redis/Linux FS：Canonical成功事务登记→独立Provider反思→本地幂等计划、租约恢复、墓碑和当前权限',{
  skip:!(pgUrl&&redisUrl)&&'未运行：需显式隔离PG/Redis；真实FS写须Linux Node，不能用替身或skip宣称完成',timeout:120000,
},async t=>{
  const{Pool}=await import('pg'),admin=new Pool({connectionString:pgUrl}),schema=`im_reflect_${randomUUID().replaceAll('-','')}`
  const root=await mkdtemp(join(tmpdir(),'gugu-reflection-')),owner=randomUUID(),secret='synthetic-reflection-secret'
  let pool:Pool|undefined,service:ReturnType<typeof createImReflectionService>|undefined
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:pgUrl,options:`-c search_path=${schema} -c lock_timeout=2000 -c statement_timeout=10000`,max:12})
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text,token_limit_6h integer,quota_window_started_at timestamptz);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean,owner_platform_user_id text,group_allowed_tools json,
        group_owner_memory_enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean,group_memory_enabled boolean,member_memory_enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id varchar(128),chat_type text,chat_id text,
        execution_state text DEFAULT 'idle',active_run_id text,pending_message_count integer DEFAULT 0,last_message_seq bigint DEFAULT 1,session_context jsonb,
        context_epoch integer DEFAULT 0,snapshot_hash text,session_info_hash text,snapshot_expires_at timestamptz,baseline_message_seq integer DEFAULT 0,baseline_message_hash text);
      CREATE TABLE conversation_batches(id bigserial PRIMARY KEY,session_id integer,version text,run_id text,round_id text,digest text,created_at timestamptz,UNIQUE(session_id,digest));
      CREATE TABLE conversation_messages(id serial PRIMARY KEY,session_id integer,conversation_seq bigint,history_anchor_seq bigint,role text,content text,content_json jsonb,
        canonical_batch_id bigint,run_id text,round_id text,created_at timestamptz,sent_at timestamptz,im_platform_sent_ms bigint,im_event_received_ms bigint,
        files jsonb,display_timeline jsonb,run_outcome jsonb,covers_until_seq bigint,platform_user_id text,platform_user_name text,quoted_text text,
        im_reply_to_message_id text,chat_type text,im_platform_message_id text);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,message_id integer,run_id text,state text,platform text,bot_id text,chat_type text,
        scope_hash text,event_hash text,fingerprint text,sealed_payload jsonb);
      CREATE TABLE agent_run_dispatch(sequence bigserial,user_id uuid,session_id integer,run_id text,state text,nonce bytea,payload bytea,request_expires_at timestamptz,message_id integer,UNIQUE(user_id,session_id,run_id));
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,token text,fence bigint,expires_at timestamptz,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id));
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,version bigint,sequence bigint,status text,phase text,nonce bytea,payload bytea,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_events(user_id uuid,session_id integer,run_id text,event_id text,sequence bigint,nonce bytea,payload bytea,created_at timestamptz,acknowledged_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,event_id),UNIQUE(user_id,session_id,run_id,sequence));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text,created_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,receipt));
      CREATE TABLE memory_reflection_cursors(id serial PRIMARY KEY,owner_user_id uuid,platform text,bot_id varchar(128),scope_type text,scope_id text,scope_version integer,
        last_reflected_message_id integer,pending_passive_count integer,pending_agent_count integer,created_at timestamptz,updated_at timestamptz,
        UNIQUE(owner_user_id,platform,bot_id,scope_type,scope_id));
      CREATE TABLE web_reflection_intervals(session_id integer PRIMARY KEY,user_id uuid,observed_through bigint,
        completed_through bigint DEFAULT 0,idle_due_at timestamptz, frozen jsonb DEFAULT '[]',
        lease_token uuid,lease_until timestamptz,retry_at timestamptz,CHECK(completed_through<=observed_through));
      CREATE TABLE memory_scope_tombstones(owner_user_id uuid,platform text,bot_id varchar(128),scope_type text,scope_id text);
      CREATE TABLE knowledge_index_entries(owner_user_id uuid,source_type text,deleted_at timestamptz,indexed_at timestamptz);
      CREATE TABLE rag_index_jobs(id bigserial PRIMARY KEY,user_id uuid,source_type text,source_id text,version text,operation text,status text,generation integer,
        completed_generation integer,attempts integer,next_attempt_at timestamptz,lease_until timestamptz,last_started_at timestamptz,last_succeeded_at timestamptz,last_error_code text,
        pending_source_ids json,created_at timestamptz,updated_at timestamptz,UNIQUE(user_id,source_type));
      CREATE TABLE agent_usage(user_id uuid,session_id integer,tokens_in integer,tokens_out integer,cache_read integer,cache_write integer,cache_round_stats jsonb,
        model text,provider text,is_byok boolean,tools_used jsonb,scenario text,input_source text,created_at timestamptz)`)
    await pool.query(imReflectionSql.reflection)
    await pool.query(imReflectionSql.reflectionTrigger)
    await pool.query("INSERT INTO users(id,is_active,account_status) VALUES($1,true,'active');",[owner])
    await pool.query("INSERT INTO user_bots VALUES(91,$1,'telegram',true,'202','[]',false,true,NULL,true,true)",[owner])
    const db=pool,envelope=createImInboundEnvelope(secret),diagnostics:string[]=[]
    let mainCalls=0,reflectionCalls=0,releases=0,reflectionFail=false,historyFail=false,clearBeforeHistory=false
    const references:CanonicalContextPorts['references']={dehydrate:async entry=>entry.message,hydrate:async entry=>entry.message}
    const prepareRequest:CanonicalContextPorts['prepareRequest']=async()=>({prefix:[],dynamicTail:[]})
    const providerOptions:ProviderRuntimeOptions={digest,nextId:randomUUID,references,prepareRequest,
      async resolve(){return{modelIdentity:'model',accessScopeHash:'scope',config:{provider:'openai',model:'synthetic'},systemPrompt:'合成系统'}},
      transport:{async request(request){
        const body=request.body as Record<string,unknown>,stream=body.stream===true
        if(stream)mainCalls++;else reflectionCalls++
        if(!stream)assert.equal((JSON.stringify(body).match(/synthetic inbound/gu)??[]).length,1,'反思delta不能重复主请求已有用户正文')
        if(!stream&&reflectionFail)return{status:400,headers:{},body:(async function*(){yield Buffer.from('{"error":{"message":"synthetic-provider-private"}}')})(),cancel(){}}
        const output={profile_add:[{type:'preference',text:'喜欢清茶'}],summary:'筹备合成展览',daily:'合成展览已完成'}
        const raw=stream?'data: {"choices":[{"delta":{"content":"合成可见回复"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3}})
        return{status:200,headers:{},body:(async function*(){yield Buffer.from(raw)})(),cancel(){}}
      }}}
    const options:ImReflectionServiceOptions={pool:db,secretKey:secret,storageRoot:root,supportedPlatforms:()=>['telegram','qq'],
      async readRoute(id){const r=(await db.query('SELECT sealed_payload,platform FROM gugu_im_inbound_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3 LIMIT 1',[id.ownerId,id.sessionId,id.runId])).rows[0]
        return r?{binding:{ownerId:id.ownerId,botId:'91',platform:r.platform},payload:envelope.open({ownerId:id.ownerId,botId:'91',platform:r.platform},r.sealed_payload)}:null},
      async readRouteLocked(client,id){
        // 实际同事务锁读取；canonical writer已持有s行，另借连接会触发本测试的lock_timeout。
        const r=(await client.query(`SELECT r.sealed_payload,r.platform FROM gugu_im_inbound_receipts r JOIN conversation_sessions s ON s.id=r.session_id AND s.user_id=r.user_id
          WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 LIMIT 1 FOR UPDATE OF s,r`,[id.ownerId,id.sessionId,id.runId])).rows[0]
        return r?{binding:{ownerId:id.ownerId,botId:'91',platform:r.platform},payload:envelope.open({ownerId:id.ownerId,botId:'91',platform:r.platform},r.sealed_payload)}:null},
      async memoryEnabled(){return true},
      async resolveRuntime(job,_signal,authorizeCurrent){const provider=new ProviderRuntime({...providerOptions,transport:{async request(request,signal){assert.equal(await authorizeCurrent(),true);return providerOptions.transport!.request(request,signal)}}});return{provider,selection:{modelIdentity:job.modelIdentity,accessScopeHash:job.accessScopeHash,contextWindow:8000},
        usageConfig:{defaultLimit6h:null,byokEnabled:false,localDeployment:false,model:'synthetic',provider:'openai',isByok:false},async release(){releases++;await provider.close()}}},
      diagnose:code=>diagnostics.push(code),leaseMs:1000,pollMs:10}
    service=createImReflectionService(options)
    async function run(session:number,group=false,sender='202',platform:'telegram'|'qq'='telegram'){
      const identity:RunIdentity={ownerId:owner,sessionId:String(session),runId:randomUUID()},base=sourceContext(platform)
      const src={...base,secretKey:secret,identity,scope:{...base.scope,ownerId:owner,platformUserId:sender,chatType:group?'group' as const:'c2c' as const,chatId:group?'synthetic-group':null},
        payload:{...base.payload,owner_user_id:owner,platform_user_id:sender,chat_type:group?'group' as const:'c2c' as const,chat_id:group?'synthetic-group':null,message_id:String(session*100+31),platform_message_id:String(session*100+31)}}
      const binding={ownerId:owner,platform:src.scope.platform,botId:src.scope.botId},scopeHash=imConversationScopeHash(secret,binding,src.payload)
      const receipt={scope_hash:scopeHash,event_hash:imConversationDigest(secret,[scopeHash,src.scope.platformUserId,src.payload.message_id]),
        fingerprint:imConversationFingerprint(secret,scopeHash,src.payload,[]),sealed_payload:envelope.seal(binding,src.payload)}
      await db.query("INSERT INTO conversation_sessions(id,user_id,source,bot_id,chat_type,chat_id) VALUES($1,$2,$5,'91',$3,$4)",[session,owner,src.scope.chatType,src.scope.chatId,platform])
      const anchor=(await db.query("INSERT INTO conversation_messages(session_id,conversation_seq,role,content,platform_user_id,chat_type,im_platform_message_id,run_id,created_at,sent_at) VALUES($1,1,'user',$2,$6,$3,$4,$5,clock_timestamp(),clock_timestamp()) RETURNING id::text",[session,src.payload.text,src.scope.chatType,src.payload.message_id,identity.runId,sender])).rows[0].id as string
      await db.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,$2,$3,$4,'dispatched',$10,'91',$5,$6,$7,$8,$9)",[owner,session,anchor,identity.runId,src.scope.chatType,receipt.scope_hash,receipt.event_hash,receipt.fingerprint,receipt.sealed_payload,platform])
      const client=await db.connect();try{await client.query('BEGIN');await enqueueAgentRunLocked(client,secret,identity,{v:3,source:'im',userMessageId:Number(anchor),locale:null,origin:null,accessVersion:'a'.repeat(64),im:{platform,botId:'91',chatType:src.scope.chatType,chatId:src.scope.chatId,platformUserId:sender}},600);await client.query('COMMIT')}finally{client.release()}
      let usageClient:PoolClient|null=null
      const currentService=service!,writer=createCanonicalHistoryWriter(async(_id,_model,client)=>{usageClient=client;return{defaultLimit6h:null,byokEnabled:false,localDeployment:false,model:'synthetic',provider:'openai',isByok:false}},{
        async usageSource(id,client){assert.equal(client,usageClient);await client.query('SELECT 1 FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE',[id.ownerId,id.sessionId]);return'telegram'},
        async afterSuccess(...args){if(clearBeforeHistory){clearBeforeHistory=false;await currentService.clearOwner(owner,()=>removeLocalTree(root,`${owner}/.agent`))}
          await currentService.historyHook(...args);if(historyFail)throw Error('合成history收尾失败')},
      })
      const context:CanonicalContextPorts={digest,nextId:randomUUID,references,prepareRequest,
        async load(id){return{modelIdentity:'model',contextWindow:8000,input:{...id,fixedPrefix:[],history:[],historyBaseline:{baselineSeq:0,baselineHash:null,snapshotHash:null},currentUser:{persistedMessageId:anchor,message:{role:'user',content:src.payload.text}},preparedRag:{tail:[]}},
          accessScopeHash:'scope',capabilities:{toolNames:[],tools:[]},sourceEffects:{sessionSnapshot:{expectedEpoch:0,expectedSnapshotHash:null,phase:'rebuild',state:{ownerId:owner,sessionId:id.sessionId,contextEpoch:1,context:{access_scope_hash:'scope'},snapshotHash:'snapshot',sessionInfoHash:null,snapshotExpiresAt:null,baselineMessageSeq:0}}}} as never},
        preparation:{buildRag:async()=>({tail:[]})},compaction:{async summarize(){throw Error('不应意外压缩')}},
        finalization:{async complete(){throw Error('工厂必须替换finalizer')}},currentRequest:()=>null,
        async stageContinuation(){throw Error('无推理状态')},async releaseContinuations(){},diagnoseCompactionFailure(){}}
      const runtime=await createPersistentAgentRuntimeWithContextFactory({pool:db,secretKey:secret,redis:createRedisAgentCancellationCommands(redisUrl!),subscribe:createRedisLiveSubscription(redisUrl!),scheduling:{mode:'direct'},history:{writeHistory:writer},
        context:{services:{digest,nextId:randomUUID,references,prepareRequest},async createContext(provider){return{...context,finalization:await currentService.createFinalizer({identity,modelIdentity:'model',provider})}}},
        provider:providerOptions,executor:{async authorize(){throw Error('不应授权进程')},executor:{async execute(){throw Error('不应执行进程')}}},
        runtime:{clock:{now:()=>new Date().toISOString()},tools:{async dispatch(){throw Error('无工具')},async reconcile(){return{kind:'unknown'}}},interactions:{async activate(_id,r){return r}},
          sanitizeText:stripThinking,createStreamSanitizer:()=>new ProviderStreamSanitizer(),presentError:()=>({code:'failed',text:'合成错误'}),presentToolResult:async v=>v,async publish(){},diagnose(){}}})
      try{assert.equal(await runtime.startup.register(identity),true)
        if(historyFail)await assert.rejects(async()=>{for await(const _event of runtime.harness.start(identity)){}},error=>error instanceof Error&&'code'in error&&error.code==='persistence_unknown')
        else for await(const _event of runtime.harness.start(identity)){}
        const checkpoint=await runtime.store.read(identity)
        await db.query("UPDATE agent_run_dispatch SET state='done' WHERE user_id=$1 AND session_id=$2 AND run_id=$3",[owner,session,identity.runId])
        return{identity,checkpoint}
      }finally{await runtime.close()}
    }
    const due = async (session: number | null = null) => {
      await db.query("UPDATE web_reflection_intervals SET retry_at=clock_timestamp() WHERE retry_at IS NOT NULL AND ($1::integer IS NULL OR session_id=$1)", [session])
      await db.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp() WHERE state IN ('pending','ready','retry','deferred') AND ($1::integer IS NULL OR session_id=$1)", [session])
    }
    await t.test('成功历史登记后独立 Provider 能写入授权范围',async()=>{
      const before=(await db.query('SELECT clock_timestamp() AS at')).rows[0].at as Date
      const first=await run(1);assert.equal(first.checkpoint?.status,'completed')
      const pending=(await db.query('SELECT state,next_attempt_at,clock_timestamp() AS at FROM gugu_im_reflection_jobs WHERE session_id=1')).rows[0]
      assert.equal(pending.state,'ready')
      const shared = await db.query(`SELECT i.observed_through,i.completed_through,i.idle_due_at=j.next_attempt_at AS same_deadline
        FROM web_reflection_intervals i JOIN gugu_im_reflection_jobs j ON j.session_id=i.session_id AND j.user_id=i.user_id
        WHERE i.session_id=1`)
      assert.deepEqual(shared.rows[0], { observed_through: '1', completed_through: '0', same_deadline: true })
      assert.ok(pending.next_attempt_at.getTime()>=before.getTime()+180000)
      assert.ok(pending.next_attempt_at.getTime()<=pending.at.getTime()+180001,'成功Run应使用180秒闲置窗口，不能混用240秒busy重试')
      assert.equal(await service!.runOnce(),false,'未到闲置期限不调用反思Provider')
      const userIds = (await db.query("SELECT id::text FROM conversation_messages WHERE session_id=1 AND role='user'")).rows.map(row => row.id)
      assert.ok(userIds.length > 0)
      const transaction = await db.connect()
      try {
        await transaction.query('BEGIN')
        await service!.stageCompaction!(transaction, first.identity, ['0'])
        const unrelated = await transaction.query('SELECT next_attempt_at FROM gugu_im_reflection_jobs WHERE session_id=1')
        assert.deepEqual(unrelated.rows[0].next_attempt_at, pending.next_attempt_at)
        await service!.stageCompaction!(transaction, first.identity, userIds)
        const staged = await transaction.query('SELECT next_attempt_at<=clock_timestamp() AS due FROM gugu_im_reflection_jobs WHERE session_id=1')
        assert.equal(staged.rows[0].due,true)
        await transaction.query('ROLLBACK')
        assert.equal(await service!.runOnce(),false,'压缩回滚后仍等待原闲置期限')
        await transaction.query('BEGIN')
        await service!.stageCompaction!(transaction, first.identity, userIds)
        await transaction.query('COMMIT')
      } finally {
        transaction.release()
      }
      assert.equal(await service!.runOnce(),true)
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=1')).rows[0].state,'completed')
      assert.deepEqual(JSON.parse(await readFile(join(root,owner,'.agent', 'memories','summary.json'),'utf8')).text,'筹备合成展览')
      assert.equal(mainCalls,1);assert.equal(reflectionCalls,1);assert.equal(releases,1)
      assert.deepEqual((await db.query("SELECT tokens_in,tokens_out,input_source FROM agent_usage WHERE scenario='reflection'")).rows,[{tokens_in:4,tokens_out:3,input_source:'telegram'}])
      assert.deepEqual((await db.query("SELECT tokens_in,tokens_out,input_source FROM agent_usage WHERE scenario='chat' AND session_id=1")).rows,[{tokens_in:3,tokens_out:2,input_source:'telegram'}])
      assert.equal((await db.query("SELECT status FROM rag_index_jobs WHERE source_type='memory'")).rows[0].status,'queued')
      assert.doesNotMatch(JSON.stringify((await db.query('SELECT payload,plan_payload FROM gugu_im_reflection_jobs')).rows),/喜欢清茶|筹备合成展览|synthetic inbound/u)
    })
    await t.test('history事务失败回滚Job和助手消息，不把notify当作登记',async()=>{
      historyFail=true;const failed=await run(2);historyFail=false
      assert.notEqual(failed.checkpoint?.status,'completed')
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM gugu_im_reflection_jobs WHERE session_id=2')).rows[0].n,0)
      assert.equal((await db.query("SELECT count(*)::integer AS n FROM conversation_messages WHERE session_id=2 AND role='assistant'")).rows[0].n,0)
    })
    await t.test('真实文件已写但cursor事务失败：重启读取同密文计划，不再调用Provider或重复daily',async()=>{
      await run(3)
      await db.query("CREATE FUNCTION reject_cursor() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.scope_id='3' THEN RAISE EXCEPTION 'synthetic-private-cursor';END IF;RETURN NEW;END$$;CREATE TRIGGER reject_cursor BEFORE UPDATE ON memory_reflection_cursors FOR EACH ROW EXECUTE FUNCTION reject_cursor()")
      await due();await service!.runOnce();const calls=reflectionCalls,body=await readFile(join(root,owner,'.agent', 'memories','daily.md'),'utf8')
      const usage=(await db.query("SELECT count(*)::integer AS n FROM agent_usage WHERE scenario='reflection' AND session_id=3")).rows[0].n
      const usageCount=Number((await db.query("SELECT count(*) AS n FROM agent_usage WHERE scenario='reflection'")).rows[0].n)
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=3')).rows[0].state,'retry')
      const frozen = (await db.query('SELECT completed_through,frozen,lease_token,retry_at FROM web_reflection_intervals WHERE session_id=3')).rows[0]
      assert.equal(frozen.completed_through, '0')
      assert.equal(frozen.frozen[0].through, 1)
      assert.equal(frozen.lease_token, null)
      assert.ok(frozen.retry_at)
      await db.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp() WHERE session_id=3")
      assert.equal(await service!.runOnce(), false, '账本重试期限未到时不能提前重领')
      await db.query('DROP TRIGGER reject_cursor ON memory_reflection_cursors');await service!.stop();service=createImReflectionService(options)
      await due();await service.runOnce();assert.equal(reflectionCalls,calls);assert.equal(await readFile(join(root,owner,'.agent', 'memories','daily.md'),'utf8'),body)
      assert.equal((await db.query("SELECT count(*)::integer AS n FROM agent_usage WHERE scenario='reflection' AND session_id=3")).rows[0].n,usage)
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM agent_usage WHERE scenario='reflection'")).rows[0].n),usageCount)
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=3')).rows[0].state,'completed')
      assert.deepEqual((await db.query('SELECT completed_through,frozen,retry_at FROM web_reflection_intervals WHERE session_id=3')).rows[0],
        { completed_through: '1', frozen: [], retry_at: null })
    })
    await t.test('未完成文件计划先恢复，同owner后续任务不提前调用Provider或改写其恢复前提',async()=>{
      await run(15)
      await db.query("CREATE FUNCTION reject_plan_cursor() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.scope_id='15' THEN RAISE EXCEPTION 'synthetic-plan-cursor-failure';END IF;RETURN NEW;END$$;CREATE TRIGGER reject_plan_cursor BEFORE UPDATE ON memory_reflection_cursors FOR EACH ROW EXECUTE FUNCTION reject_plan_cursor()")
      await due(15);await service!.runOnce()
      const planned=(await db.query('SELECT state,plan_payload FROM gugu_im_reflection_jobs WHERE session_id=15')).rows[0]
      assert.equal(planned.state,'retry');assert.ok(planned.plan_payload)
      await db.query('DROP TRIGGER reject_plan_cursor ON memory_reflection_cursors;DROP FUNCTION reject_plan_cursor()')
      await run(16);await due(16);const calls=reflectionCalls
      await service!.runOnce();assert.equal(reflectionCalls,calls,'旧计划未恢复时不能发送新反思请求')
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=16')).rows[0].state,'deferred')
      await due(15);await service!.runOnce();assert.equal(reflectionCalls,calls,'恢复已有计划不重发Provider')
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=15')).rows[0].state,'completed')
      await due(16);await service!.runOnce();assert.equal(reflectionCalls,calls+1)
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=16')).rows[0].state,'completed')
    })
    await t.test('清除围栏和当前owner解绑阻止旧Job重新生成记忆，群任务重启后仍能执行',async()=>{
      await run(4);await service!.clearOwner(owner,()=>removeLocalTree(root,`${owner}/.agent`))
      await db.query("UPDATE gugu_im_reflection_jobs SET state='ready',next_attempt_at=clock_timestamp() WHERE session_id=4")
      const calls=reflectionCalls;await service!.runOnce();assert.equal(reflectionCalls,calls)
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=4')).rows[0].state,'cancelled')
      await run(5);await db.query("UPDATE user_bots SET owner_platform_user_id='other-synthetic-owner'");await due();await service!.runOnce()
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=5')).rows[0].state,'cancelled')
      await db.query("UPDATE user_bots SET owner_platform_user_id='202'")
      const {identity:groupIdentity}=await run(6,true)
      const tx=await db.connect()
      try{
        await tx.query('BEGIN')
        const {rows:[anchor]}=await tx.query("SELECT id::text,conversation_seq::text FROM conversation_messages WHERE session_id=6 AND role='user'")
        await service!.stageCompaction!(tx,groupIdentity,[anchor.id])
        await service!.stageCompaction!(tx,groupIdentity,[anchor.id])
        const windows=await tx.query("SELECT through_message_seq::text FROM gugu_im_reflection_trigger_windows WHERE session_id=6 AND status='pending'")
        assert.deepEqual(windows.rows,[{through_message_seq:anchor.conversation_seq}])
      }finally{await tx.query('ROLLBACK');tx.release()}
      assert.equal((await db.query('SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE session_id=6')).rowCount,0)
      await service!.stop();service=createImReflectionService(options);await due()
      const pendingGroupJobs=(await db.query('SELECT id FROM gugu_im_reflection_jobs WHERE session_id=6')).rows
      for(const _job of pendingGroupJobs)await service.runOnce()
      const group=(await db.query('SELECT state,attempts,next_attempt_at,clock_timestamp() AS at FROM gugu_im_reflection_jobs WHERE session_id=6')).rows
      assert.ok(group.every(job=>job.state==='completed'))
      assert.equal(reflectionCalls,calls+group.length)
    })
    await t.test('第五次实际Provider拒绝成为dead且不写用量；失联running租约由新attempt安全接管',async()=>{
      await run(7);await db.query("UPDATE gugu_im_reflection_jobs SET attempts=4,next_attempt_at=clock_timestamp() WHERE session_id=7")
      reflectionFail=true;await service!.runOnce();reflectionFail=false
      const dead=(await db.query('SELECT state,attempts FROM gugu_im_reflection_jobs WHERE session_id=7')).rows[0]
      assert.equal(dead.state,'dead');assert.equal(dead.attempts,5);assert.ok(diagnostics.includes('reflection_dead'))
      assert.equal((await db.query("SELECT count(*)::integer AS n FROM agent_usage WHERE scenario='reflection' AND session_id=7")).rows[0].n,0)
      await run(8);await db.query("UPDATE gugu_im_reflection_jobs SET state='running',attempts=1,token=$1,lease_until=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp() WHERE session_id=8",[randomUUID()])
      await service!.runOnce()
      const recovered=(await db.query('SELECT state,attempts FROM gugu_im_reflection_jobs WHERE session_id=8')).rows[0]
      assert.equal(recovered.state,'completed');assert.equal(recovered.attempts,2)
    })
    await t.test('同owner两个Job不并发调用Provider；失去owner锁的attempt仅defer不扣重试预算',async()=>{
      await run(9);await run(10);await due(9);await due(10)
      let entered!:()=>void,release!:()=>void
      const started=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve}),original=options.resolveRuntime
      options.resolveRuntime=async(job,signal,authorizeCurrent)=>{if(job.identity.sessionId==='9'){entered();await gate}return original(job,signal,authorizeCurrent)}
      const first=service!.runOnce();await Promise.race([started,first.then(()=>{throw Error('未选中预期Job9')})])
      const otherService=createImReflectionService(options)
      try{await otherService.runOnce();const waiting=(await db.query('SELECT state,attempts FROM gugu_im_reflection_jobs WHERE session_id=10')).rows[0]
        assert.equal(waiting.state,'deferred');assert.equal(waiting.attempts,0)
      }finally{release();await first;await otherService.stop();options.resolveRuntime=original}
    })
    await t.test('服务重启后只用持久化证据完成反思',async()=>{
      await run(11)
      await service!.stop();service=createImReflectionService(options)
      const calls=reflectionCalls
      await due(11);await service.runOnce()
      assert.equal(reflectionCalls,calls+1)
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=11')).rows[0].state,'completed')
    })
    await t.test('清除revision后才完成的旧Run不以新revision重建idle窗口，下一真实新Run正常arm',async()=>{
      clearBeforeHistory=true;const old=await run(12,true)
      assert.equal(old.checkpoint?.status,'completed','记忆清除不能伪造主Run失败')
      assert.equal((await db.query('SELECT 1 FROM gugu_im_reflection_trigger_states WHERE user_id=$1 AND session_id=12 AND last_active_run_id IS NOT NULL',[owner])).rowCount,0)
      assert.equal((await db.query('SELECT 1 FROM gugu_im_reflection_jobs WHERE user_id=$1 AND session_id=12',[owner])).rowCount,0)
      const fresh=await run(13,true)
      assert.equal(fresh.checkpoint?.status,'completed')
      const state=(await db.query('SELECT last_active_run_id,owner_revision::text,idle_due_at FROM gugu_im_reflection_trigger_states WHERE user_id=$1 AND session_id=13',[owner])).rows[0]
      assert.equal(state.last_active_run_id,fresh.identity.runId)
      assert.equal(state.owner_revision,(await db.query('SELECT revision::text FROM gugu_im_reflection_owner_revisions WHERE user_id=$1',[owner])).rows[0].revision)
      assert.ok(state.idle_due_at instanceof Date)
    })
    await t.test('旧scope任务不能跨过Admin版本再借最新Node进度恢复，未发Provider也不重学旧事实',async()=>{
      const actual=await run(14,true),codec=createImReflectionCodec(secret)
      const rows=(await db.query('SELECT * FROM gugu_im_reflection_jobs WHERE session_id=14')).rows
      const selected=rows.map(row=>({row,job:codec.open(row,row.nonce,row.payload,'job') as ImReflectionJob&{throughMessageId:number;throughMessageSeq:number}})).find(item=>item.job.scope.type==='group')!
      assert.ok(selected)
      const base=sourceContext(),payload={...base.payload,owner_user_id:owner,chat_type:'group',chat_id:'synthetic-group',platform_user_id:'202',
        message_id:'1499',platform_message_id:'1499',text:'合成Admin围栏前旧事实'}
      const binding={ownerId:owner,platform:'telegram' as const,botId:'91'},scope=imConversationScopeHash(secret,binding,payload)
      const tail=(await db.query(`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,run_id,chat_type,platform_user_id,platform_user_name,
        quoted_text,im_platform_message_id,created_at) VALUES(14,3,'user',$1,NULL,'group','202',$2,$3,'1499',clock_timestamp()) RETURNING id`,
        [payload.text,null,null])).rows[0].id
      await db.query(`INSERT INTO gugu_im_inbound_receipts VALUES($1,14,$2,NULL,'passive','telegram','91','group',$3,$4,$5,$6)`,
        [owner,tail,scope,imConversationDigest(secret,[scope,'202','1499']),imConversationFingerprint(secret,scope,payload,[]),envelope.seal(binding,payload)])
      const job={...selected.job,throughMessageId:Number(tail),throughMessageSeq:3},sealed=codec.seal(job,job,'job')
      await db.query('UPDATE gugu_im_reflection_jobs SET nonce=$2,payload=$3,next_attempt_at=clock_timestamp() WHERE id=$1',[selected.row.id,sealed.nonce,sealed.payload])
      const old=Number(selected.row.scope_version),current=old+2
      // 模拟一次合法Admin版本推进，再加一个更早范围的Node提交；中间版本没有Node连续证明。
      await db.query(`UPDATE memory_reflection_cursors SET scope_version=$2 WHERE owner_user_id=$1 AND platform='telegram' AND bot_id='91' AND scope_type='group' AND scope_id='synthetic-group'`,[owner,current])
      const anchor=(await db.query("SELECT id FROM conversation_messages WHERE session_id=14 AND run_id=$1 AND role='user'",[actual.identity.runId])).rows[0].id
      await db.query(`INSERT INTO gugu_im_reflection_cursor_positions(user_id,session_id,scope_hash,scope_version,last_sequence,last_message_id)
        VALUES($1,14,$2,$3,1,$4)`,[owner,selected.row.scope_hash,current,anchor])
      const calls=reflectionCalls;await service!.runOnce()
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE id=$1',[selected.row.id])).rows[0].state,'cancelled')
      assert.equal(reflectionCalls,calls)
    })
    await t.test('同群scope的Node推进仅重绑本Session任务，另一Session缺连续证明必须取消且不发Provider',async()=>{
      await run(17,true);await run(18,true)
      const codec=createImReflectionCodec(secret)
      const pending=(await db.query('SELECT * FROM gugu_im_reflection_jobs WHERE session_id IN(17,18) ORDER BY session_id')).rows
        .map(row=>({row,job:codec.open(row,row.nonce,row.payload,'job') as ImReflectionJob}))
      const a=pending.find(item=>item.row.session_id===17&&item.job.scope.type==='group')!
      const b=pending.find(item=>item.row.session_id===18&&item.job.scope.type==='group')!
      assert.ok(a);assert.ok(b);assert.equal(a.row.scope_hash,b.row.scope_hash,'两Session确实复用同一Bot/群记忆scope')
      assert.equal(a.row.scope_version,b.row.scope_version);assert.ok(['ready','pending'].includes(a.row.state));assert.ok(['ready','pending'].includes(b.row.state))
      const oldVersion=Number(b.row.scope_version),before=reflectionCalls
      await due(17);assert.equal(await service!.runOnce(),true)
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE id=$1',[a.row.id])).rows[0].state,'completed')
      assert.equal(reflectionCalls,before+1,'A 使用持久证据独立完成反思')
      const retained=(await db.query('SELECT scope_version,state FROM gugu_im_reflection_jobs WHERE id=$1',[b.row.id])).rows[0]
      assert.equal(Number(retained.scope_version),oldVersion,'A提交不能批量推进B的scope版本，绕过B自己的Session围栏')
      assert.ok(['ready','pending'].includes(retained.state))
      assert.equal((await db.query(`SELECT 1 FROM gugu_im_reflection_cursor_positions WHERE user_id=$1 AND session_id=18
        AND scope_hash=$2 AND scope_version>$3`,[owner,b.row.scope_hash,oldVersion])).rowCount,0,'B没有任何可借用的本Session Node连续进度')
      await due(18);assert.equal(await service!.runOnce(),true)
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE id=$1',[b.row.id])).rows[0].state,'cancelled')
      assert.equal(reflectionCalls,before+1,'B不能借A的同群进度重新调用Provider或重学旧事实')
    })
    await t.test('关闭群私人记忆召回不禁止owner学习，成员来源仍等待有效 owner 授权而不吞掉idle窗口',async()=>{
      assert.equal((await db.query('SELECT group_owner_memory_enabled FROM user_bots WHERE id=91')).rows[0].group_owner_memory_enabled,false)
      const actual=await run(19,true);assert.equal(actual.checkpoint?.status,'completed')
      const armed=(await db.query('SELECT last_active_run_id,idle_due_at FROM gugu_im_reflection_trigger_states WHERE session_id=19')).rows[0]
      assert.equal(armed.last_active_run_id,actual.identity.runId);assert.ok(armed.idle_due_at)
      await db.query("UPDATE gugu_im_reflection_trigger_states SET idle_due_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND session_id=19",[owner])
      // 此组件此前只登记成功Run；显式装配同一真实配置读取端口，启动正式窗口扫描。
      const scanner=createImReflectionService({...options,passiveMemoryEnabled:async()=>true})
      try{await scanner.runOnce()}finally{await scanner.stop()}
      const windows=(await db.query('SELECT reason,status FROM gugu_im_reflection_trigger_windows WHERE user_id=$1 AND session_id=19',[owner])).rows
      assert.deepEqual(windows,[{reason:'idle',status:'pending'}],'私人召回开关不等同禁止学习；缺少有效 owner 授权来源时保留窗口')
      const codec=createImReflectionCodec(secret),rows=(await db.query('SELECT * FROM gugu_im_reflection_jobs WHERE session_id=19')).rows
      assert.ok(rows.length>0)
      assert.ok(rows.every(row=>(codec.open(row,row.nonce,row.payload,'job') as ImReflectionJob).actor.role==='member'),'本合成Run没有结构化owner mention，保持成员权限')
      assert.equal(rows.some(row=>(codec.open(row,row.nonce,row.payload,'job') as ImReflectionJob).scope.type==='owner'),false)
    })
    await t.test('真实PG重领已进入周期请求但无计划的过期任务：保留未知结果，不重发模型或假记零成本',async()=>{
      await run(20)
      const row=(await db.query("SELECT * FROM gugu_im_reflection_jobs WHERE session_id=20 AND window_key='run'")).rows[0],codec=createImReflectionCodec(secret),at=Date.now()/1000
      const original=codec.open(row,row.nonce,row.payload,'job') as ImReflectionJob
      const job={...original,periodic:{field:'profile' as const,attemptAt:at,requestStarted:true as const}},sealed=codec.seal(job,job,'job')
      // 模拟另一个进程已提交请求阶段后消失；实际的源v3 Run、收据及加密任务来自上面的真实Harness。
      await db.query(`UPDATE gugu_im_reflection_jobs SET window_key='periodic:profile:synthetic-interrupted',nonce=$2,payload=$3,state='running',token=$4,
        lease_until=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[row.id,sealed.nonce,sealed.payload,randomUUID()])
      await mkdir(join(root,owner,'.agent','memories'),{recursive:true})
      const profile=JSON.stringify(Array.from({length:100},(_,i)=>({type:'note',text:`合成未确认画像${i}`,ts:1})))
      const metadata=JSON.stringify({profile_last_attempt_at:at,synthetic_keep:true})
      await writeFile(join(root,owner,'.agent', 'memories','profile.json'),profile);await writeFile(join(root,owner,'.agent', 'memories','pattern_maintenance.json'),metadata)
      const calls=reflectionCalls,billing=(await db.query("SELECT 1 FROM agent_usage WHERE scenario='compaction'")).rowCount
      assert.equal(await service!.runOnce(),true)
      const terminal=(await db.query('SELECT state,last_error_code,plan_payload FROM gugu_im_reflection_jobs WHERE id=$1',[row.id])).rows[0]
      assert.equal(terminal.state,'dead');assert.equal(terminal.last_error_code,'periodic_result_unknown');assert.equal(terminal.plan_payload,null)
      assert.equal(reflectionCalls,calls);assert.equal((await db.query("SELECT 1 FROM agent_usage WHERE scenario='compaction'")).rowCount,billing)
      assert.equal(await readFile(join(root,owner,'.agent', 'memories','profile.json'),'utf8'),profile)
      assert.equal(await readFile(join(root,owner,'.agent', 'memories','pattern_maintenance.json'),'utf8'),metadata)
    })
    await t.test('真实PG已提交计划但COMMIT回包丢失：第五次attempt仍恢复数据库计划，不误标dead或重复模型/记账',async()=>{
      await run(21)
      const target=(await db.query("SELECT id FROM gugu_im_reflection_jobs WHERE session_id=21 AND window_key='run'")).rows[0].id
      await db.query('UPDATE gugu_im_reflection_jobs SET attempts=4 WHERE id=$1',[target]);await due(21)
      let interrupted=false
      const faultPool={query:db.query.bind(db),async connect(){const client=await db.connect()
        return new Proxy(client,{get(actual,property){
          if(property==='query')return async(sql:unknown,...args:unknown[])=>{
            if(!interrupted&&typeof sql==='string'&&sql.trim().toUpperCase()==='COMMIT'){
              const row=(await actual.query('SELECT state FROM gugu_im_reflection_jobs WHERE id=$1',[target])).rows[0]
              if(row?.state==='prepared'){await actual.query('COMMIT');interrupted=true;throw Error('synthetic-commit-reply-lost')}
            }
            return Reflect.apply(actual.query,actual,[sql,...args])
          }
          const value=Reflect.get(actual,property);return typeof value==='function'?value.bind(actual):value
        }})
      }}
      await service!.stop();service=createImReflectionService({...options,pool:faultPool})
      const calls=reflectionCalls;assert.equal(await service.runOnce(),true);assert.equal(interrupted,true)
      const pending=(await db.query('SELECT state,plan_payload FROM gugu_im_reflection_jobs WHERE id=$1',[target])).rows[0]
      assert.equal(pending.state,'retry');assert.ok(pending.plan_payload);assert.equal(reflectionCalls,calls+1)
      const billed=(await db.query("SELECT 1 FROM agent_usage WHERE session_id=21 AND scenario='reflection'")).rowCount
      assert.equal(billed,1)
      await service.stop();service=createImReflectionService(options);await due(21);await service.runOnce()
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE id=$1',[target])).rows[0].state,'completed')
      assert.equal(reflectionCalls,calls+1);assert.equal((await db.query("SELECT 1 FROM agent_usage WHERE session_id=21 AND scenario='reflection'")).rowCount,billed)
    })
    await t.test('重启后私聊成员、群成员和公开群记忆均能独立反思',async()=>{
      await db.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp()+interval '1 day' WHERE state IN('pending','ready','retry','deferred')")
      for(const group of[false,true]){
        const session=group?23:22
        // TG未知私聊是unknown；Python真正存在的非owner私聊成员来源是QQ，不伪造角色。
        const platform=group?'telegram':'qq'
        await db.query('UPDATE user_bots SET platform=$1 WHERE id=91',[platform])
        await run(session,group,'404',platform)
        await service!.stop();service=createImReflectionService(options);await due(session)
        const before=reflectionCalls
        for(let i=0;i<(group?2:1);i++)assert.equal(await service.runOnce(),true)
        const rows=(await db.query('SELECT * FROM gugu_im_reflection_jobs WHERE session_id=$1',[session])).rows,codec=createImReflectionCodec(secret)
        const member=rows.find(row=>(codec.open(row,row.nonce,row.payload,'job') as ImReflectionJob).scope.type==='platform-user')
        assert.ok(member);assert.equal(member.state,'completed');assert.equal(reflectionCalls,before+(group?2:1))
        if(group){const publicJob=rows.find(row=>(codec.open(row,row.nonce,row.payload,'job') as ImReflectionJob).scope.type==='group')
          assert.ok(publicJob);assert.equal(publicJob.state,'completed')}
      }
    })
    await t.test('成员恢复先复核当前身份与pending会话：角色变化拒绝，待入站未清空只延期且不发Provider',async()=>{
      await db.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp()+interval '1 day' WHERE state IN('pending','ready','retry','deferred')")
      await db.query("UPDATE user_bots SET platform='qq' WHERE id=91")
      await run(24,false,'404','qq');await service!.stop();service=createImReflectionService(options)
      await db.query("UPDATE user_bots SET owner_platform_user_id='404' WHERE id=91")
      const before=reflectionCalls;await due(24);await service.runOnce()
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=24')).rows[0].state,'cancelled')
      assert.equal(reflectionCalls,before)
      await db.query("UPDATE user_bots SET owner_platform_user_id='202' WHERE id=91")
      await run(25,false,'404','qq');await service.stop();service=createImReflectionService(options)
      await db.query('UPDATE conversation_sessions SET pending_message_count=1 WHERE id=25');await due(25);await service.runOnce()
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=25')).rows[0].state,'deferred')
      assert.equal(reflectionCalls,before)
      await db.query('UPDATE conversation_sessions SET pending_message_count=0 WHERE id=25');await due(25);await service.runOnce()
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=25')).rows[0].state,'completed')
      assert.equal(reflectionCalls,before+1)
    })
    await t.test('私聊压缩候选重启后通过原授权及文件计划写入，不再请求反思模型', async () => {
      await db.query("UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp()+interval '1 day' WHERE state IN('pending','ready','retry','deferred')")
      await db.query("UPDATE user_bots SET platform='telegram' WHERE id=91")
      const { identity } = await run(26)
      const messages = (await db.query("SELECT id::text,role,content FROM conversation_messages WHERE session_id=26 ORDER BY conversation_seq")).rows
      const user = messages.find(message => message.role === 'user')
      const reply = messages.findLast(message => message.role === 'assistant')
      const evidence = createHash('sha256').update(JSON.stringify([[user.content, reply.content]])).digest('hex')
      assert.equal(await service!.prepareCompaction!(identity, ['0']), null)
      await db.query("UPDATE gugu_im_reflection_jobs SET state='retry',attempts=1 WHERE session_id=26")
      assert.equal(await service!.prepareCompaction!(identity, [user.id]), null)
      await db.query("UPDATE gugu_im_reflection_jobs SET state='ready',attempts=0 WHERE session_id=26")
      const candidate = await service!.prepareCompaction!(identity, [user.id])
      assert.deepEqual(candidate?.userIds, [user.id])
      const transaction = await db.connect()
      try {
        await transaction.query('BEGIN')
        await service!.stageCompaction!(transaction, identity, [user.id])
        await candidate!.stage(transaction, { daily: '合成压缩记忆' }, evidence)
        await transaction.query('COMMIT')
      } finally { transaction.release() }
      await service!.stop()
      service = createImReflectionService(options)
      const before = reflectionCalls
      const webTransaction = await db.connect()
      try {
        await webTransaction.query('BEGIN')
        await webTransaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['agent-owner-memory:' + owner])
        assert.equal(await service.runOnce(), true)
        const blocked = await db.query('SELECT state,attempts FROM gugu_im_reflection_jobs WHERE session_id=26')
        assert.deepEqual(blocked.rows[0], { state: 'deferred', attempts: 0 })
      } finally {
        await webTransaction.query('ROLLBACK')
        webTransaction.release()
      }
      await due(26)
      assert.equal(await service.runOnce(), true)
      assert.equal(reflectionCalls, before)
      assert.equal((await db.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=26')).rows[0].state, 'completed')
      assert.match(await readFile(join(root,owner,'.agent', 'memories','daily.md'),'utf8'), /合成压缩记忆/u)
      const { rows: [position] } = await db.query('SELECT completed_through FROM web_reflection_intervals WHERE session_id=26 AND user_id=$1', [owner])
      assert.equal(position?.completed_through, '1')
      assert.equal((await db.query('SELECT 1 FROM web_reflection_intervals WHERE session_id IN (23,25)')).rowCount, 0)
    })
  }finally{await service?.stop();await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
