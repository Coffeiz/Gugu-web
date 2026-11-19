import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {createImProductionFixture} from './production.fixtures.js'
import {createImSessionDelete,ImSessionDeleteBusy,ImSessionDeleteUnavailable} from '../../../src/modules/im/gateway/session-delete.js'
import {createImInboundEnvelope} from '../../../src/modules/im/gateway/inbound-envelope.js'
import {imConversationDigest,imConversationFingerprint,imConversationScopeHash} from '../../../src/modules/im/gateway/conversation-identity.js'
import {enqueueAgentRunLocked,createPostgresAgentDispatch} from '../../../src/modules/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import {createImRetiredInbound} from '../../../src/modules/im/gateway/retired-inbound.js'
import {withImReflectionOwnerLock} from '../../../src/modules/im/gateway/reflection-postgres.js'
import {createImHistoryRetention} from '../../../src/modules/im/gateway/history-retention.js'
import {createPostgresChatAttachmentDraftDeletePorts} from '../../../src/modules/agent/attachment-staging-postgres.js'
import {imActorInputFromPayload} from '@gugu/core/im/access'
import {createPostgresImAccess} from '../../../src/modules/im/gateway/access-postgres.js'
import {createImRunScope,createImRunSourceProof,ImRunScopeError} from '../../../src/modules/im/gateway/run-scope.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
test('显式Session删除按真实Node事实原子分流；永久去重、持久GC、准确取消和未知副作用保护',{
 skip:!(databaseUrl&&python)&&'需显式隔离PG与离线ORM解释器',timeout:120000,
},async t=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),binding={ownerId:f.ownerId,platform:'telegram' as const,botId:f.botId}
 const envelope=createImInboundEnvelope(f.secretKey),retired=createImRetiredInbound({pool:f.pool,secretKey:f.secretKey})
 let oldFiles=0,oldReflection=0,wake=0,cancelled:string[]=[],pending=false
 let onCancel:((run:string)=>Promise<void>)|null=null
 const legacy={async removeIfUnreferenced(){oldFiles++;return false},async clearReflection(){oldReflection++}}
 const options={pool:f.pool,secretKey:f.secretKey,cancelWaitMs:500,
  pendingAsks:{async cancel(){pending=false},async hasPending(){return pending}},
  cancellation:{async request(identity:{runId:string}){cancelled.push(identity.runId);await onCancel?.(identity.runId)},async notify(){}},
  wakeDispatch(){wake++},wakeInteractions(){wake++},wakeMaintenance(){wake++}}
 const service=createImSessionDelete(options)
 async function seed(node=true,group=false){
  const chatId=group?`synthetic-delete-group-${randomUUID()}`:null,chatType=group?'group' as const:'c2c' as const
  const s=await f.insert('conversation_sessions',{user_id:f.ownerId,title:'合成删除目标',source:group?'telegram':'web',bot_id:group?f.botId:null,chat_type:group?'group':null,chat_id:chatId,execution_state:'idle',pending_message_count:0,last_message_seq:1})
  const m=await f.insert('conversation_messages',{session_id:s.id,conversation_seq:1,role:'user',content:'合成待删消息',platform_user_id:'202',im_platform_message_id:'101',chat_type:chatType})
  await f.pool.query('UPDATE conversation_messages SET im_platform_message_id=$2 WHERE id=$1',[m.id,String(m.id)])
  const run=randomUUID(),payload={platform:'telegram',owner_user_id:f.ownerId,bot_id:f.botId,channel_id:f.botId,chat_type:chatType,chat_id:chatId,platform_user_id:'202',message_id:String(m.id),platform_message_id:String(m.id),text:'合成待删消息',attachments:[]}
  await f.pool.query('UPDATE conversation_messages SET run_id=$2 WHERE id=$1',[m.id,run])
  if(node){const scope=imConversationScopeHash(f.secretKey,binding,payload)
   await f.pool.query(`INSERT INTO gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,session_id,message_id,state,run_id,sealed_payload)
    VALUES($1,'telegram',$2,$10,$3,$4,$5,$6,$7,'dispatched',$8,$9)`,[f.ownerId,f.botId,scope,imConversationDigest(f.secretKey,[scope,'202',String(m.id)]),imConversationFingerprint(f.secretKey,scope,payload,[]),s.id,m.id,run,envelope.seal(binding,payload),chatType])}
  return{s,m,run,payload,node,identity:{ownerId:f.ownerId,sessionId:String(s.id),runId:run}}
 }
 async function dispatch(x:Awaited<ReturnType<typeof seed>>,status?:string,web=false){
  const tx=await f.pool.connect();try{await tx.query('BEGIN');await tx.query('SELECT 1 FROM conversation_sessions WHERE id=$1 FOR UPDATE',[x.s.id]);await enqueueAgentRunLocked(tx,f.secretKey,x.identity,
   {v:web?2:3,source:web?'web':'im',userMessageId:x.m.id,locale:null,origin:null,accessVersion:'a'.repeat(64),...(!web?{im:{platform:'telegram',botId:f.botId,chatType:x.payload.chat_type,chatId:x.payload.chat_id,platformUserId:'202'}}:{})} as never,300);await tx.query('COMMIT')}finally{tx.release()}
  if(status)await f.pool.query(`INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,version,sequence,status,phase,nonce,payload,created_at,updated_at)
    VALUES($1,$2,$3,1,1,$4,'idle',$5,$6,now(),now())`,[f.ownerId,x.s.id,x.run,status,Buffer.alloc(12),Buffer.alloc(16)])
  if(!web&&x.node){const source=imActorInputFromPayload(binding,x.payload),access=createPostgresImAccess({query:(q,p)=>f.pool.query(q,p),supportedPlatforms:()=>['telegram']})
   const snapshot=await access.snapshot(source),actor=snapshot.actor(source)
   await createImRunScope({pool:f.pool,secretKey:f.secretKey,identity:x.identity,actor,scope:source,messageIds:[String(x.m.id)],payload:x.payload,authorize:()=>access.authorizeDelivery(actor,snapshot.bot!)}).read()}
 }
 try{
  await t.test('legacy仍沿旧清理，其他Session反思owner锁不阻止；缺失/跨owner返回false',async()=>{
   const x=await seed(false)
   await withImReflectionOwnerLock(f.pool,f.ownerId,async()=>{assert.equal(await service.remove(f.ownerId,x.s.id,legacy),true)})
   assert.equal(oldReflection,1);assert.equal(await service.remove(f.ownerId,x.s.id,legacy),false)
   const y=await seed();assert.equal(await service.remove(f.otherOwnerId,y.s.id,legacy),false)
   assert.equal((await f.pool.query('SELECT 1 FROM conversation_sessions WHERE id=$1',[y.s.id])).rowCount,1)
  })
  await t.test('Node Web绑定会话先墓碑+持久GC，不调用Python清理；真实终端来源隔离、GC可重启',async()=>{
   const x=await seed(),key=`${f.ownerId}/.chat_staging/delete-node.bin`,path=join(f.storageRoot,key)
   await mkdir(dirname(path),{recursive:true});await writeFile(path,'synthetic')
   await f.insert('chat_attachments',{user_id:f.ownerId,message_id:x.m.id,attach_id:randomUUID().replaceAll('-',''),storage_key:key,state:'attached',size:9})
   await f.insert('terminal_sessions',{id:'synthetic-delete-agent',owner_id:f.ownerId,session_id:x.s.id,source:'agent',status:'running'})
   await f.insert('terminal_sessions',{id:'synthetic-delete-user',owner_id:f.ownerId,session_id:x.s.id,source:'user',status:'running'})
   const before=oldReflection;assert.equal(await service.remove(f.ownerId,x.s.id,legacy),true);assert.equal(oldReflection,before);assert.equal(oldFiles,0)
   assert.equal(await retired.seen(binding,x.payload),true);assert.equal((await readFile(path)).toString(),'synthetic')
   const terminals=(await f.pool.query('SELECT id,status FROM terminal_sessions ORDER BY id')).rows
   assert.deepEqual(terminals.map(r=>[r.id,r.status]),[['synthetic-delete-agent','terminated'],['synthetic-delete-user','running']])
   const storage=createPostgresChatAttachmentDraftDeletePorts(f.pool,f.storageRoot),gc=createImHistoryRetention({pool:f.pool,beforeRemoveLocked:()=>assert.fail('只处理已提交GC'),pendingAsk:async()=> 'clear',removeIfUnreferenced:storage.removeUnreferenced})
   try{assert.equal(await gc.processCleanup(),1);await assert.rejects(readFile(path),{code:'ENOENT'})}finally{await gc.close()}
  })
  await t.test('真实加密v3 selected与queued均精确取消，真实终态到达后同次remove完成',async()=>{
   const x=await seed();await dispatch(x,'running')
   await f.pool.query("UPDATE conversation_sessions SET execution_state='running',active_run_id=$2 WHERE id=$1",[x.s.id,x.run])
   onCancel=async run=>{assert.equal(run,x.run);assert.equal((await f.pool.query('SELECT cancel_requested FROM agent_run_dispatch WHERE run_id=$1',[run])).rows[0].cancel_requested,true)
    await f.pool.query("UPDATE agent_run_checkpoints SET status='cancelled' WHERE run_id=$1",[run]);await f.pool.query("UPDATE agent_run_dispatch SET state='done' WHERE run_id=$1",[run]);await f.pool.query("UPDATE conversation_sessions SET execution_state='idle',active_run_id=NULL WHERE id=$1",[x.s.id])}
   assert.equal(await service.remove(f.ownerId,x.s.id,legacy),true);assert.ok(cancelled.includes(x.run));onCancel=null
   const y=await seed();await dispatch(y)
   await f.pool.query("UPDATE agent_run_dispatch SET state='queued' WHERE run_id=$1",[y.run])
   await assert.rejects(createImSessionDelete({...options,cancelWaitMs:0}).remove(f.ownerId,y.s.id,legacy),ImSessionDeleteBusy)
   assert.equal((await f.pool.query('SELECT state,cancel_requested FROM agent_run_dispatch WHERE run_id=$1',[y.run])).rows[0].cancel_requested,true)
  })
  await t.test('waiting done精确重排后真实dispatch.claim可resume取消；v2 Web Run不被IM删除取消',async()=>{
   const x=await seed();await dispatch(x,'waiting');await f.pool.query("UPDATE agent_run_dispatch SET state='done' WHERE run_id=$1",[x.run])
   await assert.rejects(createImSessionDelete({...options,cancelWaitMs:0}).remove(f.ownerId,x.s.id,legacy),ImSessionDeleteBusy)
   const lease=await createPostgresAgentDispatch(f.pool,f.secretKey,30000,['im']).claim(f.ownerId,String(x.s.id))
   assert.equal(lease?.identity.runId,x.run);assert.equal(lease?.cancelRequested,true);assert.equal(lease?.mode,'resume')
   const y=await seed();await dispatch(y,'running',true);const before=cancelled.length
   await assert.rejects(service.remove(f.ownerId,y.s.id,legacy),ImSessionDeleteBusy);assert.equal(cancelled.length,before)
   assert.equal((await f.pool.query('SELECT cancel_requested FROM agent_run_dispatch WHERE run_id=$1',[y.run])).rows[0].cancel_requested,false)
  })
  await t.test('Bot停用/群停用/平台解绑不阻止活跃API owner取消；出站仍因实际撤权拒绝',async()=>{
   const cases=[['bot',false,'UPDATE user_bots SET enabled=false WHERE id=$1'],['group',true,'UPDATE user_bots SET group_chat_enabled=false WHERE id=$1'],['binding',false,'UPDATE user_bots SET owner_platform_user_id=NULL WHERE id=$1']] as const
   for(const[label,group,revoke]of cases){
    const x=await seed(true,group);await dispatch(x,'running')
    const source=imActorInputFromPayload(binding,x.payload),access=createPostgresImAccess({query:(q,p)=>f.pool.query(q,p),supportedPlatforms:()=>['telegram']})
    const snapshot=await access.snapshot(source),actor=snapshot.actor(source)
    const outbound=createImRunScope({pool:f.pool,secretKey:f.secretKey,identity:x.identity,scope:source,actor,messageIds:[String(x.m.id)],payload:x.payload,authorize:()=>access.authorizeDelivery(actor,snapshot.bot!)})
    await f.pool.query(revoke,[f.botId])
    try{
     await assert.rejects(outbound.read(),ImRunScopeError,label)
     await assert.rejects(createImSessionDelete({...options,cancelWaitMs:0}).remove(f.ownerId,x.s.id,legacy),ImSessionDeleteBusy)
     assert.ok(cancelled.includes(x.run),label)
     assert.equal((await f.pool.query('SELECT cancel_requested FROM agent_run_dispatch WHERE run_id=$1',[x.run])).rows[0].cancel_requested,true,label)
    }finally{await f.pool.query("UPDATE user_bots SET enabled=true,group_chat_enabled=true,owner_platform_user_id='202' WHERE id=$1",[f.botId])}
   }
  })
  await t.test('账户停用/非active、其他owner及坏HMAC证明均不请求取消，错误类型固定脱敏',async()=>{
   for(const change of["is_active=false","account_status='suspended'"]){
    const x=await seed();await dispatch(x,'running');const before=cancelled.length
    await f.pool.query(`UPDATE users SET ${change} WHERE id=$1`,[f.ownerId])
    try{await assert.rejects(service.remove(f.ownerId,x.s.id,legacy),ImSessionDeleteBusy);assert.equal(cancelled.length,before)}
    finally{await f.pool.query("UPDATE users SET is_active=true,account_status='active' WHERE id=$1",[f.ownerId])}
   }
   const x=await seed();await dispatch(x,'running');const before=cancelled.length
   assert.equal(await service.remove(f.otherOwnerId,x.s.id,legacy),false);assert.equal(cancelled.length,before)
   await f.pool.query('UPDATE gugu_im_inbound_receipts SET fingerprint=$2 WHERE message_id=$1',[x.m.id,'f'.repeat(64)])
   await assert.rejects(service.remove(f.ownerId,x.s.id,legacy),(error:unknown)=>error instanceof ImSessionDeleteBusy&&!('cause'in error))
   assert.equal(cancelled.length,before);assert.equal((await f.pool.query('SELECT cancel_requested FROM agent_run_dispatch WHERE run_id=$1',[x.run])).rows[0].cancel_requested,false)
   assert.throws(()=>createImRunSourceProof({payload:{uncloneable(){}}} as never),ImRunScopeError)
  })
  await t.test('unknown投递/跨会话引用/反思锁保护；目标反思取消不影响owner其他Session',async()=>{
   const x=await seed();await f.pool.query('INSERT INTO gugu_im_run_delivery VALUES($1,$2,$3,0)',[f.ownerId,x.s.id,x.run])
   await f.pool.query("INSERT INTO gugu_im_delivery_receipts VALUES($1,$2,$3,'text',$4,'unknown',$5)",[f.ownerId,x.s.id,x.run,'a'.repeat(64),randomUUID()])
   await assert.rejects(service.remove(f.ownerId,x.s.id,legacy),ImSessionDeleteBusy)
   await withImReflectionOwnerLock(f.pool,f.ownerId,async()=>{await assert.rejects(service.remove(f.ownerId,x.s.id,legacy),ImSessionDeleteBusy)})
   const source=await seed(),quoted=await seed(false),key=`${f.ownerId}/.chat_staging/quoted-delete.bin`
   for(const[message,quote]of[[source.m.id,false],[quoted.m.id,true]] as const)await f.insert('chat_attachments',{user_id:f.ownerId,message_id:message,attach_id:randomUUID().replaceAll('-',''),storage_key:key,platform:'telegram',state:'attached',kind:'voice',extra:{quoted:quote,im_ingress_scope:'synthetic-same-scope'}})
   await assert.rejects(service.remove(f.ownerId,source.s.id,legacy),ImSessionDeleteBusy)
   const a=await seed(),b=await seed()
   for(const z of[a,b])await f.pool.query(`INSERT INTO gugu_im_reflection_jobs(id,user_id,session_id,run_id,scope_hash,scope_version,state,nonce,payload)
     VALUES($1,$2,$3,$4,$5,0,'ready',$6,$7)`,[randomUUID(),f.ownerId,z.s.id,z.run,'b'.repeat(64),Buffer.alloc(12),Buffer.alloc(16)])
   for(const z of[a,b])await f.pool.query(`INSERT INTO gugu_im_reflection_trigger_windows(id,user_id,session_id,owner_revision,through_message_id,through_message_seq,scope_versions,reason)
     VALUES($1,$2,$3,0,$4,1,'{}'::jsonb,'threshold')`,[randomUUID(),f.ownerId,z.s.id,z.m.id])
   assert.equal(await service.remove(f.ownerId,a.s.id,legacy),true)
   assert.equal((await f.pool.query('SELECT state FROM gugu_im_reflection_jobs WHERE session_id=$1',[b.s.id])).rows[0].state,'ready')
   assert.equal((await f.pool.query('SELECT status FROM gugu_im_reflection_trigger_windows WHERE session_id=$1',[b.s.id])).rows[0].status,'pending')
  })
  await t.test('只有密封v3 dispatch也按Node删除；坏dispatch不回落legacy，事务故障回滚墓碑和GC且错误脱敏',async()=>{
   const only=await seed(false);await dispatch(only,'completed');await f.pool.query("UPDATE agent_run_dispatch SET state='done' WHERE run_id=$1",[only.run])
   const before=oldReflection;assert.equal(await service.remove(f.ownerId,only.s.id,legacy),true);assert.equal(oldReflection,before)
   const bad=await seed(false);await dispatch(bad,undefined,true);await f.pool.query('UPDATE agent_run_dispatch SET payload=$2 WHERE run_id=$1',[bad.run,Buffer.alloc(16)])
   await assert.rejects(service.remove(f.ownerId,bad.s.id,legacy),ImSessionDeleteUnavailable);assert.equal(oldReflection,before)
   const x=await seed()
   await f.pool.query(`CREATE FUNCTION reject_synthetic_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-private-delete-sql'; END $$;
     CREATE TRIGGER reject_synthetic_delete BEFORE DELETE ON conversation_sessions FOR EACH ROW EXECUTE FUNCTION reject_synthetic_delete()`)
   try{
    await assert.rejects(service.remove(f.ownerId,x.s.id,legacy),(error:unknown)=>error instanceof ImSessionDeleteUnavailable&&!String(error).includes('synthetic-private')&&!('cause'in error))
    assert.equal((await f.pool.query('SELECT 1 FROM conversation_messages WHERE id=$1',[x.m.id])).rowCount,1)
    assert.equal(await retired.seen(binding,x.payload),false)
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM gugu_im_history_retention_storage')).rows[0].n,0)
   }finally{await f.pool.query('DROP TRIGGER reject_synthetic_delete ON conversation_sessions;DROP FUNCTION reject_synthetic_delete()')}
  })
 }finally{await f.close()}
})
