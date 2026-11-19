import { createHash, createHmac } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { stableJson, type CanonicalRunContext, type CancellationPort } from '@gugu/core/agent'
import { imCanUseTool, resolveImAccess, type ImActorInput } from '@gugu/core/im/access'
import { createImInboundPreflight, type ImPreflightPorts, type ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import { createAgentInteractionRespondService } from '../../../agent/interactions/respond.js'
import { createPostgresAgentRunStore } from '../../../agent/run/store.js'
import { createPostgresImSecretInput, type ImSecretInputPorts } from '../../../agent/interactions/im-secret.js'
import { agentDispatchSource, decryptAgentDispatchInput, type ImAgentDispatchInput } from '../../../agent/run/dispatch.js'
import { createInteractionResumeEnqueuer } from '../../../agent/interactions/resume.js'
import type { InteractionSideEffects } from '../../../agent/interactions/consume.js'
import { imInteractionScopeSql, imInteractionScopeParameters } from '../../../agent/interactions/replay.js'
import { createPostgresImAccess } from '../inbound/access.js'
import { createPostgresRedisBindingConsumer } from '../inbound/binding.js'
import { imActorInputForDispatch, type ImAgentReconstructorOptions } from '../agent/reconstruct.js'
import { createPostgresImTextChoiceConsumer, type ImInteractionTarget } from '../interactions/lookup.js'
import { createPostgresImShortcut } from './receipts.js'
import { createImShortcutControls } from './shortcuts.js'
import type { RedisCommandClient } from '../../../../workers/redis-stream-queue.js'

export type ImControlDiagnostic = 'binding_post_commit_pending' | 'secret_wake_pending' | 'interaction_wake_pending'
  | 'shortcut_notification_pending' | 'shortcut_read_unavailable' | 'compact_unavailable'
export class ImControlsUnavailable extends Error {
  constructor() { super('IM 控制服务暂不可用'); this.name = 'ImControlsUnavailable' }
}
const fail = () => new ImControlsUnavailable()
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
interface Proof { input: ImActorInput; dispatchHash: string; messagesHash: string }

/** 组合既有真实持久服务；平台发送、业务加密/确认及提交后唤醒均须由Host提供。 */
export function createPostgresImControls(options: {
  pool: Pick<Pool,'connect'|'query'>; redis: RedisCommandClient; secretKey: string
  supportedPlatforms(): readonly string[] | Promise<readonly string[]>
  readRoute: ImAgentReconstructorOptions['readRoute']
  history: Parameters<typeof createPostgresAgentRunStore<CanonicalRunContext>>[2]
  crypto: Pick<ImSecretInputPorts,'encrypt'|'decrypt'>
  invalidateMcpLocked: ImSecretInputPorts['invalidate']
  interactionEffects: Pick<InteractionSideEffects,'applyCommandAction'|'redeemConfirmation'>
  cancellation: Pick<CancellationPort,'request'|'notify'>
  wakeInteractions(): Promise<void>; wakeDispatch(): void | Promise<void>
  invalidateBinding(scope: ImPreflightScope): void; publishBindingChanged(ownerId: string): Promise<void>
  reply: ImPreflightPorts['reply']
  diagnose(code: ImControlDiagnostic): void
  compact?: Parameters<typeof createImShortcutControls>[0]['compact']
}) {
  if(typeof options.secretKey!=='string'||!options.secretKey)throw fail()
  for (const fn of [options.pool?.connect,options.pool?.query,options.redis?.sendCommand,options.readRoute,options.history?.writeHistory,options.crypto?.encrypt,options.crypto?.decrypt,options.invalidateMcpLocked,
    options.interactionEffects?.applyCommandAction,options.interactionEffects?.redeemConfirmation,options.cancellation?.request,options.cancellation?.notify,
    options.wakeInteractions,options.wakeDispatch,options.invalidateBinding,options.publishBindingChanged,options.reply,options.diagnose,options.supportedPlatforms]) {
    if(typeof fn!=='function')throw fail()
  }
  const report=(code:ImControlDiagnostic)=>{try{options.diagnose(code)}catch{/* 固定诊断失败不改变持久消费事实。 */}}
  const access=createPostgresImAccess({query:(q,p)=>options.pool.query(q,p),supportedPlatforms:options.supportedPlatforms})
  const store=createPostgresAgentRunStore<CanonicalRunContext>(options.pool,options.secretKey,options.history)
  const enqueue=createInteractionResumeEnqueuer(store)
  const binding=createPostgresRedisBindingConsumer({pool:options.pool,redis:options.redis,secretKey:options.secretKey,
    invalidate:options.invalidateBinding,publishChanged:options.publishBindingChanged,report(){report('binding_post_commit_pending')}})
  const shortcut=createImShortcutControls({state:createPostgresImShortcut({...options,diagnose:report,wake:options.wakeDispatch}),diagnose:report,compact:options.compact})
  const scopedAccess=(client:PoolClient)=>createPostgresImAccess({query:(q,p)=>client.query(q,p),supportedPlatforms:options.supportedPlatforms})
  async function authorize(scope:ImPreflightScope,signal:AbortSignal) {
    signal.throwIfAborted()
    if(!scope.admissionCutoff)throw fail()
    return await access.readBot(scope)!==null
  }
  async function privateOwner(scope:ImPreflightScope,signal:AbortSignal) {
    signal.throwIfAborted()
    const bot=await access.readBot(scope)
    return scope.chatType==='c2c' && bot!==null && resolveImAccess(scope,bot).role==='owner'
  }
  async function material(client:PoolClient,scope:ImPreflightScope,target:ImInteractionTarget) {
    if(target.identity.ownerId!==scope.ownerId)throw fail()
    const row=(await client.query(`SELECT d.nonce,d.payload,a.created_at<=$4::timestamptz AS admitted
      FROM agent_run_dispatch d JOIN agent_run_startups a ON a.user_id=d.user_id AND a.session_id=d.session_id AND a.run_id=d.run_id
      WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3 AND d.cancel_requested IS FALSE AND a.status<>'failed'`,
    [scope.ownerId,target.identity.sessionId,target.identity.runId,scope.admissionCutoff])).rows[0]
    if(!row||row.admitted!==true)throw fail()
    const input=decryptAgentDispatchInput(options.secretKey,target.identity,row.nonce,row.payload)
    if(agentDispatchSource(input)!=='im'||input.v!==3||input.source!=='im')throw fail()
    const im=input.im
    if(im.platform!==scope.platform||im.botId!==scope.botId||im.chatType!==scope.chatType||im.chatId!==scope.chatId
      ||scope.chatType==='c2c'&&im.platformUserId!==scope.platformUserId)throw fail()
    const ids=im.batch?.messageIds??[input.userMessageId]
    const messages=(await client.query(`SELECT m.id,m.platform_user_id,m.chat_type,m.created_at<=$4::timestamptz AS admitted,
        r.platform,r.bot_id,r.chat_type AS receipt_chat_type,r.state,r.scope_hash,r.event_hash,r.sealed_payload
      FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
      LEFT JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=m.session_id AND r.message_id=m.id AND r.run_id=m.run_id
      WHERE m.session_id=$2 AND m.run_id=$3 AND m.role='user' ORDER BY m.id`,
    [scope.ownerId,target.identity.sessionId,target.identity.runId,scope.admissionCutoff])).rows
    const scopeHash=createHmac('sha256',options.secretKey).update('gugu-im-conversation-v1\0').update(stableJson([scope.ownerId,scope.platform,scope.botId,scope.chatType,scope.chatId??scope.platformUserId])).digest('hex')
    if(messages.length!==ids.length||new Set(messages.map(m=>m.id)).size!==ids.length||!messages.some(m=>m.platform_user_id===scope.platformUserId)
      ||messages.some(m=>!ids.includes(Number(m.id))||m.admitted!==true||m.platform!==scope.platform||m.bot_id!==scope.botId
        ||m.chat_type!==scope.chatType||m.receipt_chat_type!==scope.chatType||m.scope_hash!==scopeHash||m.state!=='dispatched'
        ||scope.chatType==='c2c'&&m.platform_user_id!==scope.platformUserId))throw fail()
    return{input:input as ImAgentDispatchInput,dispatchHash:digest([row.nonce.toString('base64'),row.payload.toString('base64')]),messagesHash:digest(messages)}
  }
  async function prepareProof(scope:ImPreflightScope,target:ImInteractionTarget):Promise<Proof> {
    const route=await options.readRoute(target.identity)
    if(!route)throw fail()
    return withPostgresTransaction(options.pool,async client=>{
      const m=await material(client,scope,target)
      return{input:imActorInputForDispatch({identity:target.identity,input:m.input},route),dispatchHash:m.dispatchHash,messagesHash:m.messagesHash}
    },fail)
  }
  async function verify(client:PoolClient,scope:ImPreflightScope,target:ImInteractionTarget,proof:Proof,signal:AbortSignal) {
    signal.throwIfAborted()
    // 消费事务内复查并锁住当前权限；不把lookup的快照当作执行授权。
    await client.query(`SELECT bot.id FROM user_bots bot JOIN users u ON u.id=bot.user_id WHERE bot.id=$1 AND bot.user_id=$2 AND bot.platform=$3 FOR SHARE OF bot,u`,[scope.botId,scope.ownerId,scope.platform])
    const current=await material(client,scope,target)
    if(current.dispatchHash!==proof.dispatchHash||current.messagesHash!==proof.messagesHash)throw fail()
    const bound=(await client.query(`SELECT b.interaction_id,b.tool_call_id,p.kind,p.schema_json FROM agent_interaction_bindings b
      JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
      WHERE b.user_id=$1 AND b.session_id=$2 AND b.run_id=$3 AND b.prompt_id=$4
        AND p.schema_json::jsonb->>'source'='agent' AND p.schema_json::jsonb->'context'->>'tool_call_id'=b.tool_call_id`,
    [scope.ownerId,target.identity.sessionId,target.identity.runId,target.promptId])).rows[0]
    const checkpoint=await store.readForUpdate(client,target.identity),pending=checkpoint?.pending
    if(!bound||checkpoint?.status!=='waiting'||!pending||pending.id!==bound.interaction_id||pending.toolCall.id!==bound.tool_call_id||bound.tool_call_id!==target.toolCallId)throw fail()
    const schema=bound.schema_json as Record<string,unknown>,context=schema.context as Record<string,unknown>
    if(context.tool_name!==pending.toolCall.name
      ||(pending.kind==='credential')!==(Array.isArray(schema.secret_fields)&&schema.secret_fields.length>0)
      ||(pending.kind==='confirmation')!==(bound.kind==='confirm')
      ||pending.kind==='question'&&!['question','choice'].includes(bound.kind))throw fail()
    const snapshot=await scopedAccess(client).snapshot(proof.input),actor=snapshot.actor(proof.input)
    if(actor.role==='unknown'||scope.chatType==='c2c'&&actor.role!=='owner'||!imCanUseTool(actor,pending.toolCall.name))throw fail()
    signal.throwIfAborted()
  }
  function perScope(scope:ImPreflightScope,signal:AbortSignal) {
    const proofs=new Map<number,{target:ImInteractionTarget;proof:Proof}>()
    const authorizeTarget=async(target?:ImInteractionTarget)=>{
      if(!await authorize(scope,signal))return false
      if(!target)return scope.chatType==='group'||await privateOwner(scope,signal)
      const proof=await prepareProof(scope,target)
      await withPostgresTransaction(options.pool,client=>verify(client,scope,target,proof,signal),fail)
      proofs.set(target.promptId,{target,proof});return true
    }
    const enqueueChecked:ImSecretInputPorts['enqueue']=async(client,prompt,action)=>{
      const found=proofs.get(prompt.id)
      if(!found||prompt.ownerId!==scope.ownerId||String(prompt.sessionId)!==found.target.identity.sessionId)throw fail()
      await verify(client,scope,found.target,found.proof,signal)
      await enqueue(client,prompt,action)
    }
    const secret=createPostgresImSecretInput(options.pool,{...options.crypto,enqueue:enqueueChecked,invalidate:options.invalidateMcpLocked,
      async authorizeLocked(client,current,target){
        const found=proofs.get(target.promptId)
        if(!found||current.ownerId!==scope.ownerId||target.identity.ownerId!==scope.ownerId||target.identity.runId!==found.target.identity.runId
          ||target.identity.sessionId!==found.target.identity.sessionId||target.toolCallId!==found.target.toolCallId)throw fail()
        await verify(client,scope,found.target,found.proof,signal)
      },
      wake:options.wakeInteractions,diagnose(){report('secret_wake_pending')}})
    return{authorizeTarget,secret,enqueueChecked,async prepareSecrets(){
      const rows=await options.pool.query(`SELECT DISTINCT p.id,p.session_id,b.run_id,b.tool_call_id ${imInteractionScopeSql}
        AND EXISTS(SELECT 1 FROM mcp_secret_inputs stage WHERE stage.prompt_id=p.id AND stage.user_id=p.user_id AND stage.status IN ('pending_choice','awaiting_secret'))`,imInteractionScopeParameters(scope))
      if(rows.rows.length>32)throw fail()
      for(const row of rows.rows)await authorizeTarget({identity:{ownerId:scope.ownerId,sessionId:String(row.session_id),runId:row.run_id},promptId:row.id,toolCallId:row.tool_call_id})
    }}
  }
  const ports:ImPreflightPorts={
    authorize,
    async inspectSecret(scope,signal){
      const stage=await perScope(scope,signal).secret.inspectSecret(scope,signal)
      // 解绑不能让仍在等待的秘密字段落入普通历史；旧stage继续消费为失效提示。
      if((stage.status==='pending_choice'||stage.status==='awaiting_secret')&&!await privateOwner(scope,signal))return{status:'ended'}
      return stage
    },
    async applySecret(scope,reference,action,signal){
      if(!await privateOwner(scope,signal))throw fail()
      const bound=perScope(scope,signal);await bound.prepareSecrets()
      return bound.secret.applySecret(scope,reference,action,signal)
    },
    bindQqOwnerIfUnbound:binding.bindQqOwnerIfUnbound,consumeBinding:binding.consumeBinding,
    async consumeTextChoice(scope,text,signal){
      if(scope.chatType==='c2c'&&!await privateOwner(scope,signal))return null
      const bound=perScope(scope,signal)
      const service=createAgentInteractionRespondService({pool:options.pool,effects:options.interactionEffects,enqueue:bound.enqueueChecked,
        wake:options.wakeInteractions,diagnose(){report('interaction_wake_pending')}})
      return createPostgresImTextChoiceConsumer({pool:options.pool,service,secretKey:options.secretKey,authorize:(_scope,_signal,target)=>bound.authorizeTarget(target)})(scope,text,signal)
    },
    ...shortcut,reply:options.reply,
  }
  /** 原生按钮只消费给定token，不轮换token或按label/序号重新选择。 */
  async function consumeNativeAction(scope:ImPreflightScope,promptId:number,token:string,signal:AbortSignal,replayOnly=false):Promise<{accepted:boolean;replayed:boolean}> {
    if(!Number.isSafeInteger(promptId)||promptId<1||typeof token!=='string'||!token||token.length>256||!await authorize(scope,signal))return{accepted:false,replayed:false}
    const bot=await access.readBot(scope)
    if(!bot||scope.platform==='telegram'&&resolveImAccess(scope,bot).role!=='owner'||scope.chatType==='c2c'&&!await privateOwner(scope,signal))return{accepted:false,replayed:false}
    const rows=(await options.pool.query(`SELECT DISTINCT p.id,p.session_id,p.schema_json,b.run_id,b.tool_call_id,
        p.created_at<=$9::timestamptz AS admitted
      ${imInteractionScopeSql} AND p.id=$7
      AND EXISTS(SELECT 1 FROM interaction_actions token_action WHERE token_action.prompt_id=p.id AND token_action.token_hash=$8)`,
    [...imInteractionScopeParameters(scope),promptId,createHash('sha256').update(token).digest('hex'),scope.admissionCutoff]).catch(()=>{throw fail()})).rows
    // action单独查询，不能让其他option的消费事实替代给定token。
    const row=rows[0]
    if(!row||rows.some(r=>r.run_id!==row.run_id||r.session_id!==row.session_id))return{accepted:false,replayed:false}
    const action=(await options.pool.query(`SELECT option_id,status,consumed_event_id,expires_at>clock_timestamp() AS live FROM interaction_actions WHERE prompt_id=$1 AND token_hash=$2`,[promptId,createHash('sha256').update(token).digest('hex')])).rows[0]
    if(!action||row.admitted!==true)return{accepted:false,replayed:false}
    if(action.status==='consumed'&&action.consumed_event_id===scope.eventId){
      const schema=row.schema_json as Record<string,unknown>,result=schema.resolved_result as Record<string,unknown>|undefined
      return{accepted:result?.status!=='error',replayed:true}
    }
    if(replayOnly||action.status!=='pending'||!action.live)return{accepted:false,replayed:false}
    const bound=perScope(scope,signal),target={identity:{ownerId:scope.ownerId,sessionId:String(row.session_id),runId:row.run_id},promptId,toolCallId:row.tool_call_id}
    if(!await bound.authorizeTarget(target))return{accepted:false,replayed:false}
    const schema=row.schema_json as Record<string,unknown>
    if(Array.isArray(schema.secret_fields)&&schema.secret_fields.length){
      if(scope.chatType!=='c2c'||!['input_credentials','cancel'].includes(action.option_id))return{accepted:false,replayed:false}
      const stage=await bound.secret.inspectSecret(scope,signal)
      if(!('reference' in stage))return{accepted:stage.status==='replay',replayed:stage.status==='replay'}
      const result=await bound.secret.applyNativeSecret(scope,stage.reference,{action:action.option_id==='cancel'?'cancel':'start'},{promptId,token},signal)
      if(result.status==='awaiting_secret'||result.status==='cancelled')await options.reply(scope,result.status==='cancelled'?'已取消凭据输入。':`请发送「${result.fieldLabel||'凭据'}」的值。取消输入请发送“取消”。`,{quote:false,signal})
      return{accepted:result.status!=='failed',replayed:result.status==='replay'}
    }
    const service=createAgentInteractionRespondService({pool:options.pool,effects:options.interactionEffects,enqueue:bound.enqueueChecked,wake:options.wakeInteractions,diagnose(){report('interaction_wake_pending')}})
    const result=await service.respond(scope.ownerId,promptId,token,scope.eventId)
    if(result.prompt_id!==promptId||String(result.session_id)!==target.identity.sessionId)throw fail()
    return{accepted:result.result.status!=='error',replayed:false}
  }
  return{ports,preflight:createImInboundPreflight(ports),consumeNativeAction,
    authorizeNativeTarget:(scope:ImPreflightScope,target:ImInteractionTarget,signal:AbortSignal)=>perScope(scope,signal).authorizeTarget(target)}
}
