import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resolveImActor} from '@gugu/core/im/access'
import {createImProductionFixture} from './production.fixtures.js'
import {createImInboundEnvelope} from '../../../src/modules/im/gateway/inbound/envelope.js'
import {imConversationDigest,imConversationFingerprint,imConversationScopeHash} from '../../../src/modules/im/gateway/agent/identity.js'
import {loadImReflectionPassiveTail,ImReflectionTailError,type ImReflectionPassiveTailInput} from '../../../src/modules/im/gateway/memory/tail.js'

test('无群scope/真实快照锚点的反思尾段在任何数据库读取前拒绝',async()=>{
 const input={pool:{query:async()=>assert.fail('无效身份不可查库')},secretKey:'synthetic-secret',identity:{ownerId:'synthetic',sessionId:'1',runId:'synthetic'},
  actor:{chatType:'c2c'},snapshotMessageIds:[],targetMessageIds:[],throughMessageId:'1',authorize:async()=>true}as unknown as ImReflectionPassiveTailInput
 await assert.rejects(loadImReflectionPassiveTail(input),error=>error instanceof ImReflectionTailError&&error.code==='invalid'&&!error.cause)
})

const ready=!!process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL&&!!process.env.GUGU_IM_FIXTURE_PYTHON
test('真实PG：反思尾段按seq验证密封被动来源，保留原Run助手边界、群格式与原文，不发Provider不改游标',{
 skip:ready?false:'需显式隔离PG及离线ORM解释器',timeout:120000,
},async t=>{
 const f=await createImProductionFixture({python:process.env.GUGU_IM_FIXTURE_PYTHON!})
 try{
  const session=await f.insert('conversation_sessions',{user_id:f.ownerId,source:'telegram',bot_id:f.botId,chat_type:'group',chat_id:'synthetic-group'})
  const identity={ownerId:f.ownerId,sessionId:String(session.id),runId:'synthetic-reflection-origin'}
  const binding={ownerId:f.ownerId,botId:String(f.botId),platform:'telegram' as const}
  const actor=resolveImActor({ownerId:f.ownerId,platform:'telegram',botId:String(f.botId),chatType:'group',chatId:'synthetic-group',platformUserId:'202',botMentioned:true,mentionsOtherBot:false},()=>({role:'owner',allowedToolNames:null}))
  await f.insert('conversation_messages',{id:1001,session_id:session.id,conversation_seq:1,role:'user',run_id:identity.runId,
   chat_type:'group',platform_user_id:'202',content:'合成快照内用户正文'})
  await f.insert('conversation_messages',{id:1002,session_id:session.id,conversation_seq:2,role:'assistant',run_id:identity.runId,content:'合成原Run实际回复'})
  const envelope=createImInboundEnvelope(f.secretKey)
  async function add(id:number,seq:number,sender='202'){
   const payload={...binding,owner_user_id:f.ownerId,bot_id:String(f.botId),channel_id:String(f.botId),chat_type:'group',chat_id:'synthetic-group',
    platform_user_id:sender,platform_user_name:sender==='202'?'小北':'小南',message_id:String(8000+seq),platform_message_id:String(8000+seq),
    text:`合成被动消息${seq}`,quoted_text:seq===3?'合成引用原文':null,reply_to_platform_message_id:seq===3?'7000':null,attachments:[]}
   await f.insert('conversation_messages',{id,session_id:session.id,conversation_seq:seq,role:'user',run_id:null,chat_type:'group',
    platform_user_id:sender,platform_user_name:payload.platform_user_name,content:payload.text,quoted_text:payload.quoted_text,
    im_platform_message_id:payload.message_id,im_reply_to_message_id:payload.reply_to_platform_message_id})
   const scopeHash=imConversationScopeHash(f.secretKey,binding,payload)
   await f.pool.query(`INSERT INTO gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,session_id,message_id,state,run_id,sealed_payload)
    VALUES($1,'telegram',$2,'group',$3,$4,$5,$6,$7,'passive',NULL,$8::jsonb)`,[f.ownerId,String(f.botId),scopeHash,
    imConversationDigest(f.secretKey,[scopeHash,sender,payload.message_id]),imConversationFingerprint(f.secretKey,scopeHash,payload,[]),session.id,id,envelope.seal(binding,payload)])
   return payload
  }
  // 后插消息的id更小：安全水位必须取conversation_seq，不能取max(id)。
  const first=await add(901,3),last=await add(1100,4,'203')
  const options:ImReflectionPassiveTailInput={pool:f.pool,secretKey:f.secretKey,identity,actor,snapshotMessageIds:['1001'],
   targetMessageIds:['901','1100'],throughMessageId:'1100',authorize:async()=>true}
  await t.test('允许快照之后才持久化的原Run助手，追加两个被动speaker且保引用；重复读取无副作用',async()=>{
   const result=await loadImReflectionPassiveTail(options)
   assert.deepEqual(result.persistedMessageIds,['901','1100']);assert.equal(result.messages.length,2)
   assert.match(String(result.messages[0]!.content),/【群消息】[\s\S]*平台 ID：202[\s\S]*显示名：小北[\s\S]*合成被动消息3[\s\S]*【引用消息】[\s\S]*合成引用原文/u)
   assert.match(String(result.messages[1]!.content),/平台 ID：203[\s\S]*合成被动消息4/u)
   assert.ok(!JSON.stringify(result).includes('合成原Run实际回复'))
   assert.deepEqual(await loadImReflectionPassiveTail(options),result)
   assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM memory_reflection_cursors')).rows[0].n,0)
   assert.deepEqual(envelope.open(binding,(await f.pool.query('SELECT sealed_payload FROM gugu_im_inbound_receipts WHERE message_id=901')).rows[0].sealed_payload),first)
  })
  await t.test('through边界与target更早未覆盖时defer，缺锚/跨Session快照不能伪造完整',async()=>{
   assert.deepEqual((await loadImReflectionPassiveTail({...options,targetMessageIds:['901'],throughMessageId:'901'})).persistedMessageIds,['901'])
   for(const patch of [{snapshotMessageIds:['1001','1100']},{snapshotMessageIds:['9999']},{targetMessageIds:['901'],throughMessageId:'1001'}])
    await assert.rejects(loadImReflectionPassiveTail({...options,...patch}),ImReflectionTailError)
   const foreign=await f.insert('conversation_sessions',{user_id:f.otherOwnerId,source:'telegram',bot_id:f.botId,chat_type:'group',chat_id:'synthetic-group'})
   await f.insert('conversation_messages',{id:1200,session_id:foreign.id,conversation_seq:1,role:'user',run_id:identity.runId,content:'跨用户合成正文'})
   await assert.rejects(loadImReflectionPassiveTail({...options,snapshotMessageIds:['1200']}),ImReflectionTailError)
  })
  const client=await f.pool.connect()
  try{
   await t.test('后续其他Run的user/assistant、无Run助手或无身份用户均不能跳过',async()=>{
    for(const [role,run,sender]of [['user','synthetic-next-run','202'],['assistant','synthetic-next-run',null],['assistant',null,null],['user',null,null]]as const){
     await client.query('BEGIN')
     try{
      await client.query('UPDATE conversation_messages SET role=$2,run_id=$3,platform_user_id=$4 WHERE id=$1',[901,role,run,sender])
      await assert.rejects(loadImReflectionPassiveTail({...options,pool:client}),ImReflectionTailError)
     }finally{await client.query('ROLLBACK')}
    }
   })
   await t.test('原文/quote/native/seq/密封HMAC/指纹/状态或跨群篡改全部静态拒绝',async()=>{
    const mutations:Array<[string,unknown[]]>= [
     ["UPDATE conversation_messages SET content='不能混入的正文' WHERE id=901",[]],
     ["UPDATE conversation_messages SET quoted_text='不能混入的引用' WHERE id=901",[]],
     ["UPDATE conversation_messages SET im_platform_message_id='9999' WHERE id=901",[]],
     ["UPDATE conversation_messages SET platform_user_name='冒充显示名' WHERE id=901",[]],
     ["UPDATE conversation_messages SET conversation_seq=0 WHERE id=901",[]],
     ["UPDATE gugu_im_inbound_receipts SET event_hash=$1 WHERE message_id=901",['f'.repeat(64)]],
     ["UPDATE gugu_im_inbound_receipts SET fingerprint=$1 WHERE message_id=901",['f'.repeat(64)]],
     ["UPDATE gugu_im_inbound_receipts SET scope_hash=$1 WHERE message_id=901",['f'.repeat(64)]],
     ["UPDATE gugu_im_inbound_receipts SET state='staged' WHERE message_id=901",[]],
     ["UPDATE gugu_im_inbound_receipts SET sealed_payload=$1 WHERE message_id=901",[envelope.seal(binding,{...first,chat_id:'synthetic-other-group'})]],
     ["UPDATE gugu_im_inbound_receipts SET sealed_payload=$1 WHERE message_id=901",[envelope.seal(binding,last)]],
     ["DELETE FROM gugu_im_inbound_receipts WHERE message_id=901",[]],
     [`INSERT INTO gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,session_id,message_id,state,run_id,sealed_payload)
       SELECT user_id,platform,bot_id,chat_type,scope_hash,$1,fingerprint,session_id,message_id,state,run_id,$2::jsonb
       FROM gugu_im_inbound_receipts WHERE message_id=901`,[
        imConversationDigest(f.secretKey,[imConversationScopeHash(f.secretKey,binding,first),first.platform_user_id,'synthetic-resume']),
        envelope.seal(binding,{...first,_pending_ask_resume_id:'synthetic-resume'})]],
    ]
    for(const [sql,values]of mutations){await client.query('BEGIN')
     try{await client.query(sql,values);await assert.rejects(loadImReflectionPassiveTail({...options,pool:client}),error=>
      error instanceof ImReflectionTailError&&!error.message.includes('正文')&&!error.cause)}finally{await client.query('ROLLBACK')}
    }
   })
  }finally{client.release()}
  await t.test('当前Bot禁用、当前授权撤销和取消均拒绝尾段，不能回空成功',async()=>{
   await assert.rejects(loadImReflectionPassiveTail({...options,authorize:async()=>false}),error=>error instanceof ImReflectionTailError&&error.code==='unauthorized')
   let calls=0;await assert.rejects(loadImReflectionPassiveTail({...options,authorize:async()=>++calls===1}),ImReflectionTailError)
   await f.pool.query('UPDATE user_bots SET enabled=false WHERE id=$1',[f.botId])
   await assert.rejects(loadImReflectionPassiveTail(options),ImReflectionTailError)
   await f.pool.query('UPDATE user_bots SET enabled=true WHERE id=$1',[f.botId])
   const signal=AbortSignal.abort('synthetic-private-reason')
   await assert.rejects(loadImReflectionPassiveTail(options,signal),error=>error instanceof ImReflectionTailError&&!error.message.includes('private')&&!error.cause)
  })
 }finally{await f.close()}
})
