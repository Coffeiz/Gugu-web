import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import {deleteAgentSessionLocked} from '@gugu/core/agent-sessions'
import {createPostgresImConversationStore} from '../../../../src/modules/im/gateway/agent/conversations.js'
import {createPostgresImAccess} from '../../../../src/modules/im/gateway/inbound/access.js'
import {imActorInputFromPayload} from '@gugu/core/im/access'
import {createImRetiredInbound} from '../../../../src/modules/im/gateway/inbound/retired.js'
import {createImProductionFixture} from '../production.fixtures.js'
import {createImHistoryRetention} from '../../../../src/modules/im/gateway/memory/history.js'
import {createPostgresChatAttachmentDraftDeletePorts} from '../../../../src/modules/agent/attachments/persistence.js'
const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
test('真实PG历史消费墓碑：删除/回滚/并发与当前授权，不因原收据级联消失重复入站',{
 skip:!(databaseUrl&&python)&&'需专用隔离PG及离线ORM解释器',timeout:120000,
},async t=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),binding={ownerId:'',platform:'telegram' as const,botId:''}
 binding.ownerId=f.ownerId;binding.botId=f.botId
 const retired=createImRetiredInbound({pool:f.pool,secretKey:f.secretKey})
 let count=0
 const store=(peek=retired.seenLocked)=>createPostgresImConversationStore({pool:f.pool,secretKey:f.secretKey,attachments:{mode:'text-only'},retired:peek,
  authorize:async(client,b,p)=>!!await createPostgresImAccess({query:(q,a)=>client.query(q,a),supportedPlatforms:()=>['telegram']}).readBot(imActorInputFromPayload(b,p)),
  classify:async()=> 'passive'})
 async function original(){const n=++count,payload={platform:'telegram',owner_user_id:f.ownerId,bot_id:f.botId,chat_type:'group',chat_id:`synthetic-group-${n}`,
  platform_user_id:'202',message_id:`synthetic-event-${n}`,platform_message_id:`synthetic-event-${n}`,text:'合成正文不应进入墓碑'}
  const anchor=await store().persist(binding,payload,{eventId:`1700000000000-${n}`,mode:'passive'});assert.ok(anchor);return{payload,anchor}}
 try{
  await t.test('消息删除后无原receipt仍确认消费；跨owner/Bot/group不同，重建附件ID或编辑正文不复活历史事件',async()=>{
   const {payload,anchor}=await original(),client=await f.pool.connect()
   try{await client.query('BEGIN');await retired.markLocked(client,f.ownerId,anchor.sessionId,[anchor.messageId]);await client.query('DELETE FROM conversation_messages WHERE id=$1',[anchor.messageId]);await client.query('COMMIT')}finally{client.release()}
   assert.equal((await f.pool.query('SELECT 1 FROM gugu_im_inbound_receipts WHERE message_id=$1',[anchor.messageId])).rowCount,0)
   assert.equal(await retired.seen(binding,payload),true)
   assert.equal(await store().persist(binding,{...payload,text:'同事件的新文本',attachments:['synthetic-new-attach-id']},{eventId:'1700000000000-100',mode:'passive'}),null)
   assert.equal(await retired.seen({...binding,ownerId:f.otherOwnerId},payload),false)
   assert.equal(await retired.seen({...binding,botId:'999999'},payload),false)
   assert.equal(await retired.seen(binding,{...payload,chat_id:'another-synthetic-group'}),false)
   const rows=(await f.pool.query('SELECT * FROM gugu_im_retired_inbound')).rows
   assert.ok(!JSON.stringify(rows).includes(payload.text));assert.ok(!JSON.stringify(rows).includes(payload.message_id))
  })
  await t.test('标记与删除回滚不留墓碑，也不丢原消息/收据',async()=>{
   const {payload,anchor}=await original(),client=await f.pool.connect()
   try{await client.query('BEGIN');await retired.markLocked(client,f.ownerId,anchor.sessionId,[anchor.messageId]);await client.query('DELETE FROM conversation_messages WHERE id=$1',[anchor.messageId]);await client.query('ROLLBACK')}finally{client.release()}
   assert.equal(await retired.seen(binding,payload),false)
   assert.equal((await store().persist(binding,payload,{eventId:'1700000000000-101',mode:'passive'}))?.messageId,anchor.messageId)
  })
  await t.test('整会话复用Core删除后标记仍保留，跨owner删除证明被拒绝',async()=>{
   const {payload,anchor}=await original(),client=await f.pool.connect()
   try{
    await client.query('BEGIN');await assert.rejects(retired.markLocked(client,f.otherOwnerId,anchor.sessionId));await client.query('ROLLBACK')
    await client.query('BEGIN');await retired.markLocked(client,f.ownerId,anchor.sessionId);assert.ok(await deleteAgentSessionLocked(client,f.ownerId,anchor.sessionId));await client.query('COMMIT')
   }finally{client.release()}
   assert.equal(await retired.seen(binding,payload),true)
   assert.equal(await store().persist(binding,payload,{eventId:'1700000000000-102',mode:'passive'}),null)
   assert.equal((await f.pool.query('SELECT 1 FROM conversation_sessions WHERE id=$1',[anchor.sessionId])).rowCount,0)
  })
  await t.test('先查未退休再等待session锁：清理提交后复核，不死锁、不重建消息',async()=>{
   const {payload,anchor}=await original(),client=await f.pool.connect()
   let entered!:()=>void;const firstPeek=new Promise<void>(resolve=>entered=resolve);let peekCount=0
   const concurrent=store(async(c,k)=>{const result=await retired.seenLocked(c,k);if(++peekCount===1)entered();return result})
   let inbound:ReturnType<typeof concurrent.persist>|undefined
   try{
    await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2s'");await client.query('SELECT id FROM conversation_sessions WHERE id=$1 FOR UPDATE',[anchor.sessionId])
    inbound=concurrent.persist(binding,payload,{eventId:'1700000000000-103',mode:'passive'});await firstPeek
    await retired.markLocked(client,f.ownerId,anchor.sessionId,[anchor.messageId]);await client.query('DELETE FROM conversation_messages WHERE id=$1',[anchor.messageId]);await client.query('COMMIT')
    assert.equal(await inbound,null);assert.ok(peekCount>=2)
    assert.equal((await f.pool.query('SELECT 1 FROM conversation_messages WHERE session_id=$1',[anchor.sessionId])).rowCount,0)
   }finally{await client.query('ROLLBACK');client.release();await inbound?.catch(()=>undefined)}
  })
  await t.test('Bot撤权后依然先拒绝当前授权，墓碑不成为宽松入口',async()=>{
   const {payload,anchor}=await original(),client=await f.pool.connect()
   try{await client.query('BEGIN');await retired.markLocked(client,f.ownerId,anchor.sessionId);await client.query('COMMIT')}finally{client.release()}
   await f.pool.query('UPDATE user_bots SET enabled=false WHERE id=$1',[f.botId])
   await assert.rejects(store().persist(binding,payload,{eventId:'1700000000000-104',mode:'passive'}),/IM/u)
  })
 }finally{await f.close()}
})

test('真实PG/FS持久回收：实际物理清理失败保留重试，重建后成功；共享附件引用不能误删',{
 skip:!(databaseUrl&&python)||process.platform!=='linux'?'需专用隔离PG及Linux受控FS删除实现':false,timeout:120000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),badRoot=join(f.root,'synthetic-file-not-directory')
 const key=`${f.ownerId}/agent-chat/${randomUUID()}.bin`,path=join(f.storageRoot,key)
 await mkdir(dirname(path),{recursive:true});await writeFile(path,'合成共享字节');await writeFile(badRoot,'合成错误根')
 let port=createPostgresChatAttachmentDraftDeletePorts(f.pool,badRoot,{strictCleanup:true})
 const create=()=>createImHistoryRetention({pool:f.pool,beforeRemoveLocked:async()=>assert.fail('本用例不裁剪消息'),
  pendingAsk:async()=>assert.fail('本用例不读取群状态'),removeIfUnreferenced:(owner,k)=>port.removeUnreferenced(owner,k),deferMs:1})
 let service=create()
 const enqueue=async()=>{const client=await f.pool.connect();try{await client.query('BEGIN');await service.enqueueCleanupLocked(client,f.ownerId,[key]);await client.query('COMMIT')}finally{client.release()}}
 try{
  await enqueue();assert.equal(await service.processCleanup(),0)
  const failed=(await f.pool.query('SELECT attempts FROM gugu_im_history_retention_storage')).rows
  assert.equal(failed.length,1);assert.equal(failed[0].attempts,1)
  assert.equal(await readFile(path,'utf8'),'合成共享字节')
  await service.close();port=createPostgresChatAttachmentDraftDeletePorts(f.pool,f.storageRoot,{strictCleanup:true});service=create()
  await f.pool.query('UPDATE gugu_im_history_retention_storage SET next_attempt_at=clock_timestamp()')
  // 一个仍被引用的draft不应被清理，即便原消息已删除；后续删除该引用再重新登记才回收。
  const attachment=await f.insert('chat_attachments',{attach_id:randomUUID().replaceAll('-',''),user_id:f.ownerId,storage_key:key,platform:'telegram',name:'合成共享附件',ext:'bin',mime:'application/octet-stream',kind:'binary',size:18,state:'draft'})
  assert.equal(await service.processCleanup(),1);assert.equal(await readFile(path,'utf8'),'合成共享字节')
  await f.pool.query('DELETE FROM chat_attachments WHERE attach_id=$1',[attachment.attach_id]);await enqueue()
  assert.equal(await service.processCleanup(),1)
  await assert.rejects(stat(path),{code:'ENOENT'})
  assert.equal((await f.pool.query('SELECT 1 FROM gugu_im_history_retention_storage')).rowCount,0)
 }finally{await service.close();await f.close()}
})
