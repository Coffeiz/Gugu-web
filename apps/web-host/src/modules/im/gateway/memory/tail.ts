import type {Pool} from 'pg'
import {formatGroupMessage,type CanonicalMessage,type RunIdentity} from '@gugu/core/agent'
import type {ImActor} from '@gugu/core/im/access'
import {createImInboundEnvelope} from '../inbound/envelope.js'
import {imConversationEventId,imConversationDigest,imConversationFingerprint,imConversationScopeHash} from '../agent/identity.js'

export class ImReflectionTailError extends Error{
 constructor(readonly code:'deferred'|'invalid'|'unauthorized'){super('IM 反思被动尾段暂不可用');this.name='ImReflectionTailError'}
}
export interface ImReflectionPassiveTailInput{
 pool:Pick<Pool,'query'>;secretKey:string;identity:RunIdentity;actor:ImActor
 snapshotMessageIds:readonly string[];targetMessageIds:readonly string[];throughMessageId:string
 authorize(signal?:AbortSignal):Promise<boolean>
}
const fail=(code:ImReflectionTailError['code']='invalid')=>new ImReflectionTailError(code)
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const positive=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d*$/u.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)<=2147483647
const sequence=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d*$/u.test(value)&&Number.isSafeInteger(Number(value))
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=8192&&!/[\u0000-\u001f\u007f]/u.test(value)
interface Anchor{id:string;sequence:string;run_id:string|null;role:string}
interface Tail extends Anchor{
 content:string|null;has_content_json:boolean;quoted_text:string|null;platform_user_id:string|null;platform_user_name:string|null;chat_type:string|null
 im_platform_message_id:string|null;im_reply_to_message_id:string|null;receipt_platform:string|null;receipt_bot_id:string|null;receipt_chat_type:string|null
 receipt_run_id:string|null;state:string|null;scope_hash:string|null;event_hash:string|null;fingerprint:string|null;sealed_payload:unknown;total_bytes:string
}

/** 保留真实Run前缀，只追加已证明的同群passive尾段；不发Provider、不修改游标，也不冷重建快照。 */
export async function loadImReflectionPassiveTail(input:ImReflectionPassiveTailInput,signal?:AbortSignal):Promise<{
 messages:CanonicalMessage[];persistedMessageIds:string[]
}>{
 try{
  const identity={...input.identity},actor=structuredClone(input.actor),covered=[...input.snapshotMessageIds],targets=[...input.targetMessageIds]
  const through=input.throughMessageId
  if(!input.secretKey||actor.chatType!=='group'||!['feishu','qq','telegram'].includes(actor.platform)||actor.ownerId!==identity.ownerId
   ||!identifier(actor.chatId)||!positive(actor.botId)||!positive(identity.sessionId)||!identifier(identity.runId)
   ||!covered.length||covered.length>10000||!targets.length||targets.length>1000||!positive(through)
   ||covered.some(id=>!positive(id))||targets.some(id=>!positive(id))||new Set(covered).size!==covered.length||new Set(targets).size!==targets.length)throw fail()
  async function authorize(){signal?.throwIfAborted();if(await input.authorize(signal)!==true)throw fail('unauthorized');signal?.throwIfAborted()}
  await authorize()
  const scope=await input.pool.query(`SELECT s.id FROM conversation_sessions s JOIN users u ON u.id=s.user_id
   JOIN user_bots b ON b.user_id=s.user_id AND b.id::text=s.bot_id AND b.platform=s.source
   WHERE s.user_id=$1 AND s.id=$2 AND s.source=$3 AND s.bot_id=$4 AND s.chat_type='group' AND s.chat_id=$5
    AND u.is_active IS TRUE AND u.account_status='active' AND b.enabled IS TRUE
    AND (CASE WHEN b.platform='feishu' THEN COALESCE(b.feishu_group_chat_enabled,true) ELSE b.group_chat_enabled END) IS TRUE`,
   [identity.ownerId,identity.sessionId,actor.platform,actor.botId,actor.chatId])
  if(scope.rows.length!==1)throw fail('unauthorized')
  const wanted=[...new Set([...covered,...targets,through])]
  const anchors=(await input.pool.query<Anchor>(`SELECT id::text,conversation_seq::text AS sequence,run_id,role FROM conversation_messages
   WHERE session_id=$1 AND id=ANY($2::integer[])`,[identity.sessionId,wanted])).rows
  const byId=new Map(anchors.map(row=>[row.id,row]))
  if(anchors.length!==wanted.length||byId.size!==wanted.length)throw fail('deferred')
  if(anchors.some(row=>!sequence(row.sequence))||new Set(anchors.map(row=>row.sequence)).size!==anchors.length)throw fail()
  if(!covered.some(id=>byId.get(id)!.run_id===identity.runId))throw fail('deferred')
  const watermark=Math.max(...covered.map(id=>Number(byId.get(id)!.sequence))),throughSequence=Number(byId.get(through)!.sequence)
  for(const id of targets){const row=byId.get(id)!
   if(row.role!=='user'||Number(row.sequence)>throughSequence)throw fail()
   if(!covered.includes(id)&&row.run_id!==identity.runId&&Number(row.sequence)<=watermark)throw fail('deferred')
  }
  // 超限行仍返回骨架以明确拒绝；不把条件写成WHERE后静默丢掉一部分尾段。
  const rows=(await input.pool.query<Tail>(`WITH tail AS (
   SELECT m.id::text,m.conversation_seq::text AS sequence,m.run_id,m.role,m.content,m.content_json IS NOT NULL AS has_content_json,m.quoted_text,m.platform_user_id,m.platform_user_name,m.chat_type,
    m.im_platform_message_id,m.im_reply_to_message_id,r.platform AS receipt_platform,r.bot_id AS receipt_bot_id,r.chat_type AS receipt_chat_type,
    r.run_id AS receipt_run_id,r.state,r.scope_hash,r.event_hash,r.fingerprint,r.sealed_payload,
    sum(octet_length(COALESCE(m.content,''))+COALESCE(pg_column_size(r.sealed_payload),0)+512) OVER()::text AS total_bytes
   FROM conversation_messages m LEFT JOIN gugu_im_inbound_receipts r ON r.user_id=$1 AND r.session_id=m.session_id AND r.message_id=m.id
   WHERE m.session_id=$2 AND m.conversation_seq>$3 AND m.conversation_seq<=$4)
   SELECT id,sequence,run_id,role,CASE WHEN total_bytes::bigint<=8388608 THEN content END AS content,
    has_content_json,quoted_text,platform_user_id,platform_user_name,chat_type,im_platform_message_id,im_reply_to_message_id,
    receipt_platform,receipt_bot_id,receipt_chat_type,receipt_run_id,state,scope_hash,event_hash,fingerprint,
    CASE WHEN total_bytes::bigint<=8388608 THEN sealed_payload END AS sealed_payload,total_bytes
   FROM tail ORDER BY sequence::bigint,id::integer LIMIT 1001`,[identity.ownerId,identity.sessionId,watermark,throughSequence])).rows
  if(rows.length>1000||rows.some(row=>!sequence(row.sequence)||Number(row.total_bytes)>8388608))throw fail('deferred')
  if(new Set(rows.map(row=>row.id)).size!==rows.length||new Set(rows.map(row=>row.sequence)).size!==rows.length)throw fail()
  const messages:CanonicalMessage[]=[],persistedMessageIds:string[]=[],binding={ownerId:identity.ownerId,platform:actor.platform,botId:actor.botId}
  const envelope=createImInboundEnvelope(input.secretKey)
  for(const row of rows){
   // 原Run助手输出先进入真实wire，随后才获得数据库ID，不能把它误判为后续Run。
   if(row.run_id===identity.runId){if(!['user','assistant'].includes(row.role))throw fail('deferred');continue}
   if(row.run_id!==null||row.role!=='user')throw fail('deferred')
   if(row.state!=='passive'||row.receipt_run_id!==null)throw fail('deferred')
   if(row.receipt_platform!==actor.platform||row.receipt_bot_id!==actor.botId||row.receipt_chat_type!=='group'
    ||row.chat_type!=='group'||!identifier(row.platform_user_id)||typeof row.content!=='string'||row.has_content_json
    ||!object(row.sealed_payload))throw fail()
   const payload=envelope.open(binding,row.sealed_payload),native=payload.platform_message_id??payload.message_id
   const ids=payload.attachments==null?[]:Array.isArray(payload.attachments)?payload.attachments.map(item=>typeof item==='string'?item:object(item)?item.attach_id:null):null
   if(!ids||ids.length>100||ids.some(id=>!identifier(id))||new Set(ids).size!==ids.length)throw fail()
   const attachments=ids as string[],scopeHash=imConversationScopeHash(input.secretKey,binding,payload)
   if(payload.owner_user_id!==identity.ownerId||payload.platform!==actor.platform||payload.bot_id!==actor.botId||payload.chat_type!=='group'||payload.chat_id!==actor.chatId
    ||payload.platform_user_id!==row.platform_user_id||(payload.platform_user_name??null)!==row.platform_user_name||payload.text!==row.content||(payload.quoted_text??null)!==row.quoted_text
    ||!identifier(native)||native!==row.im_platform_message_id||(payload.reply_to_platform_message_id??null)!==row.im_reply_to_message_id
    ||actor.platform==='telegram'&&!positive(native)||row.scope_hash!==scopeHash
    ||row.event_hash!==imConversationDigest(input.secretKey,[scopeHash,payload.platform_user_id,imConversationEventId(payload)])
    ||row.fingerprint!==imConversationFingerprint(input.secretKey,scopeHash,payload,attachments)
    ||payload.conversation_seq!==undefined&&Number(payload.conversation_seq)!==Number(row.sequence))throw fail()
   const text=formatGroupMessage({body:row.content,senderId:row.platform_user_id,senderName:row.platform_user_name,quote:row.quoted_text,attachmentIds:attachments})
   messages.push({role:'user',content:text,_history_id:row.id,_history_envelope:{source:actor.platform,sender:{id:row.platform_user_id,name:row.platform_user_name},
    quote:row.quoted_text?{type:'quote',text:row.quoted_text}:null,attachments:[]}})
   persistedMessageIds.push(row.id)
  }
  // 缺receipt/变化的目标不能被空结果或截断后的结果伪装成完整追加。
  if(targets.some(id=>!covered.includes(id)&&byId.get(id)!.run_id!==identity.runId&&!persistedMessageIds.includes(id)))throw fail('deferred')
  await authorize()
  return{messages,persistedMessageIds}
 }catch(error){if(signal?.aborted)throw fail('deferred');if(error instanceof ImReflectionTailError)throw error;throw fail()}
}
