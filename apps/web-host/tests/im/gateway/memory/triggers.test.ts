import { imReflectionSql } from '@gugu/database/postgres/migrations/0014_im_reflection'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import type {PoolClient} from 'pg'
import {createImProductionFixture} from '../production.fixtures.js'
import {createImReflectionTriggers,readImReflectionScopeVersions,ImReflectionTriggerError} from '../../../../src/modules/im/gateway/memory/triggers.js'
import {reflectionScopeHash} from '../../../../src/modules/im/gateway/memory/codec.js'
import {createImInboundEnvelope} from '../../../../src/modules/im/gateway/inbound/envelope.js'
import {imConversationDigest,imConversationFingerprint,imConversationScopeHash} from '../../../../src/modules/im/gateway/agent/identity.js'
import {enqueueAgentRunLocked} from '../../../../src/modules/agent/run/dispatch.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
test('触发器参数或SQL故障固定脱敏，不返回伪空窗口',async()=>{
 assert.throws(()=>createImReflectionTriggers({secretKey:''} as never),ImReflectionTriggerError)
 const triggers=createImReflectionTriggers({secretKey:'synthetic-trigger-key',pool:{async query(){throw Error('synthetic-private-trigger-sql')}} as never})
 await assert.rejects(triggers.pending(),error=>error instanceof ImReflectionTriggerError&&!String(error).includes('synthetic-private')&&!('cause'in error))
 for(const scope_versions of [null,[],{'invalid-hash':'synthetic-private'}, {["a".repeat(64)]:'1'}, {["a".repeat(64)]:-1}, {["a".repeat(64)]:1.5}]){
  const reader=createImReflectionTriggers({secretKey:'synthetic-trigger-key',pool:{async query(){return{rows:[{
   session_id:1,through_message_id:1,through_message_seq:'1',owner_revision:'0',active_generation:'1',scope_versions,
  }]}}}as never})
  await assert.rejects(reader.pending(),error=>error instanceof ImReflectionTriggerError&&!String(error).includes('synthetic-private')&&!('cause'in error))
 }
})
test('真实PG Node反思窗口：被动50条/真实Run闲置180秒、重放、撤权与revision隔离',{
 skip:!(databaseUrl&&python)&&'需显式隔离PG与离线ORM解释器',timeout:120000,
},async t=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),binding={ownerId:f.ownerId,platform:'telegram' as const,botId:f.botId}
 if(!(await f.pool.query("SELECT to_regclass('gugu_im_reflection_trigger_states') AS name")).rows[0].name)
  await f.pool.query(imReflectionSql.reflectionTrigger)
 const triggers=createImReflectionTriggers({pool:f.pool,secretKey:f.secretKey}),envelope=createImInboundEnvelope(f.secretKey)
 async function tx<T>(work:(client:PoolClient)=>Promise<T>){const client=await f.pool.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}}
 async function session(){return f.insert('conversation_sessions',{user_id:f.ownerId,title:'合成反思窗口',source:'telegram',bot_id:f.botId,chat_type:'group',chat_id:`synthetic-trigger-${randomUUID()}`,execution_state:'idle',pending_message_count:0,last_message_seq:0})}
 async function messages(s:Record<string,any>,count:number,runId:string|null=null){
  const rows=(await f.pool.query(`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,chat_type,platform_user_id,run_id,created_at)
   SELECT $1,n+$3,'user','合成被动事实','group','202',$4,clock_timestamp() FROM generate_series(1,$2) n RETURNING id,conversation_seq`,[s.id,count,s.last_message_seq,runId])).rows
  s.last_message_seq+=count;await f.pool.query('UPDATE conversation_sessions SET last_message_seq=$2 WHERE id=$1',[s.id,s.last_message_seq])
  for(const m of rows){const p={platform:'telegram',owner_user_id:f.ownerId,bot_id:f.botId,channel_id:f.botId,chat_type:'group',chat_id:s.chat_id,platform_user_id:'202',message_id:String(m.id),platform_message_id:String(m.id),text:'合成被动事实',attachments:[]}
   const scope=imConversationScopeHash(f.secretKey,binding,p)
   await f.pool.query('UPDATE conversation_messages SET im_platform_message_id=$2 WHERE id=$1',[m.id,String(m.id)])
   await f.pool.query(`INSERT INTO gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,session_id,message_id,state,run_id,sealed_payload)
    VALUES($1,'telegram',$2,'group',$3,$4,$5,$6,$7,$8,$9,$10)`,[f.ownerId,f.botId,scope,imConversationDigest(f.secretKey,[scope,'202',String(m.id)]),imConversationFingerprint(f.secretKey,scope,p,[]),s.id,m.id,runId?'dispatched':'passive',runId,envelope.seal(binding,p)])
  }return rows.map(m=>m.id as number)
 }
 async function active(s:Record<string,any>){const runId=randomUUID(),ids=await messages(s,1,runId),identity={ownerId:f.ownerId,sessionId:String(s.id),runId}
  await tx(async client=>{await enqueueAgentRunLocked(client,f.secretKey,identity,{v:3,source:'im',userMessageId:ids[0]!,locale:null,origin:null,accessVersion:'a'.repeat(64),im:{platform:'telegram',botId:f.botId,chatType:'group',chatId:s.chat_id,platformUserId:'202'}},300)
   await client.query(`INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,version,sequence,status,phase,nonce,payload,created_at,updated_at)
    VALUES($1,$2,$3,1,1,'completed','idle',$4,$5,now(),now())`,[f.ownerId,s.id,runId,Buffer.alloc(12),Buffer.alloc(16)])})
  return{identity,through:ids[0]!}
 }
 const observe=(s:Record<string,any>,ids:number[],enabled=true)=>tx(client=>triggers.observePassiveLocked(client,{ownerId:f.ownerId,sessionId:s.id,messageIds:ids,enabled}))
 try{
  await t.test('窗口冻结owner/群/同Session成员scope epoch，Admin维护与Node前移均不重绑定，跨群与其他Bot不混入',async()=>{
   const s=await session(),ids=await messages(s,50)
   const key=(type:'owner'|'group'|'platform-user',id:string)=>reflectionScopeHash({identity:{ownerId:f.ownerId},actor:{platform:'telegram',botId:f.botId},scope:{type,id}}as Parameters<typeof reflectionScopeHash>[0],f.secretKey)
   const addCursor=async(type:string,id:string,version:number,botId=f.botId)=>f.insert('memory_reflection_cursors',{
    owner_user_id:f.ownerId,platform:'telegram',bot_id:botId,scope_type:type,scope_id:id,scope_version:version})
   await addCursor('owner',String(s.id),2);await addCursor('group',s.chat_id,3);await addCursor('platform-user',`${s.chat_id}:202`,4)
   await addCursor('platform-user',`${s.chat_id}:202:999`,7);await addCursor('platform-user',`${s.chat_id}:404`,8)
   await addCursor('group',`${s.chat_id}:other`,9);await addCursor('group',s.chat_id,10,String(Number(f.botId)+100))
   const expected={[key('owner',String(s.id))]:2,[key('group',s.chat_id)]:3,[key('platform-user',`${s.chat_id}:202`)]:4}
   const [window]=await observe(s,ids);assert.deepEqual(window!.scopeVersions,expected);assert.ok(Object.isFrozen(window!.scopeVersions))
   const run=await active(s);await tx(client=>triggers.observeActiveLocked(client,run.identity,run.through))
   await f.pool.query("UPDATE memory_reflection_cursors SET scope_version=5 WHERE owner_user_id=$1 AND bot_id=$2 AND scope_type='group' AND scope_id=$3",[f.ownerId,f.botId,s.chat_id])
   assert.deepEqual((await triggers.pending()).find(value=>value.id===window!.id)!.scopeVersions,expected,'Admin维护不得重绑定旧窗口版本')
   await f.pool.query("UPDATE memory_reflection_cursors SET scope_version=6 WHERE owner_user_id=$1 AND bot_id=$2 AND scope_type='group' AND scope_id=$3",[f.ownerId,f.botId,s.chat_id])
   await f.pool.query(`INSERT INTO gugu_im_reflection_cursor_positions(user_id,session_id,scope_hash,scope_version,last_sequence,last_message_id)
    VALUES($1,$2,$3,6,50,$4)`,[f.ownerId,s.id,key('group',s.chat_id),ids.at(-1)])
   assert.deepEqual((await triggers.pending()).find(value=>value.id===window!.id)!.scopeVersions,expected,'Node位置推进也不得改冻结版本')
   assert.deepEqual((await f.pool.query('SELECT scope_versions FROM gugu_im_reflection_trigger_windows WHERE id=$1',[window!.id])).rows[0].scope_versions,expected)
   const bad={[key('group',s.chat_id)]:'synthetic-private'}
   await f.pool.query('UPDATE gugu_im_reflection_trigger_windows SET scope_versions=$2 WHERE id=$1',[window!.id,bad])
   await assert.rejects(triggers.pending(),error=>error instanceof ImReflectionTriggerError&&!String(error).includes('synthetic-private')&&!('cause'in error))
   await f.pool.query('UPDATE gugu_im_reflection_trigger_windows SET scope_versions=$2 WHERE id=$1',[window!.id,expected])
  })
  await t.test('版本reader缺省0且支持Web绑定私聊的实际Bot/sender；跨owner和错误Session peer拒绝',async()=>{
   const s=await session();await messages(s,1)
   const versions=await readImReflectionScopeVersions(f.pool,{ownerId:f.ownerId,sessionId:s.id,platform:'telegram',botId:f.botId,chatId:s.chat_id},f.secretKey)
   assert.equal(Object.keys(versions).length,3);assert.ok(Object.values(versions).every(value=>value===0))
   const privateSession=await f.insert('conversation_sessions',{user_id:f.ownerId,title:'合成绑定私聊',source:'web',chat_type:null,chat_id:null,bot_id:null})
   const m=await f.insert('conversation_messages',{session_id:privateSession.id,conversation_seq:1,role:'user',chat_type:'c2c',platform_user_id:'202',content:'合成私聊'})
   const p={platform:'telegram',owner_user_id:f.ownerId,bot_id:f.botId,channel_id:f.botId,chat_type:'c2c',chat_id:'202',platform_user_id:'202',message_id:String(m.id),text:'合成私聊',attachments:[]}
   const scope=imConversationScopeHash(f.secretKey,binding,p)
   await f.pool.query(`INSERT INTO gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,session_id,message_id,state,run_id,sealed_payload)
    VALUES($1,'telegram',$2,'c2c',$3,$4,$5,$6,$7,'passive',NULL,$8)`,[f.ownerId,f.botId,scope,imConversationDigest(f.secretKey,[scope,'202',String(m.id)]),
     imConversationFingerprint(f.secretKey,scope,p,[]),privateSession.id,m.id,envelope.seal(binding,p)])
   await f.insert('memory_reflection_cursors',{owner_user_id:f.ownerId,platform:'telegram',bot_id:f.botId,scope_type:'platform-user',scope_id:'202',scope_version:7})
   const privateVersions=await readImReflectionScopeVersions(f.pool,{ownerId:f.ownerId,sessionId:privateSession.id,platform:'telegram',botId:f.botId,chatId:null},f.secretKey)
   assert.deepEqual(Object.values(privateVersions).sort(),[0,7])
   for(const patch of[{ownerId:f.otherOwnerId},{chatId:'synthetic-other-peer'}])await assert.rejects(readImReflectionScopeVersions(f.pool,
    {ownerId:f.ownerId,sessionId:s.id,platform:'telegram',botId:f.botId,chatId:s.chat_id,...patch},f.secretKey),ImReflectionTriggerError)
  })
  await t.test('125条真实passive产生50/100两个窗口与余25，重放/early完成重复不计数，纯passive不arm idle',async()=>{
   const s=await session(),ids=await messages(s,125),windows=await observe(s,ids)
   assert.deepEqual(windows.map(w=>[w.throughMessageId,w.runId,w.reason]),[[ids[49],null,'threshold'],[ids[99],null,'threshold']])
   assert.deepEqual(await observe(s,ids),[])
   const state=(await f.pool.query('SELECT * FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0]
   assert.equal(state.passive_count,25);assert.equal(state.idle_due_at,null);assert.equal(state.active_at,null)
   assert.equal((await f.pool.query("SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE session_id=$1 AND status='pending'",[s.id])).rowCount,2)
   assert.equal((await triggers.pending()).filter(w=>w.sessionId===s.id).length,0,'无真实Run不占可执行窗口limit')
   assert.deepEqual(await triggers.settleIdle(),[])
  })
  await t.test('水位只按conversation_seq推进，ID更大的旧锚点不能覆盖业务水位',async()=>{
   const s=await session(),ids=await messages(s,50)
   await f.pool.query('UPDATE conversation_messages SET conversation_seq=conversation_seq+1000 WHERE session_id=$1',[s.id])
   await f.pool.query('UPDATE conversation_messages SET conversation_seq=1051-conversation_seq WHERE session_id=$1',[s.id])
   const [window]=await observe(s,ids)
   assert.equal(window!.throughMessageId,ids[0]);assert.equal(window!.throughMessageSeq,50)
   const state=(await f.pool.query('SELECT through_message_id,through_message_seq::text FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0]
   assert.deepEqual(state,{through_message_id:ids[0],through_message_seq:'50'})
  })
  await t.test('真实completed Run仅arm一次180秒，被动只推进through，idle扫描并发恰好一次；pending解析最近active',async()=>{
   const s=await session(),passive=await messages(s,50),[threshold]=await observe(s,passive)
   assert.equal(threshold!.runId,null)
   const first=await active(s)
   await tx(client=>triggers.observeActiveLocked(client,first.identity,first.through))
   const before=(await f.pool.query('SELECT active_at::text,idle_due_at::text,active_generation::text,extract(epoch FROM idle_due_at-active_at)::int AS seconds FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0]
   assert.equal(before.seconds,180)
   await tx(client=>triggers.observeActiveLocked(client,first.identity,first.through))
   const follow=await messages(s,2);await observe(s,follow)
   const after=(await f.pool.query('SELECT active_at::text,idle_due_at::text,active_generation::text FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0]
   for(const key of['active_at','idle_due_at','active_generation'])assert.equal(after[key],before[key])
   assert.equal((await triggers.pending()).find(w=>w.id===threshold!.id)!.runId,first.identity.runId)
   await f.pool.query("UPDATE gugu_im_reflection_trigger_states SET idle_due_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",[s.id])
   const batches=await Promise.all([triggers.settleIdle(),triggers.settleIdle()]),idle=batches.flat().filter(w=>w.sessionId===s.id)
   assert.equal(idle.length,1);assert.equal(idle[0]!.throughMessageId,follow.at(-1));assert.equal(idle[0]!.reason,'idle')
   assert.equal((await f.pool.query('SELECT passive_count FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0].passive_count,0)
   assert.equal(await tx(client=>triggers.deferLocked(client,threshold!.id)),true)
   assert.equal((await triggers.pending()).some(w=>w.id===threshold!.id),false)
   const latest=await active(s);await tx(client=>triggers.observeActiveLocked(client,latest.identity,latest.through))
   assert.equal((await triggers.pending()).find(w=>w.id===threshold!.id)!.runId,latest.identity.runId)
   await tx(client=>triggers.observeActiveLocked(client,first.identity,first.through))
   assert.equal((await triggers.pending()).find(w=>w.id===threshold!.id)!.runId,latest.identity.runId,'旧Run hook重放不能覆盖新active')
   assert.ok((await f.pool.query('SELECT idle_due_at FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0].idle_due_at)
   await tx(async client=>{assert.equal(await triggers.completeLocked(client,threshold!.id),true);assert.equal(await triggers.completeLocked(client,threshold!.id),false)})
   assert.equal((await triggers.pending()).some(w=>w.id===threshold!.id),false)
  })
  await t.test('owner revision更换清计数/active并取消旧窗口，旧observed不能复活；回滚不计消息也不留窗口',async()=>{
   const s=await session(),ids=await messages(s,51),[window]=await observe(s,ids),run=await active(s)
   await tx(client=>triggers.observeActiveLocked(client,run.identity,run.through))
   await f.pool.query('UPDATE gugu_im_reflection_owner_revisions SET revision=revision+1 WHERE user_id=$1',[f.ownerId])
   assert.equal((await triggers.pending()).some(w=>w.id===window!.id),false)
   assert.equal(await tx(client=>triggers.completeLocked(client,window!.id)),false)
   await observe(s,ids)
   const state=(await f.pool.query('SELECT * FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0]
   assert.equal(state.passive_count,0);assert.equal(state.last_active_run_id,null);assert.equal(state.idle_due_at,null)
   const other=await session(),more=await messages(other,50),client=await f.pool.connect()
   try{await client.query('BEGIN');assert.equal((await triggers.observePassiveLocked(client,{ownerId:f.ownerId,sessionId:other.id,messageIds:more})).length,1);await client.query('ROLLBACK')}finally{client.release()}
   assert.equal((await f.pool.query('SELECT 1 FROM gugu_im_reflection_trigger_observed WHERE session_id=$1',[other.id])).rowCount,0)
   assert.equal((await observe(other,more)).length,1)
  })
  await t.test('旧idle扫描等待Session锁期间新Run提交，旧扫描不得清新Run的180秒窗口',async()=>{
   const s=await session(),first=await active(s)
   await tx(client=>triggers.observeActiveLocked(client,first.identity,first.through))
   await f.pool.query("UPDATE gugu_im_reflection_trigger_states SET idle_due_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",[s.id])
   const latest=await active(s),client=await f.pool.connect();let scan:ReturnType<typeof triggers.settleIdle>|null=null
   try{
    await client.query('BEGIN');await client.query('SELECT id FROM conversation_sessions WHERE id=$1 FOR NO KEY UPDATE',[s.id])
    const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;scan=triggers.settleIdle()
    for(let n=0;;n++){
     if((await f.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount)break
     if(n>2000)assert.fail('旧扫描未进入真实Session锁等待');await new Promise<void>(resolve=>setImmediate(resolve))
    }
    await triggers.observeActiveLocked(client,latest.identity,latest.through);await client.query('COMMIT')
    assert.equal((await scan).some(w=>w.sessionId===s.id),false)
    const current=(await f.pool.query('SELECT last_active_run_id,idle_due_at>clock_timestamp() AS armed FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0]
    assert.deepEqual(current,{last_active_run_id:latest.identity.runId,armed:true})
   }finally{await client.query('ROLLBACK');client.release();await scan}
  })
  await t.test('global关闭或Bot group_memory关闭记录ignored，未来开启不补学；跨owner/scope/坏密文或指纹拒绝',async()=>{
   const s=await session(),ids=await messages(s,50)
   assert.deepEqual(await observe(s,ids,false),[]);assert.deepEqual(await observe(s,ids),[])
   const more=await messages(s,50);await f.pool.query('UPDATE user_bots SET group_memory_enabled=false WHERE id=$1',[f.botId])
   try{assert.deepEqual(await observe(s,more),[])}finally{await f.pool.query('UPDATE user_bots SET group_memory_enabled=true WHERE id=$1',[f.botId])}
   assert.deepEqual(await observe(s,more),[])
   assert.equal((await f.pool.query('SELECT passive_count FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0].passive_count,0)
   await assert.rejects(tx(client=>triggers.observePassiveLocked(client,{ownerId:f.otherOwnerId,sessionId:s.id,messageIds:ids})),ImReflectionTriggerError)
   const wrong=await session(),other=await messages(wrong,1)
   await assert.rejects(observe(s,other),ImReflectionTriggerError)
   await f.pool.query('UPDATE gugu_im_inbound_receipts SET fingerprint=$2 WHERE message_id=$1',[other[0],'f'.repeat(64)])
   await assert.rejects(observe(wrong,other),ImReflectionTriggerError)
   assert.equal((await f.pool.query('SELECT 1 FROM gugu_im_reflection_trigger_observed WHERE session_id=$1',[wrong.id])).rowCount,0)
  })
  await t.test('并发被动观察不重复阈值；不成功/非Node Run、未知状态与当前账户/Bot撤权不能arm',async()=>{
   const s=await session(),ids=await messages(s,50),counts=await Promise.all([observe(s,ids),observe(s,ids)])
   assert.equal(counts.flat().length,1)
   const x=await active(s);await f.pool.query("UPDATE agent_run_checkpoints SET status='running' WHERE run_id=$1",[x.identity.runId])
   await assert.rejects(tx(client=>triggers.observeActiveLocked(client,x.identity,x.through)),ImReflectionTriggerError)
   await f.pool.query("UPDATE agent_run_checkpoints SET status='completed' WHERE run_id=$1",[x.identity.runId])
   for(const clause of["enabled=false","group_chat_enabled=false"]){
    await f.pool.query(`UPDATE user_bots SET ${clause} WHERE id=$1`,[f.botId]);try{await assert.rejects(observe(s,ids),ImReflectionTriggerError)}finally{await f.pool.query('UPDATE user_bots SET enabled=true,group_chat_enabled=true WHERE id=$1',[f.botId])}}
   await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[f.ownerId]);try{await assert.rejects(observe(s,ids),ImReflectionTriggerError)}finally{await f.pool.query('UPDATE users SET is_active=true WHERE id=$1',[f.ownerId])}
  })
  await t.test('真实group tombstone屏障阻止计数、arm、idle结算与pending派发；仅同owner/Bot/群匹配',async()=>{
   const s=await session(),ids=await messages(s,50),[window]=await observe(s,ids),run=await active(s)
   await tx(client=>triggers.observeActiveLocked(client,run.identity,run.through))
   const tomb=await f.insert('memory_scope_tombstones',{owner_user_id:f.ownerId,platform:'telegram',bot_id:f.botId,scope_type:'group',scope_id:s.chat_id})
   const another=await session(),other=await messages(another,50),[otherWindow]=await observe(another,other),otherRun=await active(another)
   await tx(client=>triggers.observeActiveLocked(client,otherRun.identity,otherRun.through))
   assert.ok((await triggers.pending()).some(w=>w.id===otherWindow!.id));assert.equal((await triggers.pending()).some(w=>w.id===window!.id),false)
   const more=await messages(s,50);assert.deepEqual(await observe(s,more),[])
   const stopped=await active(s),before=(await f.pool.query('SELECT last_active_run_id,active_generation::text FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0]
   await tx(client=>triggers.observeActiveLocked(client,stopped.identity,stopped.through))
   assert.deepEqual((await f.pool.query('SELECT last_active_run_id,active_generation::text FROM gugu_im_reflection_trigger_states WHERE session_id=$1',[s.id])).rows[0],before)
   await f.pool.query("UPDATE gugu_im_reflection_trigger_states SET idle_due_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",[s.id])
   assert.equal((await triggers.settleIdle()).some(w=>w.sessionId===s.id),false)
   await f.pool.query('DELETE FROM memory_scope_tombstones WHERE id=$1',[tomb.id]);assert.deepEqual(await observe(s,more),[],'删除屏障期间的消息已ignored，解除后不补学')
  })
 }finally{await f.close()}
})
