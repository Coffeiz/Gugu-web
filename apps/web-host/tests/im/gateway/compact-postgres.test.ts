import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {createPostgresImCompact,ImCompactError} from '../../../src/modules/im/gateway/memory/store.js'
import {createPostgresAgentRunLeasePort} from '../../../src/modules/agent/run/lease.js'
import {enqueueAgentRunLocked} from '../../../src/modules/agent/run/dispatch.js'
import {createImProductionFixture} from './production.fixtures.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
test('真实PG：手动压缩与正常Run互斥，原子基线/summary、重放、防撤权、未知与精确过期恢复',{
 skip:!(databaseUrl&&python)&&'需显式隔离PG与离线ORM解释器',timeout:120000,
},async t=>{
 const f=await createImProductionFixture({databaseUrl,python:python!})
 try{
  const base={ownerId:f.ownerId,platform:'telegram' as const,botId:f.botId,chatType:'c2c' as const,chatId:null,platformUserId:'202',eventId:'synthetic-command',admissionCutoff:'2026-11-18T00:00:00.000000Z'}
  async function session(source='telegram',sender='202'){
   const row=await f.insert('conversation_sessions',{user_id:f.ownerId,title:'合成历史',source,bot_id:source==='web'?null:f.botId,chat_type:'c2c',platform_user_id:sender,last_message_seq:32,execution_state:'idle'})
   for(let i=1;i<=32;i++)await f.insert('conversation_messages',{session_id:row.id,conversation_seq:i,role:i%2?'user':'assistant',content:`合成历史第${i}条`})
   return Number(row.id)
  }
  let summaries=0,usage=0,closed=0,hook:()=>Promise<void>=async()=>{},closeHook:()=>Promise<void>=async()=>{},bound:number|null=null
  const compact=createPostgresImCompact({pool:f.pool,secretKey:f.secretKey,supportedPlatforms:()=>['telegram'],readOwnerSession:async()=>bound,
   async runtime(){return{modelIdentity:'synthetic',timezone:'UTC',compaction:{async summarize(input){summaries++;assert.ok(input.history.length>10);await hook();return '较早历史的真实合成摘要'}},async recordUsage(){usage++},async close(){closed++;await closeHook()}}},diagnose(){}})
  await t.test('无现有会话不创建历史；非owner禁止读取或修改',async()=>{
   assert.match(await compact.compact(base),/还没有/)
   assert.match(await compact.compact({...base,eventId:'member',platformUserId:'303'}),/只有绑定 Bot 的用户/)
   assert.equal(summaries,0)
  })
  const id=await session()
  await t.test('摘要不持PG事务，会话围栏挡正常Run；摘要与水位原子完成且重复命令不再调用',async()=>{
   const leases=createPostgresAgentRunLeasePort(f.pool)
   hook=async()=>{
    const client=await f.pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM conversation_sessions WHERE id=$1 FOR UPDATE NOWAIT',[id]);await client.query('ROLLBACK')}finally{client.release()}
    assert.equal(await leases.acquire({ownerId:f.ownerId,sessionId:String(id),runId:randomUUID()}),null)
   }
   const scope={...base,eventId:'successful'}
   assert.match(await compact.compact(scope),/已经整理/)
   const row=(await f.pool.query('SELECT baseline_message_seq,execution_state,active_run_id,last_message_seq FROM conversation_sessions WHERE id=$1',[id])).rows[0]
   assert.ok(Number(row.baseline_message_seq)>0);assert.equal(row.execution_state,'idle');assert.equal(row.active_run_id,null);assert.equal(Number(row.last_message_seq),33)
   assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM conversation_messages WHERE session_id=$1 AND role='summary'",[id])).rows[0].n,1)
   assert.equal(usage,1);assert.equal(summaries,1);assert.equal(closed,1)
   assert.match(await compact.compact({...scope,admissionCutoff:'2099-01-01 00:00:00+00'}),/已经整理/);assert.equal(summaries,1);assert.equal(usage,1)
   assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM agent_run_startups WHERE session_id=$1",[id])).rows[0].n,0)
  })
  await t.test('已压缩小历史是无需整理，忙/等待会话不调用摘要',async()=>{
   hook=async()=>{}
   assert.match(await compact.compact({...base,eventId:'no-history'}),/无需整理/)
   const before=summaries
   await f.pool.query("UPDATE conversation_sessions SET execution_state='running',active_run_id='actual-run' WHERE id=$1",[id])
   assert.match(await compact.compact({...base,eventId:'busy'}),/仍在处理/);assert.equal(summaries,before)
   await f.pool.query("UPDATE conversation_sessions SET execution_state='idle',active_run_id=NULL WHERE id=$1",[id])
  })
  await t.test('绑定Web历史同样可整理；摘要途中撤权不推进水位，原命令不再发模型',async()=>{
   bound=await session('web')
   const target=bound
   hook=async()=>{await f.pool.query('UPDATE user_bots SET enabled=false WHERE id=$1',[f.botId])}
   assert.match(await compact.compact({...base,eventId:'revoke'}),/没有完成/)
   assert.equal(Number((await f.pool.query('SELECT baseline_message_seq FROM conversation_sessions WHERE id=$1',[target])).rows[0].baseline_message_seq),0)
   await f.pool.query('UPDATE user_bots SET enabled=true WHERE id=$1',[f.botId]);const before=summaries
   assert.match(await compact.compact({...base,eventId:'revoke',admissionCutoff:'2099-01-01 00:00:00+00'}),/没有完成/);assert.equal(summaries,before)
   hook=async()=>{}
   assert.match(await compact.compact({...base,eventId:'web-success'}),/已经整理/)
  })
  await t.test('取消释放准确租约且保留未知收据，不恢复/重发不确定Provider请求',async()=>{
   bound=await session('web');const target=bound,abort=new AbortController(),reason=new Error('合成取消')
   hook=async()=>{abort.abort(reason)}
   await assert.rejects(compact.compact({...base,eventId:'cancelled'},abort.signal),error=>error===reason)
   const row=(await f.pool.query('SELECT baseline_message_seq,execution_state,active_run_id FROM conversation_sessions WHERE id=$1',[target])).rows[0]
   assert.deepEqual({...row,baseline_message_seq:Number(row.baseline_message_seq)},{baseline_message_seq:0,execution_state:'idle',active_run_id:null});const before=summaries
   hook=async()=>{}
   assert.match(await compact.compact({...base,eventId:'cancelled'}),/没有完成/);assert.equal(summaries,before)
  })
  await t.test('过期崩溃只回收匹配的手动命令租约，下一明确新命令可正常运行',async()=>{
   const token=randomUUID(),op='im-compact:'+randomUUID(),target=bound!
   await f.pool.query(`INSERT INTO gugu_im_compact_commands(user_id,event_hash,session_id,operation_id,state,token,fence) VALUES($1,$2,$3,$4,'requesting',$5,99)`,[f.ownerId,'f'.repeat(64),target,op,token])
   await f.pool.query(`UPDATE agent_run_leases SET run_id=$3,token=$4,fence=99,expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND session_id=$2`,[f.ownerId,target,op,token])
   await f.pool.query("UPDATE conversation_sessions SET execution_state='baseline_updating',active_run_id=$2 WHERE id=$1",[target,op])
   assert.match(await compact.compact({...base,eventId:'after-crash'}),/已经整理/)
   assert.equal((await f.pool.query('SELECT state FROM gugu_im_compact_commands WHERE operation_id=$1',[op])).rows[0].state,'unknown')
  })
  await t.test('失租结果不得提交，也不得清除替代Run的运行状态',async()=>{
   bound=await session('web');const target=bound,replacement='synthetic-replacement',token=randomUUID()
   hook=async()=>{await f.pool.query('UPDATE agent_run_leases SET run_id=$3,token=$4,fence=fence+1 WHERE user_id=$1 AND session_id=$2',[f.ownerId,target,replacement,token]);await f.pool.query("UPDATE conversation_sessions SET execution_state='running',active_run_id=$2 WHERE id=$1",[target,replacement])}
   assert.match(await compact.compact({...base,eventId:'lost-lease'}),/没有完成/)
   const row=(await f.pool.query('SELECT baseline_message_seq,execution_state,active_run_id FROM conversation_sessions WHERE id=$1',[target])).rows[0]
   assert.equal(Number(row.baseline_message_seq),0);assert.equal(row.execution_state,'running');assert.equal(row.active_run_id,replacement)
   assert.equal((await f.pool.query('SELECT token FROM agent_run_leases WHERE user_id=$1 AND session_id=$2',[f.ownerId,target])).rows[0].token,token)
  })
  await t.test('群会话按当前Bot/群隔离，不能整理另一群或私聊绑定历史',async()=>{
   hook=async()=>{};bound=null
   const target=await f.insert('conversation_sessions',{user_id:f.ownerId,title:'当前群',source:'telegram',bot_id:f.botId,chat_type:'group',chat_id:'-1001',last_message_seq:32,execution_state:'idle'})
   const other=await f.insert('conversation_sessions',{user_id:f.ownerId,title:'其他群',source:'telegram',bot_id:f.botId,chat_type:'group',chat_id:'-1002',last_message_seq:0,execution_state:'idle'})
   for(let i=1;i<=32;i++)await f.insert('conversation_messages',{session_id:target.id,conversation_seq:i,role:i%2?'user':'assistant',content:`当前群合成事实${i}`,platform_user_id:'202',chat_type:'group'})
   assert.match(await compact.compact({...base,eventId:'group',chatType:'group',chatId:'-1001'}),/已经整理/)
   assert.equal(Number((await f.pool.query('SELECT baseline_message_seq FROM conversation_sessions WHERE id=$1',[other.id])).rows[0].baseline_message_seq),0)
  })
  await t.test('摘要期间会话改归其他群，提交重新核对元数据而不写旧scope结果',async()=>{
   const target=(await f.pool.query("SELECT id FROM conversation_sessions WHERE chat_id='-1002'")).rows[0].id
   await f.pool.query('UPDATE conversation_sessions SET last_message_seq=32 WHERE id=$1',[target])
   for(let i=1;i<=32;i++)await f.insert('conversation_messages',{session_id:target,conversation_seq:i,role:i%2?'user':'assistant',content:`合成改归事实${i}`})
   hook=async()=>{await f.pool.query("UPDATE conversation_sessions SET chat_id='-1003' WHERE id=$1",[target])}
   assert.match(await compact.compact({...base,eventId:'group-changed',chatType:'group',chatId:'-1002'}),/没有完成/)
   assert.equal(Number((await f.pool.query('SELECT baseline_message_seq FROM conversation_sessions WHERE id=$1',[target])).rows[0].baseline_message_seq),0)
  })
  await t.test('调度已selected但尚未取得Core租约时保持busy，不抢占启动中的真实任务',async()=>{
   hook=async()=>{};bound=await session('web');const target=bound,before=summaries
   const client=await f.pool.connect()
   try{await client.query('BEGIN');await client.query('SELECT id FROM conversation_sessions WHERE id=$1 FOR UPDATE',[target])
    const message=(await client.query("SELECT id FROM conversation_messages WHERE session_id=$1 AND role='user' ORDER BY conversation_seq LIMIT 1",[target])).rows[0].id
    await enqueueAgentRunLocked(client,f.secretKey,{ownerId:f.ownerId,sessionId:String(target),runId:randomUUID()},{v:2,source:'web',userMessageId:Number(message),locale:null,origin:null,accessVersion:'a'.repeat(64)},3600)
    await client.query('COMMIT')
   }finally{client.release()}
   assert.match(await compact.compact({...base,eventId:'selected-before-core-lease'}),/仍在处理/);assert.equal(summaries,before)
   assert.equal(Number((await f.pool.query('SELECT baseline_message_seq FROM conversation_sessions WHERE id=$1',[target])).rows[0].baseline_message_seq),0)
  })
  await t.test('运行资源清理失败固定脱敏上抛，已提交压缩不会因此在重放时再次调用模型',async()=>{
   bound=await session('web');hook=async()=>{};closeHook=async()=>{throw Error('synthetic-private-credential')}
   const scope={...base,eventId:'cleanup-failed'}
   await assert.rejects(compact.compact(scope),error=>error instanceof ImCompactError&&!error.message.includes('synthetic')&&!('cause'in error))
   const before=summaries;closeHook=async()=>{}
   assert.match(await compact.compact(scope),/已经整理/);assert.equal(summaries,before)
  })
 }finally{await f.close()}
})
