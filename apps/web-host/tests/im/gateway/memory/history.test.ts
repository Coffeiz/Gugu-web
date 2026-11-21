import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {test} from 'node:test'
import type {PoolClient} from 'pg'
import {createImProductionFixture} from '../production.fixtures.js'
import {createImHistoryRetention,enqueueCleanupLocked,ImHistoryRetentionError} from '../../../../src/modules/im/gateway/memory/history.js'
import {createImRetiredInbound} from '../../../../src/modules/im/gateway/inbound/retired.js'
import {createPostgresChatAttachmentDraftDeletePorts} from '../../../../src/modules/agent/attachments/persistence.js'
import {createImInboundEnvelope} from '../../../../src/modules/im/gateway/inbound/envelope.js'
import {imConversationDigest,imConversationFingerprint,imConversationScopeHash} from '../../../../src/modules/im/gateway/agent/identity.js'

const url=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
test('非法owner/key/构造错误固定，未授权路径不进入FS或SQL',async()=>{
 const client={async query(){assert.fail('非法key不能入队')}} as unknown as PoolClient
 await assert.rejects(enqueueCleanupLocked(client,'00000000-0000-4000-8000-000000000001',['00000000-0000-4000-8000-000000000001/../other/file']),ImHistoryRetentionError)
 assert.throws(()=>createImHistoryRetention({} as never),ImHistoryRetentionError)
})
test('正式PG schema历史保留：有界裁剪/覆盖水位/引用完整批次/墓碑/事务与提交后安全FS回收',{
 skip:!(url&&python)&&'需显式隔离PG与离线ORM解释器，本地FS来自专用临时fixture',timeout:120000,
},async t=>{
 const f=await createImProductionFixture({databaseUrl:url,python:python!,platform:'telegram'}),{Pool}=await import('pg')
 const pool=new Pool({connectionString:url,options:`-c search_path=${f.schema} -c lock_timeout=2000`,max:2,connectionTimeoutMillis:2000})
 const retired=createImRetiredInbound({pool,secretKey:f.secretKey}),storage=createPostgresChatAttachmentDraftDeletePorts(pool,f.storageRoot)
 let pending:'clear'|'pending'|'unknown'='clear',failure=false,failKey:string|null=null
 const batches:number[][]=[],cleaned:string[]=[],diagnostics:string[]=[]
 const options={pool,deferMs:1,concurrency:2,
  async pendingAsk(client:PoolClient){await client.query('SELECT 1');return pending},
  async beforeRemoveLocked(client:PoolClient,owner:string,session:number,ids:readonly number[]){batches.push([...ids]);await retired.markLocked(client,owner,session,ids);if(failure)throw Error('synthetic-private-retention-error')},
  async removeIfUnreferenced(owner:string,key:string){
   const removed=[...new Set(batches.flat())]
   if(removed.length)assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_messages WHERE id=ANY($1::integer[])',[removed])).rows[0].n,0,'FS回收必须在消息delete已提交并对其他连接可见之后')
   if(key===failKey)throw Error('synthetic-private-file-error')
   cleaned.push(key);return storage.removeUnreferenced(owner,key)
  },diagnose:(code:string)=>diagnostics.push(code)}
 const retention=createImHistoryRetention(options)
 const binding={ownerId:f.ownerId,platform:'telegram' as const,botId:f.botId},envelope=createImInboundEnvelope(f.secretKey)
 async function seed(count=2005,cover:number|null=1000,owner=f.ownerId){
  const s=await f.insert('conversation_sessions',{user_id:owner,title:'合成历史保留目标',source:'telegram',bot_id:f.botId,chat_type:'group',chat_id:`synthetic-group-${randomUUID()}`,
   baseline_message_seq:0,last_message_seq:count+(cover===null?0:1),execution_state:'idle',pending_message_count:0})
  const rows=(await pool.query<{id:number;conversation_seq:string}>(`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,created_at,sent_at)
   SELECT $1,n,'user','合成消息'||n,timestamptz '2001-01-01'+n*interval '1 second',timestamptz '2001-01-01'+n*interval '1 second' FROM generate_series(1,$2) n RETURNING id,conversation_seq::text`,[s.id,count])).rows
  if(cover!==null)await f.insert('conversation_messages',{session_id:s.id,conversation_seq:count+1,role:'summary',content:'合成摘要',covers_until_seq:cover})
  const bySeq=(seq:number)=>rows.find(row=>Number(row.conversation_seq)===seq)!.id
  function payload(seq:number){return{...binding,owner_user_id:owner,bot_id:f.botId,channel_id:f.botId,chat_type:'group',chat_id:s.chat_id,platform_user_id:'202',message_id:String(seq),platform_message_id:String(seq),text:`合成消息${seq}`,attachments:[]}}
  async function receipt(seq:number,runId=`synthetic-history-${seq}`){const p=payload(seq),scope=imConversationScopeHash(f.secretKey,{...binding,ownerId:owner},p)
   await pool.query(`INSERT INTO gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,session_id,message_id,state,run_id,sealed_payload)
    VALUES($1,'telegram',$2,'group',$3,$4,$5,$6,$7,'dispatched',$8,$9) ON CONFLICT DO NOTHING`,[owner,f.botId,scope,imConversationDigest(f.secretKey,[scope,'202',String(seq)]),
    imConversationFingerprint(f.secretKey,scope,p,[]),s.id,bySeq(seq),runId,envelope.seal({...binding,ownerId:owner},p)])
  }
  await receipt(1);if(count!==1)await receipt(count)
  return{s,rows,bySeq,payload,receipt,runId:`synthetic-history-${count}`,async count(){return Number((await pool.query('SELECT count(*)::text AS n FROM conversation_messages WHERE session_id=$1',[s.id])).rows[0].n)}}
 }
 async function attachment(session:number,message:number,key:string,id:string,extra:Record<string,unknown>={}){
  await mkdir(dirname(join(f.storageRoot,key)),{recursive:true});await writeFile(join(f.storageRoot,key),'synthetic-bytes')
  await f.insert('chat_attachments',{user_id:f.ownerId,attach_id:id,message_id:message,storage_key:key,platform:'telegram',state:'attached',size:15,name:'合成附件',ext:'bin',mime:'application/octet-stream',kind:'file',extra})
 }
 async function checkpoint(session:number,run:string,status:string){await f.insert('agent_run_checkpoints',{user_id:f.ownerId,session_id:session,run_id:run,version:1,sequence:1,status,phase:'idle',nonce:Buffer.alloc(12),payload:Buffer.alloc(16)})}
 try{
  await t.test('Node可信目标与generation同事务；2602条按500/102收敛2000，永久墓碑随delete提交',async()=>{
   const target=await seed(2601,1000),foreign=await seed(2601,1000,f.otherOwnerId)
   const client=await pool.connect();try{await client.query('BEGIN');await retention.touchLocked(client,{ownerId:f.ownerId,sessionId:String(target.s.id),runId:target.runId});await client.query('ROLLBACK')}finally{client.release()}
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_im_history_retention_targets')).rows[0].n,0)
   await assert.rejects(retention.schedule(f.otherOwnerId,target.s.id),ImHistoryRetentionError)
   await retention.schedule(f.ownerId,target.s.id)
   const offset=batches.length,first=await retention.scan();assert.equal(first.messages,500);assert.equal(await target.count(),2102)
   const second=await retention.scan();assert.equal(second.messages,102);assert.equal(await target.count(),2000)
   assert.deepEqual(batches.slice(offset).map(ids=>ids.length),[500,102]);assert.equal(await foreign.count(),2602)
   assert.equal(await retired.seen(binding,target.payload(1)),true)
   const job=(await pool.query('SELECT generation,completed_generation FROM gugu_im_history_retention_targets WHERE session_id=$1',[target.s.id])).rows[0]
   assert.equal(job.generation,job.completed_generation);assert.equal((await retention.scan()).messages,0)
  })
  await t.test('无summary不删；最新summary为准、0回退session baseline、pending/uncovered/summary保留并按anchor排序',async()=>{
   const missing=await seed(2005,null);await retention.schedule(f.ownerId,missing.s.id);assert.equal((await retention.scan()).messages,0);assert.equal(await missing.count(),2005)
   const target=await seed(2005,1000)
   await f.insert('conversation_messages',{session_id:target.s.id,conversation_seq:2007,role:'summary',content:'最新零覆盖摘要',covers_until_seq:0})
   await pool.query('UPDATE conversation_sessions SET baseline_message_seq=3 WHERE id=$1',[target.s.id])
   await pool.query("UPDATE conversation_messages SET run_id='im-pending:synthetic' WHERE id=$1",[target.bySeq(2)])
   await pool.query('UPDATE conversation_messages SET history_anchor_seq=1 WHERE id=$1',[target.bySeq(2005)])
   await retention.schedule(f.ownerId,target.s.id);assert.equal((await retention.scan()).messages,3)
   const kept=(await pool.query('SELECT id,role FROM conversation_messages WHERE session_id=$1',[target.s.id])).rows
   assert.ok(kept.some(row=>row.id===target.bySeq(2)));assert.ok(kept.some(row=>row.id===target.bySeq(4)))
   assert.ok(!kept.some(row=>row.id===target.bySeq(2005)));assert.equal(kept.filter(row=>row.role==='summary').length,2)
  })
  await t.test('非idle/未来checkpoint/queued/started/prompt/反思/未知投递及pending未知均整session延期',async()=>{
   const cases:Array<[string,(target:Awaited<ReturnType<typeof seed>>)=>Promise<unknown>]>= [
    ['future-session',x=>pool.query("UPDATE conversation_sessions SET execution_state='future-state' WHERE id=$1",[x.s.id])],
    ['future-checkpoint',x=>checkpoint(x.s.id,'synthetic-future','future-status')],
    ['waiting',x=>checkpoint(x.s.id,'synthetic-waiting','waiting')],
    ['queued',x=>pool.query(`INSERT INTO agent_run_dispatch(user_id,session_id,run_id,state,message_id,nonce,payload,request_expires_at)
      VALUES($1,$2,'synthetic-queued','queued',$3,$4,$5,now()+interval '1 hour')`,[f.ownerId,x.s.id,x.bySeq(2005),Buffer.alloc(12),Buffer.alloc(16)])],
    ['staged',x=>pool.query("UPDATE gugu_im_inbound_receipts SET state='staged',run_id=NULL WHERE session_id=$1",[x.s.id])],
    ['active-prompt',x=>f.insert('interaction_prompts',{user_id:f.ownerId,session_id:x.s.id,status:'active',expires_at:'2000-01-01T00:00:00Z'})],
    ['reflection',x=>pool.query(`INSERT INTO gugu_im_reflection_jobs(id,user_id,session_id,run_id,scope_hash,scope_version,state,nonce,payload)
      VALUES($1,$2,$3,'synthetic-reflection',$4,0,'prepared',$5,$6)`,[randomUUID(),f.ownerId,x.s.id,'a'.repeat(64),Buffer.alloc(12),Buffer.alloc(16)])],
    ['reflection-window',x=>pool.query(`INSERT INTO gugu_im_reflection_trigger_windows(id,user_id,session_id,owner_revision,through_message_id,through_message_seq,scope_versions,reason)
      VALUES($1,$2,$3,0,$4,2005,'{}'::jsonb,'threshold')`,[randomUUID(),f.ownerId,x.s.id,x.bySeq(2005)])],
    ['unknown-delivery',async x=>{await pool.query("INSERT INTO gugu_im_run_delivery VALUES($1,$2,'synthetic-delivery',0)",[f.ownerId,x.s.id]);await pool.query("INSERT INTO gugu_im_delivery_receipts VALUES($1,$2,'synthetic-delivery','final',$3,'unknown',$4)",[f.ownerId,x.s.id,'a'.repeat(64),randomUUID()])}],
    ['unknown-tool',x=>pool.query("INSERT INTO gugu_im_file_tool_receipts VALUES($1,$2,'synthetic-tool',$3,'unknown',$4)",[f.ownerId,x.s.id,'a'.repeat(64),randomUUID()])],
    ['pending-redis',async()=>{pending='pending'}],['unknown-redis',async()=>{pending='unknown'}],
   ]
   for(const[label,prepare]of cases){const target=await seed();await prepare(target);await retention.schedule(f.ownerId,target.s.id)
    const result=await retention.scan();assert.equal(result.messages,0,label);assert.equal(result.deferred,1,label);assert.equal(await target.count(),2006,label)
    pending='clear';await pool.query('DELETE FROM conversation_sessions WHERE id=$1',[target.s.id])}
  })
  await t.test('Node事件以delivery cursor为准，Web/legacy事件以ack为准，不永久误阻塞Node未ack事件',async()=>{
   for(const node of[false,true]){
    const target=await seed(),run=node?target.runId:'synthetic-web-run';await checkpoint(target.s.id,run,'completed')
    await f.insert('agent_run_events',{user_id:f.ownerId,session_id:target.s.id,run_id:run,event_id:'synthetic-event',sequence:1,nonce:Buffer.alloc(12),payload:Buffer.alloc(16)})
    await retention.schedule(f.ownerId,target.s.id);assert.equal((await retention.scan()).deferred,1)
    if(node){await pool.query('INSERT INTO gugu_im_run_delivery VALUES($1,$2,$3,1)',[f.ownerId,target.s.id,run]);await pool.query('DELETE FROM gugu_im_inbound_receipts WHERE session_id=$1 AND run_id=$2',[target.s.id,run])}
    else await pool.query('UPDATE agent_run_events SET acknowledged_at=clock_timestamp() WHERE user_id=$1 AND session_id=$2',[f.ownerId,target.s.id])
    await retention.schedule(f.ownerId,target.s.id);assert.equal((await retention.scan()).messages,6)
   }
  })
  await t.test('startup pending只在没有checkpoint时保护；真实终态checkpoint允许裁剪',async()=>{
   const target=await seed(),run='synthetic-startup-checkpoint'
   await pool.query("INSERT INTO agent_run_startups VALUES($1,$2,$3,'pending',now(),now())",[f.ownerId,target.s.id,run])
   await retention.schedule(f.ownerId,target.s.id);assert.equal((await retention.scan()).deferred,1);assert.equal(await target.count(),2006)
   await checkpoint(target.s.id,run,'completed')
   await retention.schedule(f.ownerId,target.s.id);assert.equal((await retention.scan()).messages,6);assert.equal(await target.count(),2000)
   assert.equal((await pool.query('SELECT status FROM agent_run_startups WHERE session_id=$1',[target.s.id])).rows[0].status,'pending')
  })
  await t.test('reuse源SHARE锁与trim附件锁串行；未claim有效draft及跨Session语音引用保护整批，TTL后恢复裁剪',async()=>{
   const target=await seed(2010),sourceRun='synthetic-draft-source',scope='synthetic-draft-scope'
   for(const seq of[1,2]){await pool.query('UPDATE conversation_messages SET run_id=$2 WHERE id=$1',[target.bySeq(seq),sourceRun]);await target.receipt(seq,sourceRun)}
   await pool.query('UPDATE gugu_im_inbound_receipts SET run_id=$2 WHERE message_id=ANY($1::integer[])',[[target.bySeq(1),target.bySeq(2)],sourceRun])
   const key=`${f.ownerId}/.chat_staging/draft-reference.bin`
   await attachment(target.s.id,target.bySeq(1),key,'synthetic-lock-source',{quoted:false,im_ingress_scope:scope})
   await pool.query("UPDATE chat_attachments SET kind='voice' WHERE attach_id='synthetic-lock-source'")
   await retention.schedule(f.ownerId,target.s.id)
   const reuse=await pool.connect();let scanning:Promise<unknown>|null=null
   try{
    await reuse.query('BEGIN');const pid=(await reuse.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await reuse.query("SELECT attach_id FROM chat_attachments WHERE attach_id='synthetic-lock-source' FOR SHARE")
    scanning=retention.scan()
    // 观察真实锁等待后才提交clone，避免固定sleep猜测竞态是否出现。
    for(let n=0;;n++){
     const blocked=(await f.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount
     if(blocked)break;if(n>1000)assert.fail('trim未等待reuse附件锁');await new Promise<void>(resolve=>setImmediate(resolve))
    }
    await reuse.query(`INSERT INTO chat_attachments(attach_id,user_id,storage_key,platform,name,ext,mime,kind,size,state,extra,created_at)
      SELECT 'synthetic-lock-draft',user_id,storage_key,platform,name,ext,mime,kind,size,'draft',extra::jsonb||'{"quoted":true}'::jsonb,clock_timestamp()
      FROM chat_attachments WHERE attach_id='synthetic-lock-source'`)
    await reuse.query('COMMIT');await scanning
   }finally{await reuse.query('ROLLBACK');reuse.release()}
   for(const seq of[1,2])assert.equal((await pool.query('SELECT 1 FROM conversation_messages WHERE id=$1',[target.bySeq(seq)])).rowCount,1)
   const other=await seed(1,null)
   await pool.query("UPDATE chat_attachments SET state='attached',message_id=$1 WHERE attach_id='synthetic-lock-draft'",[other.bySeq(1)])
   await retention.schedule(f.ownerId,target.s.id);assert.equal((await retention.scan()).messages,0,'另一会话仍引用时保护原完整Run')
   await pool.query("UPDATE chat_attachments SET state='draft',message_id=NULL,created_at=clock_timestamp()-interval '25 hours' WHERE attach_id='synthetic-lock-draft'")
   await retention.schedule(f.ownerId,target.s.id);assert.equal((await retention.scan()).messages,2)
   await pool.query('DELETE FROM conversation_sessions WHERE id=$1',[other.s.id])
  })
  await t.test('引用语音保留区保护原sourceRun全部锚点，和引用自身Run其他锚点；其余covered仍裁剪',async()=>{
   const target=await seed(2010,1000),sourceRun='synthetic-full-source',quoteRun='synthetic-full-quote',scope='synthetic-same-ingress-scope'
   for(const seq of[1,2]){await pool.query('UPDATE conversation_messages SET run_id=$2 WHERE id=$1',[target.bySeq(seq),sourceRun]);await target.receipt(seq,sourceRun)}
   await pool.query('UPDATE gugu_im_inbound_receipts SET run_id=$2 WHERE message_id=ANY($1::integer[])',[[target.bySeq(1),target.bySeq(2)],sourceRun])
   await pool.query('UPDATE conversation_messages SET run_id=$2 WHERE id=ANY($1::integer[])',[[target.bySeq(3),target.bySeq(2010)],quoteRun]);await target.receipt(3,quoteRun)
   await pool.query('UPDATE gugu_im_inbound_receipts SET run_id=$2 WHERE message_id=$1',[target.bySeq(2010),quoteRun])
   const key=`${f.ownerId}/.chat_staging/quoted-source.bin`
   await attachment(target.s.id,target.bySeq(1),key,'synthetic-source-voice',{im_ingress_scope:scope,quoted:false})
   await attachment(target.s.id,target.bySeq(2010),key,'synthetic-quoted-voice',{im_ingress_scope:scope,quoted:true})
   await pool.query("UPDATE chat_attachments SET kind='voice' WHERE user_id=$1 AND storage_key=$2",[f.ownerId,key])
   await retention.schedule(f.ownerId,target.s.id);const result=await retention.scan();assert.equal(result.messages,8)
   const kept=(await pool.query('SELECT id FROM conversation_messages WHERE session_id=$1',[target.s.id])).rows.map(row=>row.id)
   for(const seq of[1,2,3,2010])assert.ok(kept.includes(target.bySeq(seq)),`完整引用依赖锚点${seq}`)
   assert.ok(!kept.includes(target.bySeq(4)));assert.equal((await readFile(join(f.storageRoot,key))).toString(),'synthetic-bytes')
  })
  await t.test('最早剩余非summary时间严格裁已完结交互；active即使过期也先整session保护',async()=>{
   const target=await seed(),ids:number[]=[]
   for(const status of['resolved','expired','cancelled'])ids.push((await f.insert('interaction_prompts',{user_id:f.ownerId,session_id:target.s.id,status,created_at:'2000-01-01T00:00:00Z',expires_at:'2000-01-02T00:00:00Z'})).id)
   const active=await f.insert('interaction_prompts',{user_id:f.ownerId,session_id:target.s.id,status:'active',created_at:'1999-01-01T00:00:00Z',expires_at:'2000-01-01T00:00:00Z'})
   const boundary=(await pool.query('SELECT created_at FROM conversation_messages WHERE id=$1',[target.bySeq(7)])).rows[0].created_at
   const exact=await f.insert('interaction_prompts',{user_id:f.ownerId,session_id:target.s.id,status:'resolved',created_at:boundary,expires_at:boundary})
   await retention.schedule(f.ownerId,target.s.id);assert.equal((await retention.scan()).deferred,1)
   assert.equal((await pool.query('SELECT id FROM interaction_prompts WHERE id=$1',[active.id])).rowCount,1)
   await pool.query("UPDATE interaction_prompts SET status='cancelled' WHERE id=$1",[active.id]);await retention.schedule(f.ownerId,target.s.id)
   const result=await retention.scan();assert.equal(result.messages,6);assert.equal(result.interactions,4)
   assert.equal((await pool.query('SELECT id FROM interaction_prompts WHERE id=$1',[exact.id])).rowCount,1)
  })
  await t.test('删除失败时墓碑/附件/消息同回滚；提交后才实际FS回收，共享引用保留，失败队列可重启重试',async()=>{
   const target=await seed(),keys=['orphan','shared','retry'].map(name=>`${f.ownerId}/.chat_staging/${name}.bin`)
   for(const[index,key]of keys.entries())await attachment(target.s.id,target.bySeq(index+1),key,`synthetic-old-${index}`)
   await attachment(target.s.id,target.bySeq(2005),keys[1]!,'synthetic-shared-survivor')
   failure=true;await retention.schedule(f.ownerId,target.s.id);await assert.rejects(retention.scan(),ImHistoryRetentionError)
   assert.equal(await target.count(),2006);assert.equal(await retired.seen(binding,target.payload(1)),false)
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_im_history_retention_storage')).rows[0].n,0)
   assert.ok(await readFile(join(f.storageRoot,keys[0]!)))
   failure=false;failKey=keys[2]!;await retention.schedule(f.ownerId,target.s.id);assert.equal((await retention.scan()).messages,6)
   await assert.rejects(readFile(join(f.storageRoot,keys[0]!)),{code:'ENOENT'});assert.ok(await readFile(join(f.storageRoot,keys[1]!)))
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_im_history_retention_storage')).rows[0].n,1)
   failKey=null;await pool.query('UPDATE gugu_im_history_retention_storage SET next_attempt_at=clock_timestamp()');assert.equal(await retention.processCleanup(),1)
   await assert.rejects(readFile(join(f.storageRoot,keys[2]!)),{code:'ENOENT'});assert.equal(diagnostics.some(code=>code.includes('synthetic-private')),false)
  })
  await t.test('quota共用FS队列不随session消失，回滚无回收；新generation不被旧回收CAS吞掉',async()=>{
   const target=await seed(1,null),key=`${f.ownerId}/.chat_staging/after-session.bin`;await mkdir(dirname(join(f.storageRoot,key)),{recursive:true});await writeFile(join(f.storageRoot,key),'synthetic')
   const client=await pool.connect();try{await client.query('BEGIN');await enqueueCleanupLocked(client,f.ownerId,[key]);await client.query('ROLLBACK')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_im_history_retention_storage')).rows[0].n,0)
    await client.query('BEGIN');await enqueueCleanupLocked(client,f.ownerId,[key]);await client.query('DELETE FROM conversation_sessions WHERE id=$1',[target.s.id]);await client.query('COMMIT')
   }finally{client.release()}
   assert.equal(await retention.processCleanup(),1);await assert.rejects(readFile(join(f.storageRoot,key)),{code:'ENOENT'})
   await enqueueCleanupLockedForTest(key)
   let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve)
   const guarded=createImHistoryRetention({...options,async removeIfUnreferenced(){entered();await gate;return true}})
   try{const cleaning=guarded.processCleanup();await started;await enqueueCleanupLockedForTest(key);release();await cleaning
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gugu_im_history_retention_storage')).rows[0].n,1)
    await retention.processCleanup()
   }finally{release?.();await guarded.close()}
   async function enqueueCleanupLockedForTest(value:string){const tx=await pool.connect();try{await tx.query('BEGIN');await enqueueCleanupLocked(tx,f.ownerId,[value]);await tx.query('COMMIT')}finally{tx.release()}}
  })
  await t.test('两个scanner/两连接池并发不重复裁剪，close中断后drain真实事务且不留下半份墓碑',async()=>{
   const a=await seed(),b=await seed();await retention.schedule(f.ownerId,a.s.id);await retention.schedule(f.ownerId,b.s.id)
   const other=createImHistoryRetention(options),offset=batches.length
   try{const results=await Promise.all([retention.scan(),other.scan()]);assert.equal(results.reduce((sum,row)=>sum+row.messages,0),12)
    const all=batches.slice(offset).flat();assert.equal(new Set(all).size,all.length);assert.equal(await a.count(),2000);assert.equal(await b.count(),2000)
   }finally{await other.close()}
   const target=await seed();await retention.schedule(f.ownerId,target.s.id)
   let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve)
   const closing=createImHistoryRetention({...options,async beforeRemoveLocked(client:PoolClient,owner:string,session:number,ids:readonly number[]){await retired.markLocked(client,owner,session,ids);entered();await gate}})
   const scan=closing.scan();await started;const close=closing.close();release();await assert.rejects(scan,ImHistoryRetentionError);await close
   assert.equal(await target.count(),2006);assert.equal(await retired.seen(binding,target.payload(1)),false)
   await assert.rejects(closing.scan(),ImHistoryRetentionError)
  })
 }finally{await retention.close();await pool.end();await f.close()}
})
