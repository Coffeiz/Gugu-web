import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { stableJson,createAgentRunner,type AgentRunnerPorts,type RunEvent,type CancellationPort } from '@gugu/core/agent'
import type { ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import { withPostgresTransaction } from '../../../src/adapters/database/postgres-transaction.js'
import { enqueueAgentRunLocked,createPostgresAgentDispatch,type AgentDispatchLease } from '../../../src/modules/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createPostgresAgentRunStore } from '../../../src/modules/agent-sessions/persistence/agent-run-store-postgres.js'
import { createPostgresAgentRunLeasePort } from '../../../src/modules/agent-sessions/persistence/agent-run-lease-postgres.js'
import { lockAgentRunSession } from '../../../src/modules/agent-sessions/persistence/agent-run-startup-postgres.js'
import { createPostgresImShortcut } from '../../../src/modules/im/gateway/shortcut-postgres.js'

const owner = '00000000-0000-4000-8000-000000000071', secretKey = 'synthetic-shortcut-secret'
const scope: ImPreflightScope = { ownerId:owner,platform:'qq',botId:'71',chatType:'group',chatId:'synthetic-room',platformUserId:'synthetic-member',eventId:'control-1',admissionCutoff:'2090-01-01T00:00:00Z' }
const scopeHash = (s: ImPreflightScope) => createHmac('sha256',secretKey).update('gugu-im-conversation-v1\0').update(stableJson([s.ownerId,s.platform,s.botId,s.chatType,s.chatId ?? s.platformUserId])).digest('hex')
test('缺可信准入边界不访问数据库，查询异常仅公开静态错误', async () => {
  let calls = 0
  const service = createPostgresImShortcut({ pool: { async connect() { calls++; throw new Error('合成SQL及输入不可公开') } } as unknown as Pick<Pool,'connect'>,
    secretKey,supportedPlatforms:()=>['qq'],cancellation:{ async request(){},async notify(){} },wake(){},diagnose(){} })
  await assert.rejects(service.read({...scope,admissionCutoff:undefined}),{message:'IM 快捷控制暂不可用'})
  assert.equal(calls,0)
  await assert.rejects(service.read(scope),error => error instanceof Error && error.message === 'IM 快捷控制暂不可用' && !('cause' in error))
  assert.equal(calls,1)
})

const url = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PostgreSQL：冻结原Run、完整批次发起者、实时撤权与取消持久恢复',{
  skip:!url && '未运行：显式设置 GUGU_IM_GATEWAY_TEST_DATABASE_URL；查询替身不证明事务和锁',timeout:30000,
},async t => {
  const { Pool } = await import('pg'), schema = `im_shortcut_${randomUUID().replaceAll('-','')}`
  const admin = new Pool({connectionString:url}), pool = new Pool({connectionString:url,options:`-c search_path=${schema}`,max:5})
  const notifications: string[] = [], diagnostics: string[] = []
  let failNotify = false
  const make = () => createPostgresImShortcut({pool,secretKey,supportedPlatforms:()=>['qq','telegram','feishu','wechat'],
    cancellation:{async request(id){notifications.push(id.runId);if(failNotify)throw new Error('合成网络异常')},async notify(){}},wake(){},diagnose(code){diagnostics.push(code)} })
  const service = make()
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid REFERENCES users(id),platform text,enabled boolean,owner_platform_user_id text,group_allowed_tools json,group_owner_memory_enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id integer,chat_id text,execution_state text DEFAULT 'idle',active_run_id text,pending_message_count integer DEFAULT 0);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer REFERENCES conversation_sessions(id),role text,run_id text,platform_user_id text,chat_type text,created_at timestamptz);
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text,created_at timestamptz);
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,status text,version bigint,sequence bigint,phase text,nonce bytea,payload bytea,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,token text,fence bigint,expires_at timestamptz,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id));
      CREATE TABLE agent_run_events(user_id uuid,session_id integer,run_id text,event_id text,sequence bigint,nonce bytea,payload bytea,created_at timestamptz,acknowledged_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,event_id));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text,created_at timestamptz);
      CREATE TABLE agent_run_dispatch(sequence bigserial PRIMARY KEY,user_id uuid,session_id integer,run_id varchar(128),state text,message_id integer,nonce bytea,payload bytea,request_expires_at timestamptz,token text,fence bigint DEFAULT 0,lease_expires_at timestamptz,cancel_requested boolean DEFAULT false,blocked_reason text,UNIQUE(user_id,session_id,run_id));
      CREATE UNIQUE INDEX selected ON agent_run_dispatch(user_id,session_id) WHERE state='selected';
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,message_id integer,run_id text,platform text,bot_id text,chat_type text,state text,scope_hash text,event_hash text);`)
    await pool.query(await readFile(new URL('../../../src/modules/im/gateway/shortcut-schema.sql',import.meta.url),'utf8'))
    async function reset() {
      await pool.query(`TRUNCATE gugu_im_shortcut_controls,gugu_im_inbound_receipts,agent_run_checkpoints,agent_run_leases,agent_run_events,agent_run_interaction_receipts,agent_run_startups,agent_run_dispatch,conversation_messages,conversation_sessions,user_bots,users CASCADE`)
      await pool.query(`INSERT INTO users VALUES($1,true,'active');`,[owner])
      await pool.query(`INSERT INTO user_bots VALUES(71,$1,'qq',true,'synthetic-owner','[]',false,true,NULL)`,[owner])
      await pool.query(`INSERT INTO conversation_sessions(id,user_id,source,bot_id,chat_id) VALUES(1,$1,'web',NULL,NULL)`,[owner])
      notifications.length=0; diagnostics.length=0;failNotify=false
    }
    async function run(runId:string, ids:number[], speakers:string[], s=scope, web=false) {
      for (const [i,id] of ids.entries()) {
        await pool.query(`INSERT INTO conversation_messages VALUES($1,1,'user',$2,$3,$4,'2020-01-01Z')`,[id,runId,speakers[i],s.chatType])
        await pool.query(`INSERT INTO gugu_im_inbound_receipts VALUES($1,1,$2,$3,$4,$5,$6,'dispatched',$7,$8)`,[owner,id,runId,s.platform,s.botId,s.chatType,scopeHash(s),String(id)])
      }
      await pool.query(`INSERT INTO agent_run_startups VALUES($1,1,$2,'pending','2020-01-01Z')`,[owner,runId])
      await withPostgresTransaction(pool,async client => {
        const identity = {ownerId:owner,sessionId:'1',runId}
        assert.equal(await lockAgentRunSession(client,identity),true)
        await enqueueAgentRunLocked(client,secretKey,identity,web ? {v:2,source:'web',userMessageId:ids.at(-1)!,locale:null,origin:null,accessVersion:'a'.repeat(64)} : {
          v:3,source:'im',userMessageId:ids.at(-1)!,locale:null,origin:null,accessVersion:'a'.repeat(64),im:{platform:s.platform,botId:s.botId,chatType:s.chatType,chatId:s.chatId,platformUserId:speakers.at(-1)!,
            ...(ids.length>1?{batch:{batchKey:'b'.repeat(64),segmentKey:'c'.repeat(64),messageIds:ids}}:{})}},60)
      })
    }
    await t.test('实际v3调度codec与Web显式绑定会话仍能证明IM来源，重启服务保留reference',async()=>{
      await reset();await run('first',[1,2],['synthetic-other','synthetic-member'])
      const read=await service.read(scope)
      assert.equal(read.state,'thinking');assert.deepEqual(read.initiatorIds,['synthetic-member','synthetic-other'])
      assert.equal((await make().read(scope)).cancelReference,read.cancelReference)
      assert.equal(await make().cancel(scope,read.cancelReference!),true)
      assert.equal((await pool.query('SELECT cancel_requested FROM agent_run_dispatch')).rows[0].cancel_requested,true)
      assert.deepEqual(notifications,['first'])
    })
    await t.test('非发起者或跨群跨event引用不取消，缺失任一批次收据拒绝读取',async()=>{
      await reset();await run('first',[1,2],['synthetic-other','synthetic-member'])
      const outsider={...scope,platformUserId:'outsider'}, read=await service.read(outsider)
      assert.equal(await service.cancel(outsider,read.cancelReference!),false)
      const own=await service.read(scope)
      assert.equal(await service.cancel({...scope,chatId:'other-room'},own.cancelReference!),false)
      assert.equal(await service.cancel({...scope,eventId:'other-event'},own.cancelReference!),false)
      await pool.query('DELETE FROM gugu_im_inbound_receipts WHERE message_id=1')
      await assert.rejects(service.read({...scope,eventId:'incomplete'}),{message:'IM 快捷控制暂不可用'})
      assert.equal((await pool.query('SELECT cancel_requested FROM agent_run_dispatch')).rows[0].cancel_requested,false)
    })
    await t.test('read后原Run完成且新Run selected，旧引用绝不转投新Run',async()=>{
      await reset();await run('first',[1],['synthetic-member'])
      const read=await service.read(scope)
      await pool.query(`UPDATE agent_run_dispatch SET state='done';INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,status) VALUES('${owner}',1,'first','completed')`)
      await run('second',[2],['synthetic-member'])
      assert.equal(await service.cancel(scope,read.cancelReference!),false)
      assert.deepEqual((await pool.query('SELECT cancel_requested FROM agent_run_dispatch ORDER BY sequence')).rows.map(r=>r.cancel_requested),[false,false])
      assert.equal((await service.read(scope)).state,'idle')
    })
    await t.test('waiting已done取消仅重排原Run，新selected及其他queued顺序不被覆盖',async()=>{
      await reset();await run('waiting',[1],['synthetic-member'])
      await pool.query(`UPDATE agent_run_dispatch SET state='done';INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,status) VALUES('${owner}',1,'waiting','waiting')`)
      const read=await service.read(scope);assert.equal(read.state,'waiting_confirm')
      await run('new-selected',[2],['synthetic-member']);await run('new-queued',[3],['synthetic-member'])
      assert.equal(await service.cancel(scope,read.cancelReference!),true)
      assert.deepEqual((await pool.query('SELECT run_id,state,cancel_requested FROM agent_run_dispatch ORDER BY sequence')).rows,[
        {run_id:'waiting',state:'queued',cancel_requested:true},{run_id:'new-selected',state:'selected',cancel_requested:false},{run_id:'new-queued',state:'queued',cancel_requested:false}])
      assert.equal((await pool.query('SELECT pending_message_count FROM conversation_sessions')).rows[0].pending_message_count,2)
    })
    await t.test('精确微秒cutoff阻止首次准入后新Run，原消息时间也必须可证明',async()=>{
      await reset();await run('first',[1],['synthetic-member'])
      await pool.query(`UPDATE agent_run_startups SET created_at='2030-01-01 00:00:00.000002+00'`)
      await assert.rejects(service.read({...scope,admissionCutoff:'2030-01-01 00:00:00.000001+00'}))
      await pool.query(`UPDATE agent_run_startups SET created_at='2020-01-01Z';UPDATE conversation_messages SET created_at='2030-01-01 00:00:00.000002+00'`)
      await assert.rejects(service.read({...scope,admissionCutoff:'2030-01-01 00:00:00.000001+00'}))
    })
    await t.test('PG取消已提交而Redis/wake失败仍true并持久pending，重复只通知同一Run',async()=>{
      await reset();await run('first',[1],['synthetic-member']);const read=await service.read(scope)
      failNotify=true;assert.equal(await service.cancel(scope,read.cancelReference!),true)
      assert.deepEqual(diagnostics,['shortcut_notification_pending'])
      assert.equal((await pool.query('SELECT notification_pending FROM gugu_im_shortcut_controls')).rows[0].notification_pending,true)
      await pool.query(`UPDATE agent_run_dispatch SET state='done';INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,status) VALUES('${owner}',1,'first','cancelled')`)
      await run('second',[2],['synthetic-member']);failNotify=false
      assert.equal(await make().cancel(scope,read.cancelReference!),true)
      assert.deepEqual(notifications,['first','first'])
      assert.equal((await pool.query("SELECT cancel_requested FROM agent_run_dispatch WHERE run_id='second'")).rows[0].cancel_requested,false)
    })
    await t.test('群停用和账户撤权后旧reference拒绝，Web v2不得借IM收据取消',async()=>{
      await reset();await run('first',[1],['synthetic-member']);const read=await service.read(scope)
      await pool.query('UPDATE user_bots SET group_chat_enabled=false')
      assert.equal(await service.cancel(scope,read.cancelReference!),false)
      await pool.query("UPDATE user_bots SET group_chat_enabled=true;UPDATE users SET account_status='suspended'")
      assert.equal(await service.cancel(scope,read.cancelReference!),false)
      await reset();await run('web',[1],['synthetic-member'],scope,true)
      await assert.rejects(service.read(scope),{message:'IM 快捷控制暂不可用'})
    })
    await t.test('私聊只允许当前可信owner绑定，篡改密文与错owner不公开细节',async()=>{
      await reset();const privateScope={...scope,chatType:'c2c' as const,chatId:null,platformUserId:'synthetic-owner'}
      await run('private',[1],['synthetic-owner'],privateScope)
      assert.equal((await service.read(privateScope)).state,'thinking')
      await assert.rejects(service.read({...privateScope,platformUserId:'unbound'}))
      await assert.rejects(service.read({...privateScope,ownerId:randomUUID()}))
      await pool.query("UPDATE agent_run_dispatch SET payload=decode('00000000000000000000000000000000','hex')")
      await assert.rejects(service.read({...privateScope,eventId:'bad'}),{message:'IM 快捷控制暂不可用'})
    })
    for(const platform of ['feishu','wechat'] as const)await t.test(`${platform}可信私聊无owner绑定时按共享owner规则允许本人，其他sender不能借用原Run`,async()=>{
      await reset()
      await pool.query('UPDATE user_bots SET platform=$1,owner_platform_user_id=NULL',[platform])
      const privateScope={...scope,platform,chatType:'c2c' as const,chatId:null,platformUserId:'synthetic-private-user'}
      await run('private-unbound',[1],['synthetic-private-user'],privateScope)
      const read=await service.read(privateScope)
      assert.equal(read.state,'thinking')
      const otherScope={...privateScope,platformUserId:'other-private-user'}
      assert.deepEqual(await service.read(otherScope),{state:'idle',awaiting:false,initiatorIds:[]})
      assert.equal(await service.cancel(otherScope,read.cancelReference!),false)
      assert.equal((await pool.query('SELECT cancel_requested FROM agent_run_dispatch')).rows[0].cancel_requested,false)
      assert.equal(await service.cancel(privateScope,read.cancelReference!),true)
      assert.equal((await pool.query('SELECT cancel_requested FROM agent_run_dispatch')).rows[0].cancel_requested,true)
    })
    await t.test('真实持久Harness等待checkpoint经调度恢复取消，先于交互恢复且不再Provider或工具执行',async()=>{
      await reset();await run('harness',[1],['synthetic-member'])
      const dispatch=createPostgresAgentDispatch(pool,secretKey,30000,['im'])
      let lease:AgentDispatchLease|null=await dispatch.claim(owner,'1')
      assert.ok(lease)
      const cancelled=new Set<string>(), cancellation:CancellationPort={
        async isRequested(id){return cancelled.has(id.runId)},async request(id){cancelled.add(id.runId)},async notify(){},async subscribe(){return ()=>{}} }
      const store=createPostgresAgentRunStore<string[]>(pool,secretKey,{async writeHistory(){}})
      let providerCalls=0,toolCalls=0,restores=0
      const call={id:'synthetic-call',name:'synthetic-confirm',input:{}}
      const ports:AgentRunnerPorts<string[]>={
        clock:{now:()=>new Date().toISOString()},store,cancellation,leases:createPostgresAgentRunLeasePort(pool,{dispatchLease:()=>lease}),
        provider:{async *stream(){providerCalls++;yield{type:'complete',text:'',calls:[call]}}},
        context:{assertIdentity(){},async checkpointToolResult(_scope,value){return value},async restoreToolResult(_scope,value){return value},async prepare(){return ['synthetic-owned-context']},async afterRound(context){return context},async afterTool(context){return context},async resumeInteraction(context){restores++;return context},async recoverOverflow(context){return{context,applied:false}},async afterUsage(context){return{context,applied:false}}},
        tools:{async dispatch(){toolCalls++;return{kind:'waiting',interaction:{id:'synthetic-prompt',kind:'confirmation',toolCall:call}}},async reconcile(){return{kind:'unknown'}}},
        interactions:{async activate(_id,value){return value}},execution:{async execute(){throw new Error('不应执行进程')}},reply:{async evaluate(){return'accept'}},
        sanitizeText:text=>text,createStreamSanitizer:()=>({feed:text=>text,flush:()=>''}),presentError:()=>({code:'failed',text:'失败'}),async presentToolResult(value){return value},async publish(){},diagnose(){},
      }
      const id=lease.identity
      for await(const _event of createAgentRunner(ports).start(id,{anchorMessageId:'1'})){}
      assert.equal((await store.read(id))?.status,'waiting')
      assert.equal(await dispatch.finish(lease),true)
      assert.equal(await dispatch.claim(owner,'1'),null,'普通waiting不能重复恢复')
      const control=createPostgresImShortcut({pool,secretKey,supportedPlatforms:()=>['qq'],cancellation,wake(){},diagnose(){}})
      const read=await control.read(scope);assert.equal(read.state,'waiting_confirm')
      const { createImShortcutControls } = await import('../../../src/modules/im/gateway/shortcut-controls.js')
      const { createImInboundPreflight } = await import('@gugu/core/im/inbound-preflight')
      const { createPostgresImAccess } = await import('../../../src/modules/im/gateway/access-postgres.js')
      const access=createPostgresImAccess({query:(query,args)=>pool.query(query,args),supportedPlatforms:()=>['qq']})
      const replies:string[]=[]
      const inbound = createImInboundPreflight({ ...createImShortcutControls({state:control,diagnose(){}}),
        authorize:async current=>await access.readBot(current)!==null, inspectSecret:async()=>{throw new Error('群控制不读秘密stage')},
        applySecret:async()=>{throw new Error('群控制不写秘密stage')},bindQqOwnerIfUnbound:async()=>{},consumeBinding:async()=>false,
        consumeTextChoice:async()=>null,reply:async(_scope,text)=>{replies.push(text)} })
      assert.equal(await inbound({scope,text:'/stop',hasPendingMedia:false,botMentioned:false},new AbortController().signal),'consumed')
      assert.deepEqual(replies,['🛑 已停止当前任务'])
      assert.equal(await dispatch.settleExpired(owner,'1'),false,'等待取消不得被普通waiting结算跳过')
      assert.deepEqual(await dispatch.listReady(),[{ownerId:owner,sessionId:'1'}])
      lease=await dispatch.claim(owner,'1');assert.ok(lease);assert.equal(lease.mode,'resume');assert.equal(lease.cancelRequested,true)
      const resumed:RunEvent[]=[]
      for await(const event of createAgentRunner(ports).resume(id))resumed.push(event)
      assert.equal((await store.read(id))?.status,'cancelled')
      assert.equal(resumed.at(-1)?.type,'final')
      assert.equal(providerCalls,1);assert.equal(toolCalls,1);assert.equal(restores,0)
      assert.equal(await dispatch.finish(lease),true)
      assert.equal((await pool.query('SELECT state FROM agent_run_dispatch')).rows[0].state,'done')
    })
  } finally { await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end() }
})
