import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import type {PoolClient} from 'pg'
import {createImProductionFixture} from './production.fixtures.js'
import {createImSessionRetention,ImSessionRetentionError} from '../../../src/modules/im/gateway/session-retention.js'
import {createPostgresWebChatSession} from '../../../src/modules/agent-sessions/persistence/agent-chat-preparation.js'

const ready=!!process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL&&!!process.env.GUGU_IM_FIXTURE_PYTHON
test('真实PG会话限额：同事务回滚/终端与附件原子性、全部活跃边界、owner竞争与SKIPLOCKED',{
 skip:ready?false:'需显式隔离PG和Python真实ORM解释器',timeout:120000,
},async t=>{
 const f=await createImProductionFixture({python:process.env.GUGU_IM_FIXTURE_PYTHON!})
 try{
  // 仅代替root尚在装配的永久HMAC墓碑服务；真实写库证明同事务顺序与回滚，不冒充其生产codec。
  await f.pool.query('CREATE TABLE synthetic_retired_sessions(owner_id uuid,session_id integer PRIMARY KEY)')
  const retention=createImSessionRetention({async beforeDeleteLocked(client,ownerId,sessionId){
   await client.query('INSERT INTO synthetic_retired_sessions VALUES($1,$2)',[ownerId,sessionId])
  }})
  async function reset(count=50){
   await f.pool.query('DELETE FROM conversation_sessions WHERE user_id=$1',[f.ownerId])
   await f.pool.query('DELETE FROM synthetic_retired_sessions')
   const ids:number[]=[]
   for(let i=0;i<count;i++){
    const row=await f.insert('conversation_sessions',{user_id:f.ownerId,title:'合成保留会话',source:i%2?'web':'telegram',bot_id:i%2?null:f.botId,
     chat_type:i%2?null:'group',chat_id:i%2?null:`old-peer-${i}`,updated_at:new Date(Date.UTC(2020,0,1)+Math.max(0,i-1)*1000).toISOString()})
    ids.push(row.id)
   }
   return ids
  }
  async function insertNew(client:PoolClient,peer:string){
   return (await client.query(`INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,bot_id,chat_id,platform_user_id,chat_type,
    context_epoch,baseline_message_seq,last_message_seq,execution_state,pending_message_count,created_at,updated_at)
    VALUES($1,'合成新增会话',false,'','telegram',$2,$3,NULL,'group',1,0,0,'idle',0,clock_timestamp(),clock_timestamp()) RETURNING id`,[f.ownerId,f.botId,peer])).rows[0]!.id
  }
  const count=async()=>Number((await f.pool.query('SELECT count(*)::text AS count FROM conversation_sessions WHERE user_id=$1',[f.ownerId])).rows[0]!.count)
  await f.insert('conversation_sessions',{user_id:f.otherOwnerId,title:'其他合成用户最旧会话',updated_at:'2000-01-01T00:00:00Z'})
  await t.test('最旧updated_at相同时按id稳定清理，返回keys但不在未提交时清FS；回滚恢复全体记录',async()=>{
   const ids=await reset(),sessionId=ids[0]!
   const message=await f.insert('conversation_messages',{session_id:sessionId,conversation_seq:1,role:'user',content:'合成待保留正文'})
   const key=`${f.ownerId}/.chat_staging/retention.bin`,file=join(f.storageRoot,key)
   await mkdir(dirname(file),{recursive:true});await writeFile(file,'synthetic')
   await f.insert('chat_attachments',{user_id:f.ownerId,message_id:message.id,attach_id:'synthetic-retention-file',storage_key:key,state:'attached',size:9})
   await f.insert('terminal_sessions',{id:'synthetic-agent-terminal',owner_id:f.ownerId,session_id:sessionId,source:'agent',status:'running'})
   await f.insert('terminal_sessions',{id:'synthetic-manual-terminal',owner_id:f.ownerId,session_id:sessionId,source:'user',status:'running'})
   const client=await f.pool.connect()
   try{
    await client.query('BEGIN')
    assert.deepEqual(await retention.beforeCreate(client,f.ownerId),{deleted:[{sessionId,storageKeys:[key]}]})
    assert.equal((await client.query('SELECT id FROM conversation_sessions WHERE id=$1',[sessionId])).rows.length,0)
    assert.equal((await f.pool.query('SELECT id FROM conversation_sessions WHERE id=$1',[sessionId])).rows.length,1)
    assert.equal((await readFile(file)).toString(),'synthetic')
    await client.query('ROLLBACK')
    assert.equal(await count(),50)
    assert.equal((await f.pool.query('SELECT * FROM synthetic_retired_sessions')).rowCount,0)
    assert.equal((await f.pool.query('SELECT id FROM chat_attachments WHERE message_id=$1',[message.id])).rowCount,1)
    await client.query('BEGIN')
    assert.deepEqual(await retention.beforeCreate(client,f.ownerId),{deleted:[{sessionId,storageKeys:[key]}]})
    await insertNew(client,'new-peer');await client.query('COMMIT')
    assert.equal(await count(),50)
    const terminals=(await f.pool.query('SELECT id,status,closed_at,session_id FROM terminal_sessions ORDER BY id')).rows
    assert.deepEqual(terminals.map(r=>[r.id,r.status,r.closed_at!==null,r.session_id]),[
     ['synthetic-agent-terminal','terminated',true,null],['synthetic-manual-terminal','running',false,null]])
    assert.equal((await readFile(file)).toString(),'synthetic')
    assert.equal((await f.pool.query('SELECT id FROM conversation_sessions WHERE user_id=$1',[f.otherOwnerId])).rows.length,1)
   }finally{client.release()}
  })

  await t.test('运行/排队/等待/交互/投递/反思与started消息逐项阻止最旧会话被删',async()=>{
   const ids=await reset(),old=ids[0]!,next=ids[1]!,client=await f.pool.connect(),run='synthetic-retention-run'
   async function message(){return Number((await client.query(`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,created_at)
    VALUES($1,1,'user','合成边界消息',clock_timestamp()) RETURNING id`,[old])).rows[0]!.id)}
   async function checkpoint(status:string){await client.query(`INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,version,sequence,status,phase,nonce,payload,created_at,updated_at)
    VALUES($1,$2,$3,1,1,$4,'synthetic',$5,$6,now(),now())`,[f.ownerId,old,run,status,Buffer.alloc(12),Buffer.alloc(16)])}
   async function event(){await checkpoint('completed');await client.query(`INSERT INTO agent_run_events(user_id,session_id,run_id,event_id,sequence,nonce,payload,created_at)
    VALUES($1,$2,$3,'synthetic-event',1,$4,$5,now())`,[f.ownerId,old,run,Buffer.alloc(12),Buffer.alloc(16)])}
   async function receipt(state:'staged'|'dispatched'){
    const id=await message();await client.query(`INSERT INTO gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,session_id,message_id,state,run_id,sealed_payload)
     VALUES($1,'telegram',$2,'group',$3,$3,$3,$4,$5,$6,$7,'{}')`,[f.ownerId,f.botId,'a'.repeat(64),old,id,state,state==='dispatched'?run:null])
    return id
   }
   async function intent(expiry:string){
    await checkpoint('completed');await client.query(`INSERT INTO agent_interaction_intents(user_id,session_id,run_id,interaction_id,tool_call_id,ciphertext,nonce,encrypted_data_key,key_version,expires_at)
     VALUES($1,$2,$3,'synthetic-interaction','synthetic-tool','synthetic-cipher','synthetic-nonce','synthetic-key',1,$4)`,[f.ownerId,old,run,expiry])
   }
   const cases:Array<[string,()=>Promise<unknown>]>= [
    ['active',()=>client.query("UPDATE conversation_sessions SET execution_state='running' WHERE id=$1",[old])],
    ['active-run-id',()=>client.query('UPDATE conversation_sessions SET active_run_id=$2 WHERE id=$1',[old,run])],
    ['pending-count',()=>client.query('UPDATE conversation_sessions SET pending_message_count=1 WHERE id=$1',[old])],
    ['live-lease',()=>client.query("INSERT INTO agent_run_leases VALUES($1,$2,$3,'synthetic-token',1,now()+interval '1 hour',now(),now())",[f.ownerId,old,run])],
    ['waiting',()=>checkpoint('waiting')],['unknown',()=>checkpoint('unknown')],
    ['startup',()=>client.query("INSERT INTO agent_run_startups VALUES($1,$2,$3,'pending',now(),now())",[f.ownerId,old,run])],
    ...(['queued','selected'] as const).map(state=>[state,async()=>{await client.query(`INSERT INTO agent_run_dispatch(user_id,session_id,run_id,state,message_id,nonce,payload,request_expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 hour')`,[f.ownerId,old,run,state,await message(),Buffer.alloc(12),Buffer.alloc(16)])}] as [string,()=>Promise<unknown>]),
    ['active-prompt',()=>client.query(`INSERT INTO interaction_prompts(user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at)
     VALUES($1,$2,'question','合成问题','','{}','active',now()+interval '1 hour',now())`,[f.ownerId,old])],
    ['trusted-intent',()=>intent('2099-01-01T00:00:00Z')],
    ['web-outbox',()=>event()],
    ['node-outbox',async()=>{await event();await receipt('dispatched')}],
    ['delivery-unknown',async()=>{await client.query('INSERT INTO gugu_im_run_delivery VALUES($1,$2,$3,1)',[f.ownerId,old,run]);
     await client.query(`INSERT INTO gugu_im_delivery_receipts VALUES($1,$2,$3,'synthetic-final',$4,'unknown',$5)`,[f.ownerId,old,run,'b'.repeat(64),randomUUID()])}],
    ['reflection',()=>client.query(`INSERT INTO gugu_im_reflection_jobs(id,user_id,session_id,run_id,scope_hash,scope_version,state,nonce,payload)
     VALUES($1,$2,$3,$4,$5,0,'pending',$6,$7)`,[randomUUID(),f.ownerId,old,run,'c'.repeat(64),Buffer.alloc(12),Buffer.alloc(16)])],
    ['reflection-window',async()=>client.query(`INSERT INTO gugu_im_reflection_trigger_windows(id,user_id,session_id,owner_revision,through_message_id,through_message_seq,scope_versions,reason)
      VALUES($1,$2,$3,0,$4,1,'{}'::jsonb,'threshold')`,[randomUUID(),f.ownerId,old,await message()])],
    ['python-reflection',async()=>{const id=await message();await client.query(`INSERT INTO memory_reflection_jobs(owner_user_id,platform,bot_id,scope_type,scope_id,from_message_id,to_message_id,
     idempotency_key,extractor_version,task_type,reason,status,retry_count,created_at,updated_at)
     VALUES($1,'telegram',$2,'group','synthetic-group',$3,$3,'synthetic-reflection','im-memory-v1','group','idle','pending',0,now(),now())`,[f.ownerId,f.botId,id])}],
    ['staged',()=>receipt('staged')],
    ['started-segment',async()=>{const id=await message();await client.query(`INSERT INTO gugu_im_inbound_segments(user_id,platform,bot_id,chat_type,scope_hash,segment_key,batch_key,segment_index,
     session_id,state,mode,run_id,anchors,sealed_payload) VALUES($1,'telegram',$2,'group',$3,$3,$3,0,$4,'started','dispatch',NULL,$5::jsonb,'{}')`,
     [f.ownerId,f.botId,'c'.repeat(64),old,JSON.stringify([{sessionId:old,messageId:id,conversationSeq:1}])])}],
    ['file-tool-unknown',()=>client.query(`INSERT INTO gugu_im_file_tool_receipts VALUES($1,$2,$3,$4,'unknown',$5)`,[f.ownerId,old,run,'d'.repeat(64),randomUUID()])],
    ['reaction-unknown',()=>client.query(`INSERT INTO gugu_im_reaction_receipts VALUES($1,$2,$3,$4,$4,$5,'unknown')`,[f.ownerId,old,run,'d'.repeat(64),randomUUID()])],
   ]
   try{
    for(const [label,prepare]of cases){
     await client.query('BEGIN')
     try{await prepare();assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted[0]?.sessionId,next,label)}
     finally{await client.query('ROLLBACK')}
    }
    // 正式startup只有pending/failed；成功运行的权威终态在checkpoint，不会回写success枚举。
    for(const status of ['completed','failed','cancelled']){
     await client.query('BEGIN');await checkpoint(status)
     await client.query("INSERT INTO agent_run_startups VALUES($1,$2,$3,'pending',now(),now())",[f.ownerId,old,run])
     assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted[0]?.sessionId,old,`pending startup + ${status} checkpoint可删`)
     await client.query('ROLLBACK')
    }
    // Node送达的完成证据是持久cursor，不是Web SSE的acknowledged_at。
    await client.query('BEGIN');await event();await receipt('dispatched')
    await client.query('INSERT INTO gugu_im_run_delivery VALUES($1,$2,$3,1)',[f.ownerId,old,run])
    assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted[0]?.sessionId,old)
    await client.query('ROLLBACK')
    // 历史trim可删除消息和其receipt；持久Node投递cursor仍能区分Web SSE ack语义。
    await client.query('BEGIN');await event();await receipt('dispatched')
    await client.query('INSERT INTO gugu_im_run_delivery VALUES($1,$2,$3,1)',[f.ownerId,old,run])
    await client.query('DELETE FROM gugu_im_inbound_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3',[f.ownerId,old,run])
    assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted[0]?.sessionId,old,'无旧receipt但cursor覆盖全部outbox时可删')
    await client.query('ROLLBACK')
    await client.query('BEGIN');await event()
    await client.query('INSERT INTO gugu_im_run_delivery VALUES($1,$2,$3,0)',[f.ownerId,old,run])
    assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted[0]?.sessionId,next,'无旧receipt且Node cursor落后时仍保护')
    await client.query('ROLLBACK')
    await client.query('BEGIN');await intent('2000-01-01T00:00:00Z')
    assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted[0]?.sessionId,old,'已无法claim的过期意图不永久阻塞保留')
    await client.query('ROLLBACK')
   }finally{client.release()}
  })

  await t.test('另一保留会话的引用语音保护原来源，引用删除后才可删原会话',async()=>{
   const ids=await reset(),source=ids[0]!,quoted=ids[1]!,key=`${f.ownerId}/.chat_staging/quoted-voice.ogg`
   const sourceMessage=await f.insert('conversation_messages',{session_id:source,conversation_seq:1,role:'user',content:'合成语音来源'})
   const quoteMessage=await f.insert('conversation_messages',{session_id:quoted,conversation_seq:1,role:'user',content:'合成引用语音'})
   await f.insert('chat_attachments',{user_id:f.ownerId,message_id:sourceMessage.id,attach_id:'synthetic-source-voice',storage_key:key,
    state:'attached',kind:'voice',platform:'telegram',extra:{im_ingress_scope:'synthetic-voice-scope',quoted:false}})
   await f.insert('chat_attachments',{user_id:f.ownerId,message_id:quoteMessage.id,attach_id:'synthetic-quoted-voice',storage_key:key,
    state:'attached',kind:'audio',platform:'telegram',extra:{im_ingress_scope:'synthetic-voice-scope',quoted:true}})
   const client=await f.pool.connect()
   try{
    await client.query('BEGIN')
    assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted[0]?.sessionId,quoted,'跳过被跨会话引用的原source Session')
    await client.query('ROLLBACK')
    await f.pool.query("DELETE FROM chat_attachments WHERE attach_id='synthetic-quoted-voice' AND user_id=$1",[f.ownerId])
    await client.query('BEGIN')
    assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted[0]?.sessionId,source,'引用删除后原来源恢复可删')
    await client.query('ROLLBACK')
    // 相同storage_key的另一scope附件不能阻止原scope保留策略。
    await f.insert('chat_attachments',{user_id:f.ownerId,message_id:quoteMessage.id,attach_id:'synthetic-other-scope-voice',storage_key:key,
     state:'attached',kind:'voice',platform:'telegram',extra:{im_ingress_scope:'synthetic-other-scope',quoted:true}})
    await client.query('BEGIN')
    assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted[0]?.sessionId,source)
    await client.query('ROLLBACK')
    await f.pool.query("UPDATE chat_attachments SET platform='qq',extra=$2::json WHERE user_id=$1 AND attach_id='synthetic-other-scope-voice'",
     [f.ownerId,JSON.stringify({im_ingress_scope:'synthetic-voice-scope',quoted:true})])
    await client.query('BEGIN')
    assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted[0]?.sessionId,source,'不同platform不形成原来源依赖')
    await client.query('ROLLBACK')
   }finally{await client.query('ROLLBACK');client.release()}
  })

  await t.test('reuse持原附件SHARE期间quota等待，draft提交后以新快照拒删原来源',async()=>{
   const ids=await reset(),source=ids[0]!,message=await f.insert('conversation_messages',{session_id:source,conversation_seq:1,role:'user',content:'合成并发语音来源'})
   await f.insert('chat_attachments',{user_id:f.ownerId,message_id:message.id,attach_id:'synthetic-racing-source',
    storage_key:`${f.ownerId}/.chat_staging/racing.ogg`,state:'attached',kind:'voice',platform:'telegram',
    extra:{im_ingress_scope:'synthetic-racing-scope',quoted:false}})
   const clone=await f.pool.connect(),quota=await f.pool.connect()
   try{
    await clone.query('BEGIN');await quota.query('BEGIN')
    await clone.query("SET LOCAL statement_timeout='5s'");await quota.query("SET LOCAL statement_timeout='5s'")
    const clonePid=(await clone.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const quotaPid=(await quota.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    await clone.query("SELECT attach_id FROM chat_attachments WHERE user_id=$1 AND attach_id='synthetic-racing-source' FOR SHARE",[f.ownerId])
    const rejected=assert.rejects(retention.beforeCreate(quota,f.ownerId),error=>error instanceof ImSessionRetentionError&&error.code==='busy')
    let blocked=false
    for(let attempt=0;attempt<100;attempt++){
     blocked=(await f.pool.query('SELECT $1::integer=ANY(pg_blocking_pids($2)) AS blocked',[clonePid,quotaPid])).rows[0]!.blocked
     if(blocked)break
     await new Promise(resolve=>setTimeout(resolve,20))
    }
    assert.equal(blocked,true,'quota必须在原附件排他锁等待reuse事务')
    // 复用生产reuse的源SHARE→draft INSERT→COMMIT锁顺序；owner FK KEY SHARE不能与quota NO KEY UPDATE互锁。
    await clone.query(`INSERT INTO chat_attachments(user_id,attach_id,storage_key,state,kind,platform,extra,name,ext,mime,size,created_at)
     SELECT user_id,'synthetic-racing-quote',storage_key,'draft',kind,platform,
      jsonb_set(extra::jsonb,'{quoted}','true')::json,name,ext,mime,size,clock_timestamp()
     FROM chat_attachments WHERE user_id=$1 AND attach_id='synthetic-racing-source'`,[f.ownerId])
    await clone.query('COMMIT');await rejected;await quota.query('ROLLBACK')
    assert.equal((await f.pool.query('SELECT id FROM conversation_sessions WHERE id=$1',[source])).rowCount,1)
    assert.equal((await f.pool.query('SELECT * FROM synthetic_retired_sessions')).rowCount,0,'拒删前不得写永久墓碑')
    await quota.query('BEGIN')
    assert.equal((await retention.beforeCreate(quota,f.ownerId)).deleted[0]?.sessionId,ids[1],'有效draft也应在候选阶段跳过原来源')
    await quota.query('ROLLBACK')
    await f.pool.query("UPDATE chat_attachments SET created_at=clock_timestamp()-interval '25 hours' WHERE user_id=$1 AND attach_id='synthetic-racing-quote'",[f.ownerId])
    await quota.query('BEGIN')
    assert.equal((await retention.beforeCreate(quota,f.ownerId)).deleted[0]?.sessionId,source,'过期draft不永久保护原来源')
    await quota.query('ROLLBACK')
   }finally{await clone.query('ROLLBACK');await quota.query('ROLLBACK');clone.release();quota.release()}
  })

  await t.test('49可建、50无可删项拒绝，既有52每次只替换1条不批量清空',async()=>{
   let ids=await reset(49),client=await f.pool.connect()
   try{await client.query('BEGIN');assert.deepEqual(await retention.beforeCreate(client,f.ownerId),{deleted:[]});await insertNew(client,'below-limit');await client.query('COMMIT')}
   finally{client.release()}
   assert.equal(await count(),50)
   await f.pool.query("UPDATE conversation_sessions SET execution_state='waiting' WHERE user_id=$1",[f.ownerId])
   client=await f.pool.connect()
   try{await client.query('BEGIN');await assert.rejects(retention.beforeCreate(client,f.ownerId),error=>error instanceof ImSessionRetentionError&&error.code==='capacity');await client.query('ROLLBACK')}
   finally{client.release()}
   assert.equal(await count(),50)
   ids=await reset(52);client=await f.pool.connect()
   try{await client.query('BEGIN');assert.equal((await retention.beforeCreate(client,f.ownerId)).deleted.length,1);await insertNew(client,'historically-over-limit');await client.query('COMMIT')}
   finally{client.release()}
   assert.equal(await count(),52);assert.equal((await f.pool.query('SELECT id FROM conversation_sessions WHERE id=$1',[ids[0]])).rowCount,0)
  })

  await t.test('Web与IM创建共享owner锁，提交后重读数量；竞争回滚不影响其他owner',async()=>{
   const ids=await reset(49),web=await f.pool.connect(),im=await f.pool.connect()
   try{
    await web.query('BEGIN');await im.query('BEGIN')
    const webId=await createPostgresWebChatSession(web,f.ownerId,'合成Web新增')
    assert.equal(await count(),49,'未提交Web会话对其他事务不可见')
    await assert.rejects(retention.beforeCreate(im,f.ownerId),error=>error instanceof ImSessionRetentionError&&error.code==='busy')
    await im.query('ROLLBACK');await im.query('BEGIN')
    const other=await createPostgresWebChatSession(im,f.otherOwnerId,'合成其他owner')
    await im.query('ROLLBACK')
    assert.equal((await f.pool.query('SELECT id FROM conversation_sessions WHERE id=$1',[other])).rowCount,0)
    await web.query('COMMIT');assert.equal(await count(),50)
    await im.query('BEGIN')
    assert.equal((await retention.beforeCreate(im,f.ownerId)).deleted[0]?.sessionId,ids[0])
    await insertNew(im,'web-race-im');await im.query('COMMIT')
    assert.equal(await count(),50)
    assert.equal((await f.pool.query('SELECT id FROM conversation_sessions WHERE id=$1',[webId])).rowCount,1)

    await im.query('BEGIN');await retention.beforeCreate(im,f.ownerId)
    await web.query('BEGIN')
    await assert.rejects(createPostgresWebChatSession(web,f.ownerId,'合成冲突回滚'),error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='55P03')
    await web.query('ROLLBACK');await im.query('ROLLBACK')
    assert.equal(await count(),50,'两侧回滚不遗留删除或新会话')
    await web.query('BEGIN')
    const retry=await createPostgresWebChatSession(web,f.ownerId,'合成重试成功')
    await web.query('COMMIT');assert.equal(await count(),51,'Web保留原有不淘汰的语义')
    assert.equal((await f.pool.query('SELECT id FROM conversation_sessions WHERE id=$1',[retry])).rowCount,1)
   }finally{await web.query('ROLLBACK');await im.query('ROLLBACK');web.release();im.release()}
  })

  await t.test('两个peer分别已持Session锁时不反序等待，owner竞争推迟重试后始终50',async()=>{
   const ids=await reset(),a=await f.pool.connect(),b=await f.pool.connect()
   try{
    await a.query('BEGIN');await b.query('BEGIN');await a.query("SET LOCAL statement_timeout='3s'");await b.query("SET LOCAL statement_timeout='3s'")
    await a.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.schema+':peer-a'])
    await b.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.schema+':peer-b'])
    await a.query('UPDATE conversation_sessions SET pending_message_count=1 WHERE id=$1',[ids[0]])
    await b.query('SELECT id FROM conversation_sessions WHERE id=$1 FOR UPDATE',[ids[1]])
    assert.equal((await retention.beforeCreate(a,f.ownerId)).deleted[0]?.sessionId,ids[2])
    await assert.rejects(retention.beforeCreate(b,f.ownerId),error=>error instanceof ImSessionRetentionError&&error.code==='busy')
    await b.query('ROLLBACK');await insertNew(a,'concurrent-peer-a');await a.query('COMMIT');assert.equal(await count(),50)
    await b.query('BEGIN');await retention.beforeCreate(b,f.ownerId);await insertNew(b,'concurrent-peer-b');await b.query('COMMIT')
    assert.equal(await count(),50)
   }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release()}
  })
 }finally{await f.close()}
})
