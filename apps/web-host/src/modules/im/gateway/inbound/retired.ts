import type {Pool,PoolClient} from 'pg'
import type {NodeImBotBinding} from './inbox.js'
import {imConversationEventId,imConversationDigest,imConversationScopeHash} from '../agent/identity.js'

export class ImRetiredInboundError extends Error{constructor(){super('IM 历史消费证明暂不可用');this.name='ImRetiredInboundError'}}
export interface ImRetiredInboundKey{ownerId:string;platform:string;botId:string;chatType:string;scopeHash:string;eventHash:string}
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v)
/** 只丢弃已认证平台身份的历史事件；不重新解释其编辑正文或重建的附件ID。 */
export function createImRetiredInbound(options:{pool:Pick<Pool,'query'>;secretKey:string}){
 if(!options.secretKey)throw new ImRetiredInboundError()
 async function seenLocked(client:Pick<PoolClient,'query'>,key:ImRetiredInboundKey):Promise<boolean>{
  try{
   if(!key.ownerId||!key.botId||!['feishu','qq','wechat','telegram'].includes(key.platform)||!['c2c','group'].includes(key.chatType)||!hex(key.scopeHash)||!hex(key.eventHash))throw new ImRetiredInboundError()
   const rows=(await client.query(`SELECT fingerprint FROM gugu_im_retired_inbound
    WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND chat_type=$4 AND scope_hash=$5 AND event_hash=$6`,
   [key.ownerId,key.platform,key.botId,key.chatType,key.scopeHash,key.eventHash])).rows
   if(rows.length>1||rows.some(row=>!hex(row.fingerprint)))throw new ImRetiredInboundError()
   return rows.length===1
  }catch{throw new ImRetiredInboundError()}
 }
 return{
  seenLocked,
  async seen(binding:NodeImBotBinding,payload:Readonly<Record<string,unknown>>,signal?:AbortSignal):Promise<boolean>{
   signal?.throwIfAborted()
   const scopeHash=imConversationScopeHash(options.secretKey,binding,payload),sender=payload.platform_user_id
   const event=imConversationEventId(payload)
   if(typeof sender!=='string'||!sender||typeof event!=='string'||!event)throw new ImRetiredInboundError()
   const result=await seenLocked(options.pool,{ownerId:binding.ownerId,platform:binding.platform,botId:binding.botId,
    chatType:String(payload.chat_type),scopeHash,eventHash:imConversationDigest(options.secretKey,[scopeHash,sender,event])})
   signal?.throwIfAborted();return result
  },
  /** 调用方先锁当前owner的session；同事务复制永久证明后才可删消息/会话。 */
  async markLocked(client:PoolClient,ownerId:string,sessionId:number,messageIds?:readonly number[]):Promise<void>{
   try{
    if(!ownerId||!Number.isSafeInteger(sessionId)||sessionId<1||messageIds?.some(id=>!Number.isSafeInteger(id)||id<1))throw new ImRetiredInboundError()
    const owned=await client.query('SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,sessionId])
    if(owned.rowCount!==1)throw new ImRetiredInboundError()
    const result=await client.query(`WITH source AS (
     SELECT r.user_id,r.platform,r.bot_id,r.chat_type,r.scope_hash,r.event_hash,r.fingerprint FROM gugu_im_inbound_receipts r
     WHERE r.user_id=$1 AND r.session_id=$2 AND ($3::integer[] IS NULL OR r.message_id=ANY($3::integer[]))
    ), copied AS (
     INSERT INTO gugu_im_retired_inbound AS old(user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint)
     SELECT user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint FROM source
     ON CONFLICT(user_id,platform,bot_id,chat_type,scope_hash,event_hash) DO UPDATE SET fingerprint=old.fingerprint
     WHERE old.fingerprint=EXCLUDED.fingerprint RETURNING 1
    ) SELECT (SELECT count(*) FROM source)::text AS source_count,(SELECT count(*) FROM copied)::text AS copied_count`,
    [ownerId,sessionId,messageIds?[...new Set(messageIds)]:null])
    const row=result.rows[0]
    if(!row||row.source_count!==row.copied_count)throw new ImRetiredInboundError()
   }catch{throw new ImRetiredInboundError()}
  },
 }
}
