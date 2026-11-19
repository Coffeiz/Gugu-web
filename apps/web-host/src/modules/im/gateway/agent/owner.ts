import { createHmac } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { stableJson } from '@gugu/core/agent'
import type { ImActor } from '@gugu/core/im/access'
import { imActorInputFromPayload } from '@gugu/core/im/access'
import type { ImOwnerSessionBindInput, ImOwnerSessionBindPort } from '@gugu/core/tools'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import { decryptAgentDispatchInput, type AgentDispatchLease } from '../../../agent/run/dispatch.js'
import { createPostgresImAccess } from '../inbound/access.js'
import { createImRunScope } from './scope.js'
import type { NodeImBotBinding } from '../inbound/inbox.js'

type Payload=Readonly<Record<string,unknown>>
const invalid=()=>new Error('IM 私聊会话绑定不可用')
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647
/** Node专属显式路由，12小时有效；不能把入站session_id当作绑定或读取Python路由。 */
export function createImOwnerSessions(options:{pool:Pick<Pool,'connect'|'query'>;secretKey:string;supportedPlatforms():readonly string[]|Promise<readonly string[]>}){
 if(!options.secretKey)throw invalid()
 const hash=(actor:ImActor)=>createHmac('sha256',options.secretKey).update('gugu-im-owner-session-v1\0')
  .update(JSON.stringify([actor.ownerId,actor.platform,actor.botId,actor.platformUserId])).digest('hex')
 const access=(client:Pick<PoolClient,'query'>)=>createPostgresImAccess({query:(sql,args)=>client.query(sql,args),supportedPlatforms:options.supportedPlatforms})
 async function owner(client:Pick<PoolClient,'query'>,binding:NodeImBotBinding,payload:Payload){
  const input=imActorInputFromPayload(binding,payload)
  if(input.chatType!=='c2c')return null
  const actor=await access(client).resolveActor(input)
  return actor.role==='owner'?actor:null
 }
 return {
  async readLocked(client:PoolClient,binding:NodeImBotBinding,payload:Payload):Promise<number|null>{
   const actor=await owner(client,binding,payload)
   if(!actor)return null
   const rows=(await client.query(`SELECT s.id FROM gugu_im_owner_sessions b JOIN conversation_sessions s ON s.id=b.session_id AND s.user_id=b.user_id
    WHERE b.user_id=$1 AND b.scope_hash=$2 AND b.expires_at>clock_timestamp()
     AND (s.source='web' OR s.source IS NULL) AND s.chat_id IS NULL AND (s.chat_type='c2c' OR s.chat_type IS NULL)`,[actor.ownerId,hash(actor)])).rows
   if(rows.length>1)throw invalid()
   return rows.length===1&&positive(rows[0]!.id)?rows[0]!.id:null
  },
  /** 仅成功历史提交续期原绑定；本轮工具新绑到另一会话时不得覆写它。 */
  async touchLocked(client:PoolClient,binding:NodeImBotBinding,payload:Payload,sessionId:string):Promise<void>{
   const actor=await owner(client,binding,payload)
   if(!actor)return
   await client.query(`UPDATE gugu_im_owner_sessions b SET expires_at=clock_timestamp()+interval '12 hours'
    FROM conversation_sessions s WHERE b.user_id=$1 AND b.scope_hash=$2 AND b.session_id=$3 AND s.id=b.session_id AND s.user_id=b.user_id
     AND (s.source='web' OR s.source IS NULL) AND s.chat_id IS NULL AND (s.chat_type='c2c' OR s.chat_type IS NULL)`,[actor.ownerId,hash(actor),sessionId])
  },
  tool(input:{lease:AgentDispatchLease;actor:ImActor;payload:Payload;messageIds:readonly string[];authorize():Promise<boolean>}):ImOwnerSessionBindPort{
   const lease=structuredClone(input.lease),actor=structuredClone(input.actor),identity=lease.identity,payload=structuredClone(input.payload),messageIds=[...input.messageIds]
   if(actor.role!=='owner'||actor.chatType!=='c2c'||actor.ownerId!==identity.ownerId||lease.input.v!==3||lease.input.source!=='im'
    ||actor.botId!==lease.input.im.botId||actor.platform!==lease.input.im.platform||actor.platformUserId!==lease.input.im.platformUserId)throw invalid()
   const binding={ownerId:actor.ownerId,botId:actor.botId,platform:actor.platform},scopeHash=hash(actor)
   function args(value:ImOwnerSessionBindInput){
    if(value.identity.ownerId!==identity.ownerId||value.identity.sessionId!==identity.sessionId||value.identity.runId!==identity.runId||!positive(value.sessionId)
     ||[value.roundId,value.toolCallId].some(v=>typeof v!=='string'||!v||v.length>256||/[\x00-\x1f\x7f]/u.test(v)))throw invalid()
    return [identity.ownerId,Number(identity.sessionId),identity.runId,value.roundId,value.toolCallId]
   }
   async function assert(client:PoolClient,signal?:AbortSignal){
    signal?.throwIfAborted()
    // 相同事务固定当前账户/Bot与执行租约；短事务内不再借另一连接读取Run。
    await client.query(`SELECT b.id FROM user_bots b JOIN users u ON u.id=b.user_id WHERE b.user_id=$1 AND b.id=$2::integer FOR SHARE OF b,u`,[actor.ownerId,actor.botId])
    const current=await owner(client,binding,payload)
    if(!current||hash(current)!==scopeHash)throw invalid()
    const rows=(await client.query(`SELECT d.nonce,d.payload FROM agent_run_dispatch d JOIN conversation_sessions s ON s.user_id=d.user_id AND s.id=d.session_id
     WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3 AND s.active_run_id=$3 AND d.state='selected' AND d.cancel_requested IS FALSE
      AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp() FOR SHARE OF d,s`,[identity.ownerId,identity.sessionId,identity.runId,lease.token,lease.fence])).rows
    if(rows.length!==1||stableJson(decryptAgentDispatchInput(options.secretKey,identity,rows[0]!.nonce,rows[0]!.payload))!==stableJson(lease.input))throw invalid()
    await createImRunScope({pool:client,secretKey:options.secretKey,identity,actor,scope:{...binding,chatType:'c2c',chatId:null,platformUserId:actor.platformUserId},
     payload,messageIds,authorize:async()=>!!await owner(client,binding,payload)}).read()
    signal?.throwIfAborted()
   }
   async function receipt(client:PoolClient,value:ImOwnerSessionBindInput){
    const row=(await client.query(`SELECT scope_hash,target_session_id,status FROM gugu_im_owner_session_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND round_id=$4 AND call_id=$5`,args(value))).rows[0]
    if(row&&(row.scope_hash!==scopeHash||row.target_session_id!==value.sessionId||!['bound','denied'].includes(row.status)))throw invalid()
    return row?.status as 'bound'|'denied'|undefined
   }
   return {
    async bind(value,signal){
     try{
      args(value);signal.throwIfAborted();if(!await input.authorize())return 'denied'
      return await withPostgresTransaction(options.pool,async client=>{
       await assert(client,signal)
       // 同一scope串行写；已完成工具调用重放只读收据，不能覆写后来更新的绑定。
       await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`im-owner-session:${scopeHash}`])
       const old=await receipt(client,value);if(old)return old
       const target=await client.query(`SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 AND (source='web' OR source IS NULL)
        AND chat_id IS NULL AND (chat_type='c2c' OR chat_type IS NULL) FOR KEY SHARE`,[actor.ownerId,value.sessionId])
       const status=target.rows.length===1?'bound':'denied'
       if(status==='bound')await client.query(`INSERT INTO gugu_im_owner_sessions(user_id,scope_hash,session_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '12 hours')
        ON CONFLICT(user_id,scope_hash) DO UPDATE SET session_id=EXCLUDED.session_id,expires_at=EXCLUDED.expires_at`,[actor.ownerId,scopeHash,value.sessionId])
       await client.query(`INSERT INTO gugu_im_owner_session_receipts(user_id,session_id,run_id,round_id,call_id,scope_hash,target_session_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[...args(value),scopeHash,value.sessionId,status])
       await assert(client,signal);return status
      })
     }catch{signal.throwIfAborted();return 'unknown'}
    },
    async recover(value){try{args(value);if(!await input.authorize())return 'unknown';return await withPostgresTransaction(options.pool,async client=>{await assert(client);return await receipt(client,value)??'unknown'})}catch{return 'unknown'}},
   }
  },
 }
}
