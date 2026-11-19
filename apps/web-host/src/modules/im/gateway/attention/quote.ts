import {createHash} from 'node:crypto'
import type {Pool} from 'pg'
import type {ImAttachmentScope} from '../inbound/attachments.js'
import {imAttachmentScopeKey} from '../inbound/attachments.js'
import {createImInboundEnvelope} from '../inbound/envelope.js'
import {imConversationDigest,imConversationFingerprint,imConversationScopeHash} from '../agent/identity.js'
import {createImRunScope} from '../agent/scope.js'
import type {ImVoiceRunProof} from './voice.js'

type Value=Record<string,unknown>
const invalid=()=>new Error('IM 引用语音来源不可用')
const object=(v:unknown):v is Value=>!!v&&typeof v==='object'&&!Array.isArray(v)
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const attachmentIds=(p:Value)=>{
 if(!Array.isArray(p.attachments))throw invalid()
 const ids=p.attachments.map(v=>typeof v==='string'?v:object(v)?v.attach_id:null)
 if(ids.some(v=>typeof v!=='string'||!v)||new Set(ids).size!==ids.length)throw invalid()
 return ids as string[]
}
/** 引用副本与原消息双证明。只支持现有reuse形成的同scope本地副本，不从引用正文/字幕推断来源。 */
export async function assertImQuotedVoiceSource(options:{pool:Pick<Pool,'query'>;secretKey:string;scope:ImAttachmentScope;payload:Value;attachment:Value}):Promise<string>{
 try{
  const {scope,payload,attachment}=options,extra=attachment.extra
  const reply=payload.reply_to_platform_message_id
  if(!object(extra)||extra.quoted!==true||!['voice','audio'].includes(String(attachment.kind))||typeof reply!=='string'||!reply||reply.length>8192
   ||payload.chat_type!==scope.chatType||scope.chatType==='group'&&payload.chat_id!==scope.chatId
   ||scope.chatType==='c2c'&&payload.platform_user_id!==scope.platformUserId||payload.owner_user_id!==scope.ownerId
   ||payload.bot_id!==scope.botId||payload.platform!==scope.platform||!['telegram','qq'].includes(scope.platform))throw invalid()
  const scopeKey=imAttachmentScopeKey(scope),native=payload.platform_message_id??payload.message_id
  const transportChat=scope.chatType==='group'?scope.chatId:payload.chat_id
  if(scope.platform==='telegram'&&(typeof transportChat!=='string'||!transportChat))throw invalid()
  const source=scope.platform==='telegram'?`${scope.botId}:${transportChat}:${reply}`:reply
  const target=scope.platform==='telegram'?`${scope.botId}:${transportChat}:${String(native)}`:String(native)
  if(scope.platform==='telegram'&&!/^[1-9]\d*$/u.test(reply))throw invalid()
  const indices=Array.from({length:101},(_,index)=>index).filter(index=>extra.im_ingress_source===hash([scopeKey,target,index,true]))
  if(indices.length!==1||extra.im_ingress_scope!==scopeKey)throw invalid()
  const rows=(await options.pool.query(`SELECT a.attach_id,a.storage_key,a.ext,a.mime,a.kind,a.size,a.duration,a.extra,
    m.id,m.run_id AS message_run_id,m.platform_user_id,m.im_platform_message_id,m.content,m.quoted_text,
    r.scope_hash,r.event_hash,r.fingerprint,r.sealed_payload,r.state,r.run_id
    FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id
    JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=a.user_id
    JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=s.id AND r.message_id=m.id
    WHERE a.user_id=$1 AND a.platform=$2 AND a.state='attached' AND a.extra->>'im_ingress_scope'=$3
      AND a.extra->>'im_ingress_source'=$4 AND a.storage_key=$5
      AND m.role='user' AND m.chat_type=$8 AND r.platform=$2 AND r.bot_id=$6 AND r.chat_type=$8
      AND ($8='group' AND s.source=$2 AND s.bot_id=$6 AND s.chat_type='group' AND s.chat_id=$7
        OR $8='c2c' AND m.platform_user_id=$9 AND s.chat_id IS NULL AND (s.chat_type='c2c' OR s.chat_type IS NULL)
          AND (s.source='web' OR s.source IS NULL OR s.source=$2 AND s.bot_id=$6))`,
   [scope.ownerId,scope.platform,scopeKey,hash([scopeKey,source,indices[0],false]),attachment.storage_key,scope.botId,scope.chatId,scope.chatType,scope.platformUserId])).rows
  if(rows.length!==1)throw invalid()
  const original=rows[0]!,originExtra=original.extra,binding={ownerId:scope.ownerId,platform:scope.platform,botId:scope.botId}
  if(!object(originExtra)||originExtra.quoted===true||originExtra.im_ingress_fingerprint!==extra.im_ingress_fingerprint
    ||!['ext','mime','kind','size','duration'].every(key=>String(original[key]??'')===String(attachment[key]??''))||!object(original.sealed_payload))throw invalid()
  const stored=createImInboundEnvelope(options.secretKey).open(binding,original.sealed_payload)
  const ids=attachmentIds(stored),scopeHash=imConversationScopeHash(options.secretKey,binding,stored),originNative=stored.platform_message_id??stored.message_id
  if(scopeHash!==original.scope_hash||scopeHash!==imConversationScopeHash(options.secretKey,binding,payload)||originNative!==reply
   ||original.im_platform_message_id!==reply||stored.platform_user_id!==original.platform_user_id||stored.text!==original.content
   ||(stored.quoted_text??null)!==(original.quoted_text??null)||stored.chat_type!==scope.chatType
   ||scope.chatType==='group'&&stored.chat_id!==scope.chatId
   ||scope.chatType==='c2c'&&(stored.platform_user_id!==scope.platformUserId||stored.chat_id!==payload.chat_id)
   ||!ids.includes(String(original.attach_id))||original.event_hash!==imConversationDigest(options.secretKey,[scopeHash,stored.platform_user_id,stored._pending_ask_resume_id||originNative])
   ||original.fingerprint!==imConversationFingerprint(options.secretKey,scopeHash,stored,ids)
   ||!(original.state==='passive'&&original.run_id===null&&original.message_run_id===null
     ||original.state==='dispatched'&&typeof original.run_id==='string'&&original.run_id&&original.message_run_id===original.run_id))throw invalid()
  return hash([original.attach_id,original.storage_key,original.extra,original.scope_hash,original.event_hash,original.fingerprint,original.sealed_payload])
 }catch{throw invalid()}
}

/** 正式Run调用方传入原sealed route/actor，不能仅按调用者给出的附件ID授权。 */
export function createImQuotedVoiceProof(options:{pool:Pick<Pool,'query'>;secretKey:string;proof:ImVoiceRunProof;
 historicalProof?(messageId:string,attachId:string,signal?:AbortSignal):Promise<ImVoiceRunProof>}){
 const proof={...options.proof,identity:Object.freeze({...options.proof.identity}),scope:Object.freeze({...options.proof.scope}),actor:structuredClone(options.proof.actor),
  payload:structuredClone(options.proof.payload),messageIds:[...options.proof.messageIds]},reader=createImRunScope({...proof,pool:options.pool,secretKey:options.secretKey})
 return{async assert(input:{messageId:string;attachId:string},signal?:AbortSignal){
  try{
   signal?.throwIfAborted();await reader.read()
   const index=proof.messageIds.indexOf(input.messageId)
   if(index<0){
    if(!options.historicalProof)throw invalid()
    const resolved=await options.historicalProof(input.messageId,input.attachId,signal)
    const old={...resolved,identity:Object.freeze({...resolved.identity}),scope:Object.freeze({...resolved.scope}),actor:structuredClone(resolved.actor),
     payload:structuredClone(resolved.payload),messageIds:[...resolved.messageIds]}
    if(old.identity.ownerId!==proof.identity.ownerId||old.identity.sessionId!==proof.identity.sessionId||old.identity.runId===proof.identity.runId
     ||old.scope.ownerId!==proof.scope.ownerId||old.scope.platform!==proof.scope.platform||old.scope.botId!==proof.scope.botId
     ||old.scope.chatType!==proof.scope.chatType||old.scope.chatId!==proof.scope.chatId
     ||proof.scope.chatType==='c2c'&&old.scope.platformUserId!==proof.scope.platformUserId||!old.messageIds.includes(input.messageId))throw invalid()
    const rows=(await options.pool.query<{id:string;conversation_seq:string;run_id:string;receipt_run_id:string;state:string}>(`SELECT m.id::text,m.conversation_seq::text,m.run_id,r.run_id AS receipt_run_id,r.state
      FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
      JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=s.id AND r.message_id=m.id
      WHERE s.id=$2 AND m.id=ANY($3::integer[]) AND m.role='user' AND r.platform=$4 AND r.bot_id=$5 AND r.chat_type=$6`,
     [proof.identity.ownerId,proof.identity.sessionId,[...proof.messageIds,input.messageId],proof.scope.platform,proof.scope.botId,proof.scope.chatType])).rows
    const target=rows.find(row=>row.id===input.messageId),current=proof.messageIds.map(id=>rows.find(row=>row.id===id))
    if(rows.length!==proof.messageIds.length+1||!target||target.run_id!==old.identity.runId||target.receipt_run_id!==old.identity.runId||target.state!=='dispatched'
     ||!/^[1-9]\d*$/.test(target.conversation_seq)||current.some(row=>!row||row.run_id!==proof.identity.runId||row.receipt_run_id!==proof.identity.runId
       ||row.state!=='dispatched'||!/^[1-9]\d*$/.test(row.conversation_seq)||BigInt(target.conversation_seq)>=BigInt(row.conversation_seq)))throw invalid()
    const oldAnchors=(await options.pool.query<{id:string}>(`SELECT m.id::text FROM conversation_messages m
      JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
      JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=s.id AND r.message_id=m.id
      WHERE s.id=$2 AND m.run_id=$3 AND r.run_id=$3 AND m.role='user' AND r.state='dispatched'
        AND r.platform=$4 AND r.bot_id=$5 AND r.chat_type=$6`,
     [proof.identity.ownerId,proof.identity.sessionId,old.identity.runId,proof.scope.platform,proof.scope.botId,proof.scope.chatType])).rows
    if(oldAnchors.length!==old.messageIds.length||new Set(old.messageIds).size!==oldAnchors.length||oldAnchors.some(row=>!old.messageIds.includes(row.id)))throw invalid()
    await createImQuotedVoiceProof({pool:options.pool,secretKey:options.secretKey,proof:{...old,async authorize(currentSignal){
     return await proof.authorize(currentSignal)===true&&await old.authorize(currentSignal)===true
    }}}).assert(input,signal)
    await reader.read();signal?.throwIfAborted();return
   }
   const facts=Array.isArray(proof.payload._batch_messages)?proof.payload._batch_messages:[proof.payload],payload=facts[index]
   if(index<0||!object(payload)||!attachmentIds(payload).includes(input.attachId))throw invalid()
   const rows=(await options.pool.query(`SELECT a.* FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id
     JOIN conversation_sessions s ON s.id=m.session_id WHERE a.user_id=$1 AND s.user_id=$1 AND s.id=$2
       AND m.id=$3 AND m.run_id=$4 AND a.attach_id=$5 AND a.state='attached' AND a.platform=$6`,
    [proof.identity.ownerId,proof.identity.sessionId,input.messageId,proof.identity.runId,input.attachId,proof.scope.platform])).rows
   if(rows.length!==1)throw invalid()
   await assertImQuotedVoiceSource({pool:options.pool,secretKey:options.secretKey,scope:proof.scope,payload,attachment:rows[0]!})
   await reader.read();signal?.throwIfAborted()
  }catch{throw invalid()}
 }}
}
