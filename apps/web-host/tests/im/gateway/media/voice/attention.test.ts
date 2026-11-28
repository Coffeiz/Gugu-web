import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createImProductionFixture} from '../../production.fixtures.js'
import {createPostgresImAttachmentIngress} from '../../../../../src/modules/im/gateway/inbound/attachments.js'
import {createPostgresImConversationStore,type ImConversationSegment} from '../../../../../src/modules/im/gateway/agent/conversations.js'
import {createPostgresImAccess} from '../../../../../src/modules/im/gateway/inbound/access.js'
import {imActorInputFromPayload} from '@gugu/core/im/access'
import {createImAttentionVoiceSource} from '../../../../../src/modules/im/gateway/attention/transcript.js'
import {createPlatformMedia} from '../../../../../src/modules/im/gateway/media/platform.js'
import {createTelegramBotApi} from '@gugu/gateway/telegram'
import {normalizeTelegramMessage} from '@gugu/gateway/telegram'
import {truncate} from 'node:fs/promises'
import {join} from 'node:path'
import {createImVoiceCache} from '../../../../../src/modules/im/gateway/media/cache.js'
import {createImQuotedVoiceProof} from '../../../../../src/modules/im/gateway/attention/quote.js'
import {createImMessageMaterializer} from '../../../../../src/modules/im/gateway/inbound/message.js'
import type {ImVoiceRunProof} from '../../../../../src/modules/im/gateway/attention/voice.js'
import type {ImVoiceSelection} from '../../../../../src/modules/im/gateway/media/config.js'
import type {ContextReferenceCodec,MessageEntry} from '@gugu/core/agent'

function wav(){
 const b=Buffer.alloc(16044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16)
 b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28)
 b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(16000,40);return b
}
const enabled=!!process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL&&!!process.env.GUGU_IM_FIXTURE_PYTHON
test('真实PG started整段/草稿来源与安全文件读取，跨speaker篡改及撤权拒绝，passive只读缓存',
 {skip:enabled?false:'需显式隔离PG、Python和Linux本地FS，不等同生产验收'},async()=>{
 const f=await createImProductionFixture({python:process.env.GUGU_IM_FIXTURE_PYTHON!,platform:'telegram'})
 try{
  const supportedPlatforms=()=>['telegram'],signal=new AbortController().signal
  const binding={ownerId:f.ownerId,botId:f.botId,platform:'telegram' as const}
  const groupId='-1001234567'
  const storage=createPostgresImAttachmentIngress({pool:f.pool,storageRoot:f.storageRoot,supportedPlatforms})
  const attachmentScope={...binding,chatType:'group' as const,chatId:groupId,platformUserId:'202'}
  const platformMedia=createPlatformMedia({storage})
  const audio=wav(),api=createTelegramBotApi({transport:{async request(request){
   const bytes=new URL(request.url).pathname.endsWith('/getFile')?Buffer.from(JSON.stringify({ok:true,result:{file_path:'voice/synthetic.wav',file_size:audio.length}})):audio
   return {status:200,headers:{},body:(async function*(){yield bytes})(),cancel(){}}
  }}})
  const parsed=normalizeTelegramMessage({update_id:12,message:{message_id:11,date:1700000000,chat:{id:Number(groupId),type:'group'},from:{id:202},
   voice:{file_id:'synthetic-voice-id',file_unique_id:'synthetic-unique',duration:1,mime_type:'audio/wav',file_size:audio.length}}},
   {botId:f.botId,ownerId:f.ownerId,botUsername:'synthetic_bot',botPlatformId:'303'})!
  let prepared:Record<string,unknown>|null
  try{prepared=await platformMedia.telegram(attachmentScope,parsed,api,async()=> '123456789:synthetic_token_for_fixture',signal,async()=>{throw Error('不可发送错误说明')})}
  finally{await platformMedia.close();await api.close()}
  assert.ok(prepared)
  const firstId=(prepared.attachments as string[])[0]!
  const media={attachId:firstId}
  const second=await storage.stage({scope:attachmentScope,sourcePlatformMessageId:`${f.botId}:${groupId}:11`,
   sourceAttachmentIndex:1,name:'第二段合成语音',ext:'wav',mime:'audio/wav',bytes:wav(),voice:true},signal)
  const p=(id:string,sender:string,attachments:string[])=>({platform:'telegram',owner_user_id:f.ownerId,bot_id:f.botId,channel_id:f.botId,
   chat_type:'group',chat_id:groupId,platform_user_id:sender,message_id:id,platform_message_id:id,text:attachments.length?'':'合成批次另一发言人',attachments})
  const items=[{eventId:'1700000000000-0',payload:p('10','201',[])},{eventId:'1700000000001-0',payload:{...prepared,attachments:[media.attachId,second.attachId]}}]
  const store=createPostgresImConversationStore({pool:f.pool,secretKey:f.secretKey,attachments:storage.conversation({...binding,chatType:'group',chatId:groupId,platformUserId:'202'}),
   async authorize(client,b,payload){return !!await createPostgresImAccess({query:(sql,args)=>client.query(sql,args),supportedPlatforms}).resolveActor(imActorInputFromPayload(b,payload))},
   async classify(){return 'reply'}})
  let segment:ImConversationSegment|undefined
  await assert.rejects(store.persistBatch(binding,items,{mode:'dispatch',batchId:'synthetic-voice-batch',
   async beforeDispatch(value){segment=value;throw new Error('合成中断保留started段')},async onDispatch(){throw Error('不可启动Run')}}),/合成中断/)
  assert.ok(segment)
  const input={scope:{...binding,groupId},sessionId:segment.anchors[0]!.sessionId,
   candidates:(segment.aggregate._batch_messages as Record<string,unknown>[]).map(payload=>({eventId:String(payload._node_stream_event_id),payload}))}
  const source=createImAttentionVoiceSource({pool:f.pool,secretKey:f.secretKey,storageRoot:f.storageRoot,supportedPlatforms})
  const result=await source.read(input,signal)
  assert.equal(result.length,2);assert.equal(result[0]!.mayRequest,true);assert.equal(result[0]!.identity.attachId,media.attachId)
  assert.equal(result[0]!.identity.messageId,String(segment.anchors[1]!.messageId));assert.ok(result[0]!.input.bytes.byteLength>44)
  await result[0]!.assertCurrent(signal)
  // 两个各33MiB的合法来源累计超限；若只限制单文件，读取会错误成功并持有66MiB字节。
  const originals=(await f.pool.query('SELECT attach_id,size,storage_key FROM chat_attachments WHERE attach_id=ANY($1::text[])',[[media.attachId,second.attachId]])).rows
  try{
   for(const item of originals){await truncate(join(f.storageRoot,item.storage_key),33*1024*1024);await f.pool.query('UPDATE chat_attachments SET size=$2 WHERE attach_id=$1',[item.attach_id,33*1024*1024])}
   await assert.rejects(source.read(input,signal),/语音来源不可用/)
  }finally{
   for(const item of originals){await truncate(join(f.storageRoot,item.storage_key),Number(item.size));await f.pool.query('UPDATE chat_attachments SET size=$2 WHERE attach_id=$1',[item.attach_id,item.size])}
  }
  // 任意普通transcript输入没有来源效力，不成为送给ASR的字节或文本。
  const forged=structuredClone(input);forged.candidates[1]!.payload.transcript='模型伪造转写'
  assert.deepEqual((await source.read(forged,signal))[0]!.input.bytes,result[0]!.input.bytes)
  const changed=structuredClone(input);changed.candidates[0]!.payload.platform_user_id='999'
  await assert.rejects(source.read(changed,signal),/语音来源不可用/)
  const reversed=structuredClone(input);reversed.candidates.reverse()
  await assert.rejects(source.read(reversed,signal),/语音来源不可用/)
  await f.pool.query(`UPDATE conversation_messages SET platform_user_id='999' WHERE id=$1`,[segment.anchors[0]!.messageId])
  await assert.rejects(source.read(input,signal),/语音来源不可用/)
  await f.pool.query(`UPDATE conversation_messages SET platform_user_id='201' WHERE id=$1`,[segment.anchors[0]!.messageId])
  const originalRun=(await f.pool.query('SELECT run_id FROM conversation_messages WHERE id=$1',[segment.anchors[0]!.messageId])).rows[0]!.run_id
  await f.pool.query(`UPDATE conversation_messages SET run_id='unrelated-run' WHERE id=$1`,[segment.anchors[0]!.messageId])
  await assert.rejects(source.read(input,signal),/语音来源不可用/)
  await f.pool.query('UPDATE conversation_messages SET run_id=$2 WHERE id=$1',[segment.anchors[0]!.messageId,originalRun])
  const before=(await f.pool.query('SELECT extra FROM chat_attachments WHERE attach_id=$1',[media.attachId])).rows[0]!.extra
  await f.pool.query(`UPDATE chat_attachments SET extra=jsonb_set(extra::jsonb,'{im_ingress_source}',to_jsonb($2::text)) WHERE attach_id=$1`,[media.attachId,'a'.repeat(64)])
  await assert.rejects(result[0]!.assertCurrent(signal),/语音来源不可用/)
  await f.pool.query('UPDATE chat_attachments SET extra=$2::jsonb WHERE attach_id=$1',[media.attachId,JSON.stringify(before)])
  await f.pool.query('UPDATE user_bots SET enabled=false WHERE id=$1',[f.botId])
  await assert.rejects(result[0]!.assertCurrent(signal),/语音来源不可用/)
  await f.pool.query('UPDATE user_bots SET enabled=true WHERE id=$1',[f.botId])
  await store.persistBatch(binding,items,{mode:'dispatch',batchId:'synthetic-voice-batch',async beforeDispatch(){return {
   v:1,disposition:'pending',mode:'autonomous',configVersion:0,subjectEventId:'1700000000001-0',sourceAttentionKind:null,proactive:false,replyChoice:'reply'}},
   async validateAttention(){return true},async onDispatch(){throw Error('被动消息不可启动Run')}})
  const passive=await source.read(input,signal)
  assert.equal(passive.length,2);assert.equal(passive[0]!.mayRequest,false)
  const pendingSubset=await source.read({...input,candidates:[input.candidates[1]!]},signal)
  assert.equal(pendingSubset.length,2);assert.equal(pendingSubset[0]!.mayRequest,false)
  await assert.rejects(result[0]!.assertCurrent(signal),/语音来源不可用/)
  const other=structuredClone(input);other.scope.groupId='-1009876543'
  await assert.rejects(source.read(other,signal),/语音来源不可用/)
 }finally{await f.close()}
})

test('引用语音真实同群原消息/副本双证：attention转写→同事务Run绑定→materializer复用且字幕只入引用上下文',
 {skip:enabled?false:'需显式隔离PG、Python和Linux本地FS，不等同生产验收'},async()=>{
 const f=await createImProductionFixture({python:process.env.GUGU_IM_FIXTURE_PYTHON!,platform:'telegram'})
 try{
  const signal=new AbortController().signal,supportedPlatforms=()=>['telegram'],groupId='-1001234567'
  const binding={ownerId:f.ownerId,botId:f.botId,platform:'telegram' as const},scope={...binding,chatType:'group' as const,chatId:groupId,platformUserId:'202'}
  const storage=createPostgresImAttachmentIngress({pool:f.pool,storageRoot:f.storageRoot,supportedPlatforms})
  const original=await storage.stage({scope:{...scope,platformUserId:'201'},sourcePlatformMessageId:`${f.botId}:${groupId}:11`,sourceAttachmentIndex:0,
   name:'合成原消息语音',ext:'wav',mime:'audio/wav',bytes:wav(),voice:true},signal)
  let proof:ImVoiceRunProof|undefined,calls=0,persisted=0
  const selected:ImVoiceSelection={ownerId:f.ownerId,version:'a'.repeat(64),configured:true,config:{model:'synthetic-asr'},
   profile:{configured:true,maxFileBytes:50*1024*1024,maxDurationSeconds:null,providerLabel:'合成',resolved:true},
   usage:{provider:'openai',model:'synthetic-asr',isByok:false,credentialId:null},async authorizeCurrent(){return true}}
  const cache=createImVoiceCache({pool:f.pool,secretKey:f.secretKey,voice:{async select(){return selected}},async transcribeSelected(source,_selection,currentSignal){
   calls++;await source.assertCurrent(currentSignal);assert.ok(source.input.bytes.length>44);return '被引用语音的合成转写'
  }})
  const store=createPostgresImConversationStore({pool:f.pool,secretKey:f.secretKey,attachments:storage.conversation(scope),
   async authorize(client,b,p){return !!await createPostgresImAccess({query:(sql,args)=>client.query(sql,args),supportedPlatforms}).resolveActor(imActorInputFromPayload(b,p))},
   async classify(_client,_b,p){return p.message_id==='11'?'passive':'reply'},
   async afterDispatch(client,b,p,identity,messageIds){
    const actor=await createPostgresImAccess({query:(sql,args)=>client.query(sql,args),supportedPlatforms}).resolveActor(imActorInputFromPayload(b,p));assert.ok(actor)
    proof={identity,actor,scope:{...scope,platformUserId:String(p.platform_user_id)},payload:p,messageIds,authorize:()=>createPostgresImAccess({query:(sql,args)=>f.pool.query(sql,args),supportedPlatforms}).authorizeDelivery(actor)}
    await cache.bindRunLocked(client,proof,signal)
   }})
  const originalPayload={...binding,owner_user_id:f.ownerId,bot_id:f.botId,channel_id:f.botId,chat_type:'group',chat_id:groupId,
   platform_user_id:'201',message_id:'11',platform_message_id:'11',text:'',attachments:[original.attachId]}
  const origin=await store.persist(binding,originalPayload,{eventId:'1700000000000-0',mode:'passive'});assert.ok(origin)
  const quoted=await storage.reuse({scope,sourcePlatformMessageId:`${f.botId}:${groupId}:11`,sourceAttachmentIndex:0,targetPlatformMessageId:`${f.botId}:${groupId}:22`},signal);assert.ok(quoted)
  const item={eventId:'1700000000001-0',payload:{...originalPayload,platform_user_id:'202',message_id:'22',platform_message_id:'22',
   text:'这段引用说了什么',quoted_text:'[voice 附件]',reply_to_platform_message_id:'11',attachments:[quoted.attachId]}}
  const items=[item,{eventId:'1700000000001-1',payload:{...originalPayload,platform_user_id:'303',message_id:'23',platform_message_id:'23',text:'同旧Run的另一发言人',attachments:[]}}]
  let segment:ImConversationSegment|undefined
  await assert.rejects(store.persistBatch(binding,items,{mode:'dispatch',batchId:'synthetic-quoted-voice',
   async beforeDispatch(value){segment=value;throw Error('合成中断保留started段')},async onDispatch(){throw Error('不可启动Run')}}),/合成中断/)
  assert.ok(segment)
  const readInput={scope:{...binding,groupId},sessionId:segment.anchors[0]!.sessionId,
   candidates:(segment.aggregate._batch_messages as Record<string,unknown>[]).map(payload=>({eventId:String(payload._node_stream_event_id),payload}))}
  const reader=createImAttentionVoiceSource({pool:f.pool,secretKey:f.secretKey,storageRoot:f.storageRoot,supportedPlatforms})
  const sources=await reader.read(readInput,signal);assert.equal(sources.length,1);assert.equal(sources[0]!.identity.attachId,quoted.attachId)
  assert.equal((await cache.prepare(sources,signal))[0]!.text,'被引用语音的合成转写');assert.equal(calls,1)
  const oldFingerprint=(await f.pool.query('SELECT fingerprint FROM gugu_im_inbound_receipts WHERE message_id=$1',[origin.messageId])).rows[0]!.fingerprint
  await f.pool.query("UPDATE gugu_im_inbound_receipts SET fingerprint='tampered' WHERE message_id=$1",[origin.messageId])
  await assert.rejects(sources[0]!.assertCurrent(signal),/语音来源不可用/)
  await f.pool.query('UPDATE gugu_im_inbound_receipts SET fingerprint=$2 WHERE message_id=$1',[origin.messageId,oldFingerprint])
  await store.persistBatch(binding,items,{mode:'dispatch',batchId:'synthetic-quoted-voice',
   async beforeDispatch(){return{v:1,disposition:'run',mode:'autonomous',configVersion:0,subjectEventId:item.eventId,sourceAttentionKind:'DIRECT',proactive:false,replyChoice:'pending'}},
   async validateAttention(){return true},async onDispatch(){return 'synthetic-quoted-voice-run'}})
  assert.ok(proof)
  const quoteProof=createImQuotedVoiceProof({pool:f.pool,secretKey:f.secretKey,proof})
  const materializer=createImMessageMaterializer({pool:f.pool,storageRoot:f.storageRoot,identity:proof.identity,scope,messageIds:proof.messageIds,
   timezone:'UTC',formatMessageTime:()=> '合成消息时间',authorize:proof.authorize,assertQuotedAudio:quoteProof.assert,
   async transcribe(input,currentSignal){const cached=await cache.readForRun(proof!,input,selected,currentSignal);assert.ok(cached);return cached.text},
   async persistTranscript(){persisted++}})
  const result=await materializer.materialize(proof.identity,{id:proof.messageIds.at(-1)!,content:'不可信调用正文',contentJson:null,files:[],references:[]},signal)
  const user=result.currentUser??result.currentUsers?.[0];assert.ok(user);assert.equal(user.rawText,'这段引用说了什么')
  const envelope=user.message._history_envelope as {quote?:{text?:string}}|undefined
  assert.match(envelope?.quote?.text??'',/被引用语音的合成转写/);assert.equal(persisted,0);assert.equal(calls,1)
  const files=(await f.pool.query('SELECT files FROM conversation_messages WHERE id=$1',[proof.messageIds[0]])).rows[0]!.files
  assert.equal(files[0].quoted,true);assert.equal(files[0].transcript,undefined)
  const oldProof=proof,oldMessageId=proof.messageIds[0]!
  assert.equal(oldProof.messageIds.length,2,'旧Run确为两个发起者的完整批次，目标引用语音并非最后锚点')
  const next=[{eventId:'1700000000002-0',payload:{...originalPayload,platform_user_id:'202',message_id:'24',platform_message_id:'24',text:'本轮新的发言',attachments:[]}},
   {eventId:'1700000000002-1',payload:{...originalPayload,platform_user_id:'404',message_id:'25',platform_message_id:'25',text:'本轮批次的后续发言',attachments:[]}}]
  await store.persistBatch(binding,next,{mode:'dispatch',batchId:'synthetic-new-run',
   async beforeDispatch(){return{v:1,disposition:'run',mode:'autonomous',configVersion:0,subjectEventId:next[0]!.eventId,sourceAttentionKind:'DIRECT',proactive:false,replyChoice:'pending'}},
   async validateAttention(){return true},async onDispatch(){return'synthetic-new-voice-run'}})
  const currentProof=proof;assert.notEqual(currentProof.identity.runId,oldProof.identity.runId)
  let resolves=0
  async function historicalProof(messageId:string,attachId:string):Promise<ImVoiceRunProof>{
   resolves++;assert.equal(messageId,oldMessageId);assert.equal(attachId,quoted!.attachId)
   const stored=(await f.pool.query(`SELECT m.run_id FROM conversation_messages m JOIN gugu_im_inbound_receipts r
     ON r.message_id=m.id AND r.session_id=m.session_id AND r.user_id=$1 WHERE m.id=$2 AND m.session_id=$3
       AND r.state='dispatched' AND r.run_id=m.run_id`,[f.ownerId,messageId,currentProof.identity.sessionId])).rows
   assert.equal(stored.length,1)
   const oldIdentity={...currentProof.identity,runId:String(stored[0]!.run_id)},route=await store.readRoute(oldIdentity)
   const actor=await createPostgresImAccess({query:(sql,args)=>f.pool.query(sql,args),supportedPlatforms}).resolveActor(imActorInputFromPayload(route.binding,route.payload))
   const batch=route.payload._inbound_batch as {messageIds:number[]}
   return{identity:oldIdentity,scope:{...scope,platformUserId:actor.platformUserId},actor,payload:route.payload,messageIds:batch.messageIds.map(String),
    authorize:()=>createPostgresImAccess({query:(sql,args)=>f.pool.query(sql,args),supportedPlatforms}).authorizeDelivery(actor)}
  }
  const historical=createImQuotedVoiceProof({pool:f.pool,secretKey:f.secretKey,proof:currentProof,historicalProof})
  const target={messageId:oldMessageId,attachId:quoted.attachId}
  await historical.assert(target,signal);assert.equal(resolves,1)
  await assert.rejects(createImQuotedVoiceProof({pool:f.pool,secretKey:f.secretKey,proof:currentProof}).assert(target,signal),/引用语音来源不可用/)
  for(const bad of [{...oldProof,identity:{...oldProof.identity,ownerId:'00000000-0000-4000-8000-000000000999'}},
   {...oldProof,scope:{...oldProof.scope,chatId:'-1009876543'}},{...oldProof,messageIds:[oldMessageId]}])
   await assert.rejects(createImQuotedVoiceProof({pool:f.pool,secretKey:f.secretKey,proof:currentProof,historicalProof:async()=>bad}).assert(target,signal),/引用语音来源不可用/)
  const passive:ContextReferenceCodec={async hydrate(value){return structuredClone(value.message)},async dehydrate(value){return structuredClone(value.message)}}
  const historyMaterializer=createImMessageMaterializer({pool:f.pool,storageRoot:f.storageRoot,identity:currentProof.identity,scope:currentProof.scope,messageIds:currentProof.messageIds,
   timezone:'UTC',formatMessageTime:()=> '合成时间',authorize:currentProof.authorize,assertQuotedAudio:historical.assert,
   async nativeAudio(input){return{type:'input_audio',input_audio:{format:'wav',data:`data:audio/wav;base64,${Buffer.from(input.bytes).toString('base64')}`}}}})
  const oldEntry:MessageEntry={entryId:'synthetic-old-quoted-history',sequence:1,revision:0,source:'restored_history',persistencePolicy:'already_persisted',
   message:{role:'user',content:[{type:'attachment_ref',attach_id:quoted.attachId,kind:'voice'}]}}
  const restored=await historyMaterializer.references(passive).hydrate(oldEntry,currentProof.identity,signal)
  assert.match(JSON.stringify(restored),/input_audio/);assert.equal(calls,1,'历史原生恢复不重复ASR')
  const otherAnchor=oldProof.messageIds[1]!,otherFp=(await f.pool.query('SELECT fingerprint FROM gugu_im_inbound_receipts WHERE message_id=$1',[otherAnchor])).rows[0]!.fingerprint
  await f.pool.query("UPDATE gugu_im_inbound_receipts SET fingerprint='tampered' WHERE message_id=$1",[otherAnchor])
  await assert.rejects(historical.assert(target,signal),/引用语音来源不可用/)
  await f.pool.query('UPDATE gugu_im_inbound_receipts SET fingerprint=$2 WHERE message_id=$1',[otherAnchor,otherFp])
  const oldSeq=(await f.pool.query('SELECT conversation_seq FROM conversation_messages WHERE id=$1',[oldMessageId])).rows[0]!.conversation_seq
  await f.pool.query('UPDATE conversation_messages SET conversation_seq=conversation_seq+1000 WHERE id=$1',[oldMessageId])
  await assert.rejects(createImQuotedVoiceProof({pool:f.pool,secretKey:f.secretKey,proof:currentProof,historicalProof:async()=>oldProof}).assert(target,signal),/引用语音来源不可用/)
  await f.pool.query('UPDATE conversation_messages SET conversation_seq=$2 WHERE id=$1',[oldMessageId,oldSeq])
  await f.pool.query("UPDATE chat_attachments SET state='draft',message_id=NULL WHERE attach_id=$1",[original.attachId])
  await assert.rejects(cache.readForRun(oldProof,sources[0]!.input,selected,signal),/语音识别收据暂不可用/)
  await assert.rejects(historical.assert(target,signal),/引用语音来源不可用/)
  await assert.rejects(quoteProof.assert(target,signal),/引用语音来源不可用/)
  assert.equal(calls,1)
 }finally{await f.close()}
})
