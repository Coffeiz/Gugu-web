import type { Pool } from 'pg'
import type { Json,RunIdentity } from '@gugu/core/agent'
import { strip } from '@gugu/core/shared/values'
import type { ImActor } from '@gugu/core/im/access'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import type { ImAttachmentScope } from '../inbound/attachments.js'
import { createImRunScope } from '../agent/scope.js'

export interface ImVoiceTranscriptStoreOptions {
  pool:Pick<Pool,'connect'|'query'>
  secretKey:string
  identity:RunIdentity
  scope:ImAttachmentScope
  actor:ImActor
  payload:Readonly<Record<string,unknown>>
  messageIds:readonly string[]
  authorize(signal?:AbortSignal):Promise<boolean>
}
export class ImVoiceTranscriptError extends Error{constructor(){super('语音转写结果暂未保存');this.name='ImVoiceTranscriptError'}}
const object=(v:unknown):v is Record<string,Json>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const positive=(v:string)=>/^[1-9]\d*$/u.test(v)&&Number.isSafeInteger(Number(v))&&Number(v)<=2147483647
const truthy=(v:unknown)=>Array.isArray(v)?v.length>0:object(v)?Object.keys(v).length>0:!!v

/** 仅持久化本次真实ASR结果；不缓存/重用模型响应，也不更改引用语音卡片。 */
export function createImVoiceTranscriptStore(options:ImVoiceTranscriptStoreOptions){
  const identity=Object.freeze({...options.identity}),scope=Object.freeze({...options.scope}),actor=structuredClone(options.actor)
  const ids=[...options.messageIds],payload=structuredClone(options.payload)
  // 构造时复用同一完整scope规则；真正proof查询必须借用事务client。
  createImRunScope({...options,identity,scope,actor,messageIds:ids,payload})
  return{async save(messageId:string,transcript:string|null,status:'completed'|'empty'|'failed',signal?:AbortSignal):Promise<Json[]|null>{
    if(!positive(messageId)||!ids.includes(messageId)||!['completed','empty','failed'].includes(status)
      ||transcript!==null&&(typeof transcript!=='string'||Buffer.byteLength(transcript)>1048576))throw new ImVoiceTranscriptError()
    try{return await withPostgresTransaction(options.pool,async client=>{
      signal?.throwIfAborted();if(await options.authorize(signal)!==true)throw new ImVoiceTranscriptError()
      // 同一顺序锁全批锚点，防处理某条语音时原Run其他发言人/收据被换置。
      const locked=await client.query<{id:string;files:unknown}>(`SELECT m.id::text,m.files FROM conversation_sessions s
        JOIN conversation_messages m ON m.session_id=s.id
        JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=s.id AND r.message_id=m.id
        WHERE s.user_id=$1 AND s.id=$2 AND m.id=ANY($3::integer[]) AND m.role='user' AND m.run_id=$4
          AND r.run_id=$4 AND r.state='dispatched' AND r.platform=$5 AND r.bot_id=$6 AND r.chat_type=$7
        ORDER BY m.id FOR UPDATE OF s,m,r`,[identity.ownerId,identity.sessionId,ids,identity.runId,scope.platform,scope.botId,scope.chatType])
      if(locked.rows.length!==ids.length||new Set(locked.rows.map(row=>row.id)).size!==ids.length)throw new ImVoiceTranscriptError()
      const proof=createImRunScope({...options,pool:client,identity,scope,actor,messageIds:ids,payload,authorize:async()=>{
        signal?.throwIfAborted();return options.authorize(signal)}})
      await proof.read()
      const row=locked.rows.find(row=>row.id===messageId)
      if(!row)throw new ImVoiceTranscriptError()
      if(!Array.isArray(row.files)){await proof.read();return null}
      const files:Json[]=structuredClone(row.files) as Json[]
      const card=files.find(value=>object(value)&&!truthy(value.quoted)&&value.kind==='voice')
      if(!object(card)){await proof.read();return null}
      card.transcript_status=status;card.transcript_scope='message'
      // Python str.strip包含NEL/文件分隔符，但不把BOM当作空白。
      const text=status==='completed'&&typeof transcript==='string'?strip(transcript):''
      if(text)card.transcript=text;else delete card.transcript
      const serialized=JSON.stringify(files)
      if(Buffer.byteLength(serialized)>16*1048576)throw new ImVoiceTranscriptError()
      const changed=await client.query(`UPDATE conversation_messages SET files=$4::json
        WHERE session_id=$2 AND id=$3 AND run_id=$5 AND role='user'
          AND EXISTS(SELECT 1 FROM conversation_sessions s WHERE s.id=$2 AND s.user_id=$1) RETURNING id`,
        [identity.ownerId,identity.sessionId,messageId,serialized,identity.runId])
      if(changed.rowCount!==1)throw new ImVoiceTranscriptError()
      await proof.read();signal?.throwIfAborted()
      return files
    },()=>new ImVoiceTranscriptError())}catch{throw new ImVoiceTranscriptError()}
  }}
}
