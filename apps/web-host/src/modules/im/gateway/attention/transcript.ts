import { classifyGatewayGroupMessage } from '@gugu/gateway'
import {createHash} from 'node:crypto'
import type {Pool} from 'pg'
import {openLocalFile} from '@gugu/fs/node'
import {stableJson} from '@gugu/core/agent'
import {imActorInputFromPayload} from '@gugu/core/im/access'
import {createPostgresImAccess} from '../inbound/access.js'
import {createPostgresImConversationStore} from '../agent/conversations.js'
import {createImInboundEnvelope} from '../inbound/envelope.js'
import {imConversationEventId,imConversationDigest,imConversationFingerprint,imConversationScopeHash} from '../agent/identity.js'
import {imAttachmentScopeKey,type ImAttachmentScope} from '../inbound/attachments.js'
import {isOwnedFileStorageKey} from '../../../files/store.js'
import type {ImAttentionVoiceReadInput,ImAttentionVoiceSource} from './voice.js'
import {assertImQuotedVoiceSource} from './quote.js'

type Payload=Record<string,unknown>
type SegmentReader=ReturnType<typeof createPostgresImConversationStore>['readValidatedStartedSegment']
const invalid=()=>new Error('IM 注意力语音来源不可用')
const object=(v:unknown):v is Payload=>!!v&&typeof v==='object'&&!Array.isArray(v)
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
function ids(payload:Payload):string[]{
 if(payload.attachments!=null&&!Array.isArray(payload.attachments))throw invalid()
 const values=(payload.attachments as unknown[]??[]).map(v=>typeof v==='string'?v:object(v)?v.attach_id:null)
 if(values.some(v=>typeof v!=='string'||!v)||new Set(values).size!==values.length)throw invalid()
 return values as string[]
}

/** started草稿与被动历史共用真实来源证明；不持有PG事务执行文件读取或ASR。 */
export function createImAttentionVoiceSource(options:{
 pool:Pick<Pool,'query'|'connect'>;secretKey:string;storageRoot:string
 supportedPlatforms():readonly string[]|Promise<readonly string[]>
 readSegment?:SegmentReader
}){
 const envelope=createImInboundEnvelope(options.secretKey)
 const access=createPostgresImAccess({query:(sql,args)=>options.pool.query(sql,args),supportedPlatforms:options.supportedPlatforms})
 const reader=options.readSegment??createPostgresImConversationStore({pool:options.pool,secretKey:options.secretKey,attachments:{mode:'text-only'},
  async authorize(client,binding,payload){
   const current=createPostgresImAccess({query:(sql,args)=>client.query(sql,args),supportedPlatforms:options.supportedPlatforms})
   return !!await current.resolveActor(imActorInputFromPayload(binding,payload))
  },
  async classify(client,binding,payload){
   const input=imActorInputFromPayload(binding,payload)
   const row=(await client.query(`SELECT group_requires_at,group_read_enabled FROM user_bots
    WHERE user_id=$1 AND id=$2::integer AND platform=$3 AND enabled IS TRUE`,[binding.ownerId,binding.botId,binding.platform])).rows[0]
   if(!row||typeof row.group_requires_at!=='boolean'||typeof row.group_read_enabled!=='boolean')throw invalid()
   return classifyGatewayGroupMessage({...input,groupMentioned:payload.group_mentioned===true},row.group_requires_at ? row.group_read_enabled ? 'record_only' : 'reply_mentions' : 'reply_all')??'reply'
  },
 }).readValidatedStartedSegment
 async function read(raw:ImAttentionVoiceReadInput,signal:AbortSignal):Promise<readonly ImAttentionVoiceSource[]>{
  const input=structuredClone(raw),{scope}=input,binding={ownerId:scope.ownerId,platform:scope.platform,botId:scope.botId}
  try{
   signal.throwIfAborted()
   if(!['feishu','qq','telegram'].includes(scope.platform)||!input.candidates.length||input.candidates.length>128
    ||!Number.isSafeInteger(input.sessionId)||input.sessionId<1||new Set(input.candidates.map(c=>c.eventId)).size!==input.candidates.length)throw invalid()
   const scopeHash=imConversationScopeHash(options.secretKey,binding,{chat_type:'group',chat_id:scope.groupId})
   const eventHashes=input.candidates.map(c=>{
    if(!/^\d+-\d+$/.test(c.eventId))throw invalid()
    const p=c.payload
    return imConversationDigest(options.secretKey,[scopeHash,p.platform_user_id,imConversationEventId(p)])
   })
   let expectedSegment:string|undefined,expectedState:string|undefined
   async function validate(currentSignal:AbortSignal){
    currentSignal.throwIfAborted()
    const checked=await reader(binding,{sessionId:input.sessionId,scopeHash,eventHashes})
    const {segment,state}=checked
    if(state==='completed'&&checked.mode!=='passive'||expectedSegment&&segment.segmentKey!==expectedSegment||expectedState&&state!==expectedState)throw invalid()
    const facts=segment.aggregate._batch_messages
    if(!Array.isArray(facts)||facts.length!==segment.anchors.length)throw invalid()
    const rows=(await options.pool.query(`SELECT m.id,m.content,m.content_json,m.files,m.quoted_text,m.platform_user_id,m.chat_type,m.im_platform_message_id,m.run_id AS message_run_id,
      r.scope_hash,r.event_hash,r.fingerprint,r.sealed_payload,r.state,r.run_id
      FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
      JOIN gugu_im_inbound_receipts r ON r.message_id=m.id AND r.session_id=s.id AND r.user_id=s.user_id
      WHERE s.id=$2 AND s.source=$3 AND s.bot_id=$4 AND s.chat_type='group' AND s.chat_id=$5
       AND m.id=ANY($6::integer[]) AND m.role='user' AND r.platform=$3 AND r.bot_id=$4 AND r.chat_type='group'`,
     [scope.ownerId,input.sessionId,scope.platform,scope.botId,scope.groupId,segment.anchors.map(a=>a.messageId)])).rows
    if(rows.length!==facts.length)throw invalid()
    const result:Array<{payload:Payload;row:Payload;attachments:string[]}>=[]
    for(const [index,value]of facts.entries()){
     if(!object(value))throw invalid()
     const row=rows.find(r=>Number(r.id)===segment.anchors[index]!.messageId)
     if(!row||!object(row.sealed_payload))throw invalid()
     const stored=envelope.open(binding,row.sealed_payload),attachments=ids(stored),native=stored.platform_message_id??stored.message_id
     const actor=imActorInputFromPayload(binding,stored)
     if(actor.chatType!=='group'||actor.chatId!==scope.groupId||stored._node_stream_event_id!==value._node_stream_event_id
      ||typeof stored._node_stream_event_id!=='string'||!/^\d+-\d+$/.test(stored._node_stream_event_id)
      ||imConversationScopeHash(options.secretKey,binding,stored)!==scopeHash||row.scope_hash!==scopeHash
      ||row.event_hash!==imConversationDigest(options.secretKey,[scopeHash,stored.platform_user_id,imConversationEventId(stored)])
      ||row.fingerprint!==imConversationFingerprint(options.secretKey,scopeHash,stored,attachments)
      ||stableJson(ids(value))!==stableJson(attachments)||stored.text!==value.text||stored.platform_user_id!==value.platform_user_id
      ||stored.chat_id!==value.chat_id||native!==(value.platform_message_id??value.message_id)
      ||(stored.quoted_text??null)!==(value.quoted_text??null)||row.content!==stored.text||row.content_json!=null
      ||row.platform_user_id!==stored.platform_user_id||row.chat_type!=='group'||row.im_platform_message_id!==native
      ||row.quoted_text!==(stored.quoted_text??null)||row.run_id!==null
      ||row.message_run_id!==(state==='started'?`im-pending:${String(row.event_hash).slice(0,32)}`:null)
      ||row.state!==(state==='started'?'staged':'passive')
      ||scope.platform==='telegram'&&!/^[1-9]\d*$/.test(String(native)))throw invalid()
     const cards=row.files==null?[]:row.files
     if(!Array.isArray(cards)||stableJson(cards.map(c=>object(c)?c.attach_id:null))!==stableJson(attachments))throw invalid()
     await access.resolveActor(actor)
     result.push({payload:stored,row,attachments})
    }
    let previous=-1
    for(const [index,candidate]of input.candidates.entries()){
     const found=result.find(r=>r.payload._node_stream_event_id===candidate.eventId)
     if(!found||found.row.event_hash!==eventHashes[index])throw invalid()
     const position=result.indexOf(found);if(position<=previous)throw invalid();previous=position
     // 模型或调用者附加的transcript没有效力；其余消息事实必须来自原始密封材料。
     const p=candidate.payload,s=found.payload
     if(p.owner_user_id!==scope.ownerId||p.platform!==scope.platform||p.bot_id!==scope.botId||p.chat_type!=='group'||p.chat_id!==scope.groupId
      ||p.platform_user_id!==s.platform_user_id||p.text!==s.text||(p.platform_message_id??p.message_id)!==(s.platform_message_id??s.message_id)
      ||stableJson(ids(p))!==stableJson(found.attachments)||(p.quoted_text??null)!==(s.quoted_text??null))throw invalid()
    }
    currentSignal.throwIfAborted()
    expectedSegment=segment.segmentKey;expectedState=state
    return {state,result}
   }
   const initial=await validate(signal),sources:ImAttentionVoiceSource[]=[]
   let totalBytes=0
   for(const candidate of input.candidates){
    const fact=initial.result.find(r=>r.payload._node_stream_event_id===candidate.eventId)!
    const attachmentScope:ImAttachmentScope={...binding,chatType:'group',chatId:scope.groupId,platformUserId:String(fact.payload.platform_user_id)}
    const ingressScope=imAttachmentScopeKey(attachmentScope),native=String(fact.payload.platform_message_id??fact.payload.message_id)
    // Telegram实际暂存器以Bot/chat/message复合键隔离文件；其他平台暂存器使用原生消息ID。
    const mediaSource=scope.platform==='telegram'?`${scope.botId}:${scope.groupId}:${native}`:native
    if(scope.platform==='telegram'&&fact.payload.attachment_source_message_id!=null&&fact.payload.attachment_source_message_id!==mediaSource)throw invalid()
    for(const attachId of fact.attachments){
     async function attachment(currentSignal:AbortSignal){
      await validate(currentSignal)
      const rows=(await options.pool.query(`SELECT attach_id,ext,mime,kind,size,storage_key,extra,message_id,state,duration,
        (created_at>clock_timestamp()-interval '24 hours') AS fresh FROM chat_attachments
        WHERE user_id=$1 AND attach_id=$2 AND platform=$3 AND extra->>'im_ingress_scope'=$4`,[scope.ownerId,attachId,scope.platform,ingressScope])).rows
      if(rows.length!==1)throw invalid()
      const row=rows[0]!,extra=row.extra
      if(!object(extra)||!isOwnedFileStorageKey(scope.ownerId,row.storage_key)||extra.im_ingress_scope!==ingressScope
       ||typeof extra.im_ingress_source!=='string'||typeof extra.im_ingress_receipt!=='string'||!/^[a-f0-9]{64}$/.test(String(extra.im_ingress_fingerprint))
       ||!Array.from({length:101},(_,index)=>hash([ingressScope,mediaSource,index,extra.quoted===true])).includes(extra.im_ingress_source)
       ||initial.state==='started'&&(row.state!=='draft'||row.message_id!==null||row.fresh!==true)
       ||initial.state==='completed'&&(row.state!=='attached'||Number(row.message_id)!==Number(fact.row.id)))throw invalid()
      const quoteProof=extra.quoted===true&&['voice','audio'].includes(row.kind)
       ?await assertImQuotedVoiceSource({pool:options.pool,secretKey:options.secretKey,scope:attachmentScope,payload:fact.payload,attachment:row}):null
      return {...row,_voice_quote_proof:quoteProof}
     }
     const row=await attachment(signal)
     if(!['audio','voice'].includes(row.kind))continue
     const size=Number(row.size)
     if(!Number.isSafeInteger(size)||size<1||size>50*1024*1024||typeof row.mime!=='string'||!/^audio\/[\w.+-]+$/.test(row.mime)
      ||typeof row.ext!=='string'||!/^[a-zA-Z0-9]{1,10}$/.test(row.ext))throw invalid()
     totalBytes+=size
     if(totalBytes>64*1024*1024)throw invalid()
     const file=await openLocalFile(options.storageRoot,row.storage_key)
     if(!file)throw invalid()
     let bytes:Buffer
     try{if(file.size!==size)throw invalid();bytes=await file.handle.readFile();if(bytes.length!==size)throw invalid()}
     finally{await file.handle.close()}
     const signature=stableJson(row)
     async function assertCurrent(currentSignal:AbortSignal){
      try{if(stableJson(await attachment(currentSignal))!==signature)throw invalid()}
      catch{currentSignal.throwIfAborted();throw invalid()}
     }
     await assertCurrent(signal)
     sources.push({identity:Object.freeze({ownerId:scope.ownerId,platform:scope.platform,botId:scope.botId,sessionId:String(input.sessionId),
      messageId:String(fact.row.id),attachId,scopeHash,eventHash:String(fact.row.event_hash),eventId:candidate.eventId}),
      input:Object.freeze({bytes,ext:row.ext,mime:row.mime,duration:row.duration,attachId}),mayRequest:initial.state==='started',assertCurrent})
    }
   }
   return sources
  }catch{signal.throwIfAborted();throw invalid()}
 }
 return {read}
}
