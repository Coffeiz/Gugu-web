import type {PoolClient} from 'pg'
import type {RunIdentity} from '@gugu/core/agent'
import {agentDispatchSource,decryptAgentDispatchInput,type AgentDispatchInput,type ImAgentDispatchInput} from '../../../agent/run/dispatch.js'
import {createImInboundEnvelope} from './envelope.js'
import {imConversationEventId,imConversationDigest,imConversationFingerprint,imConversationScopeHash} from '../agent/identity.js'

export class ImDispatchOrderError extends Error{constructor(){super('IM 消息执行顺序暂不可用');this.name='ImDispatchOrderError'}}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)

/** 只串行已提交的同Bot/peer或群调度；自身session锁→scope锁，永不锁其他session。 */
export function createImDispatchOrder(options:{secretKey:string;diagnose?(code:'im_dispatch_order_unavailable'):void}){
 if(!options.secretKey)throw new ImDispatchOrderError()
 const envelope=createImInboundEnvelope(options.secretKey)
 async function prove(client:PoolClient,identity:RunIdentity,input:ImAgentDispatchInput){
  const route=input.im,binding={ownerId:identity.ownerId,platform:route.platform,botId:route.botId}
  const expected=imConversationScopeHash(options.secretKey,binding,{chat_type:route.chatType,chat_id:route.chatId,platform_user_id:route.platformUserId})
  const ids=input.im.batch?.messageIds??[input.userMessageId]
  const rows=(await client.query(`SELECT m.id,m.platform_user_id,m.im_platform_message_id,m.conversation_seq::text,
    r.scope_hash,r.event_hash,r.fingerprint,r.sealed_payload
    FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
    JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=s.id AND r.message_id=m.id
    WHERE s.id=$2 AND m.id=ANY($3::integer[]) AND m.role='user' AND m.run_id=$4 AND r.run_id=$4
     AND r.state='dispatched' AND r.platform=$5 AND r.bot_id=$6 AND r.chat_type=$7 AND m.chat_type=$7
     AND ($7='group' AND s.source=$5 AND s.bot_id=$6::text AND s.chat_type='group' AND s.chat_id=$8
       OR $7='c2c' AND m.platform_user_id=$9 AND s.chat_id IS NULL AND (s.chat_type='c2c' OR s.chat_type IS NULL)
        AND (s.source='web' OR s.source IS NULL OR s.source=$5 AND s.bot_id=$6::text))`,
   [identity.ownerId,identity.sessionId,ids,identity.runId,route.platform,route.botId,route.chatType,route.chatId,route.platformUserId])).rows
  const byId=new Map(rows.map(row=>[Number(row.id),row]))
  if(rows.length!==ids.length||byId.size!==ids.length)throw new ImDispatchOrderError()
  const sequences=new Set<number>()
  for(const id of ids){
   const row=byId.get(id)
   if(!row||!object(row.sealed_payload))throw new ImDispatchOrderError()
   const source=envelope.open(binding,row.sealed_payload),seq=Number(row.conversation_seq)
   const scopeHash=imConversationScopeHash(options.secretKey,binding,source)
   const attachments=Array.isArray(source.attachments)?source.attachments.map(value=>typeof value==='string'?value:object(value)?value.attach_id:null):[]
   const native=source.platform_message_id??source.message_id
   if(!Number.isSafeInteger(seq)||seq<1||sequences.has(seq)||scopeHash!==expected||row.scope_hash!==expected||source.chat_type!==route.chatType
    ||route.chatType==='group'&&source.chat_id!==route.chatId||source.platform_user_id!==row.platform_user_id
    ||route.chatType==='c2c'&&source.platform_user_id!==route.platformUserId
    ||attachments.some(value=>typeof value!=='string')||row.fingerprint!==imConversationFingerprint(options.secretKey,scopeHash,source,attachments as string[])
    ||row.event_hash!==imConversationDigest(options.secretKey,[scopeHash,source.platform_user_id,imConversationEventId(source)])
    ||(route.platform==='wechat'?row.im_platform_message_id!==null||source.message_id!==source.context_token:typeof native!=='string'||row.im_platform_message_id!==native||route.platform==='telegram'&&!/^[1-9]\d*$/.test(native)))throw new ImDispatchOrderError()
   sequences.add(seq)
  }
  if(byId.get(input.userMessageId)?.platform_user_id!==route.platformUserId)throw new ImDispatchOrderError()
  return expected
 }
 return{async beforeClaim(client:PoolClient,identity:RunIdentity,input:AgentDispatchInput):Promise<boolean>{
  try{
   const source=agentDispatchSource(input)
   if(source==='web')return true
   if(source!=='im'||input.v!==3||input.source!=='im')return false
   const scopeHash=await prove(client,identity,input)
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['gugu-im-dispatch-order-v1:'+scopeHash])
   const current=(await client.query('SELECT sequence::text FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND run_id=$3',[identity.ownerId,identity.sessionId,identity.runId])).rows[0]
   if(!current||typeof current.sequence!=='string'||!/^\d+$/.test(current.sequence))throw new ImDispatchOrderError()
   const earlier=(await client.query(`SELECT DISTINCT d.session_id,d.run_id,d.sequence,d.nonce,d.payload FROM agent_run_dispatch d
     JOIN gugu_im_inbound_receipts r ON r.user_id=d.user_id AND r.session_id=d.session_id AND r.run_id=d.run_id
     WHERE d.user_id=$1 AND d.sequence<$2::bigint AND d.state IN ('queued','selected')
       AND r.platform=$3 AND r.bot_id=$4 AND r.chat_type=$5 AND r.scope_hash=$6 AND r.state='dispatched'
     ORDER BY d.sequence LIMIT 1`,[identity.ownerId,current.sequence,input.im.platform,input.im.botId,input.im.chatType,scopeHash])).rows[0]
   if(!earlier)return true
   const other={ownerId:identity.ownerId,sessionId:String(earlier.session_id),runId:String(earlier.run_id)}
   const prior=decryptAgentDispatchInput(options.secretKey,other,earlier.nonce,earlier.payload)
   if(agentDispatchSource(prior)!=='im'||prior.v!==3||prior.source!=='im'||await prove(client,other,prior)!==scopeHash)throw new ImDispatchOrderError()
   return false
  }catch{
   try{options.diagnose?.('im_dispatch_order_unavailable')}catch{/* 固定诊断不改变持久状态。 */}
   throw new ImDispatchOrderError()
  }
 }}
}
