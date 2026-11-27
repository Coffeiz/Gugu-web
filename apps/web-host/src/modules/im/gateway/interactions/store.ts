import { sendAuthorizedImPrompt, projectImChoiceButtons, matchesImInteractionScope, readImReceivedInteraction } from '@gugu/gateway'
import { createHmac,randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { questionBatchText, questionStepOptionId, readQuestionBatch, stableJson,type RunEvent,type RunIdentity } from '@gugu/core/agent'
import type { ImPreflightScope } from '@gugu/gateway'
import type { ImDeliveryAcknowledgement } from '@gugu/core/im/run-delivery'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import { createPostgresInteractionProjection } from '../../../agent/interactions/projection.js'
import { decryptAgentDispatchInput } from '../../../agent/run/dispatch.js'
import { createPostgresImAccess } from '../inbound/access.js'
import { createPostgresImGatewayAdmission } from '../inbound/admission.js'
import { imActorInputForDispatch,type ImAgentReconstructorOptions } from '../agent/reconstruct.js'
import type { createPostgresImControls } from '../attention/controls.js'
import type { GatewayConnectionServices,GatewayPlatformSender } from '../connections.js'
import type { NodeImBotBinding } from '../inbound/inbox.js'
import { projectPrivateImSecretPromptLocked } from './secrets.js'
import { createImRunScope } from '../agent/scope.js'
import { imAcceptedEvidence } from '../agent/evidence.js'

const id=(v:unknown,max=8192):string=>{
  if((typeof v!=='string'&&typeof v!=='number')||typeof v==='number'&&!Number.isSafeInteger(v))throw fail()
  const value=String(v)
  if(!value||value.length>max||/[\x00-\x1f\x7f]/u.test(value))throw fail()
  return value
}
const fail=()=>new Error('IM 原生交互暂不可用')
/** 同时提供实际原生发送与消费，消息证明只由发送成功的合法message ID登记。 */
export function createPostgresImNativeInteractions(options:{
  pool:Pick<Pool,'query'|'connect'>;secretKey:string;supportedPlatforms():readonly string[]|Promise<readonly string[]>
  readRoute:ImAgentReconstructorOptions['readRoute']
  diagnose?(code: 'interaction_callback_failed' | 'qq_interaction_message_unmatched' | 'qq_interaction_action_rejected', error?: unknown): void
  controls:Pick<ReturnType<typeof createPostgresImControls>,'consumeNativeAction'|'authorizeNativeTarget'> & Partial<Pick<ReturnType<typeof createPostgresImControls>, 'replyQuestion'>>
  /** 由connections.sender按可信owner/Bot取当前实例，不自行获取平台凭据。 */
  sender(binding:NodeImBotBinding):GatewayPlatformSender|null
}){
  if(!options.secretKey||typeof options.sender!=='function'||typeof options.controls?.consumeNativeAction!=='function'||typeof options.controls.authorizeNativeTarget!=='function'||typeof options.readRoute!=='function')throw fail()
  const hmac=(purpose:string,value:unknown)=>createHmac('sha256',options.secretKey).update(`gugu-im-native-${purpose}-v1\0`).update(stableJson(value)).digest('hex')
  const projection=createPostgresInteractionProjection(options.pool, options.secretKey)
  const access=createPostgresImAccess({query:(q,p)=>options.pool.query(q,p),supportedPlatforms:options.supportedPlatforms})
  const admission=createPostgresImGatewayAdmission(options)
  async function source(identity:RunIdentity){
    const row=(await options.pool.query('SELECT nonce,payload FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND run_id=$3',[identity.ownerId,identity.sessionId,identity.runId])).rows[0]
    if(!row)throw fail()
    const input=decryptAgentDispatchInput(options.secretKey,identity,row.nonce,row.payload)
    if(input.v!==3||input.source!=='im'||input.im.platform==='wechat')throw fail()
    return input
  }
  async function deliverInteraction(input: { identity: RunIdentity; deliveryId: string; event: RunEvent; questionIndex?: number }): Promise<ImDeliveryAcknowledgement> {
      let intent=false,attempt='',deliveryHash=''
      try{
        const {identity,event}=input
        if(event.type!=='interaction_required'||event.identity.ownerId!==identity.ownerId||event.identity.sessionId!==identity.sessionId||event.identity.runId!==identity.runId)throw fail()
        const dispatched=await source(identity),route=await options.readRoute(identity)
        if(!route)throw fail()
        const actorInput=imActorInputForDispatch({identity,input:dispatched},route),snapshot=await access.snapshot(actorInput),actor=snapshot.actor(actorInput)
        if(!await access.authorizeDelivery(actor,snapshot.bot))return'rejected'
        const prompt=(await options.pool.query(`SELECT prompt_id FROM agent_interaction_bindings WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND interaction_id=$4 AND tool_call_id=$5`,
        [identity.ownerId,identity.sessionId,identity.runId,event.payload.interactionId,event.payload.toolCallId])).rows[0]
        if(!prompt)throw fail()
        deliveryHash=hmac('delivery',[identity,id(input.deliveryId,256)])
        attempt=randomUUID()
        const inserted=await options.pool.query(`INSERT INTO gugu_im_native_deliveries(user_id,delivery_hash,session_id,run_id,prompt_id,state,attempt_id)
          VALUES($1,$2,$3,$4,$5,'pending',$6) ON CONFLICT(user_id,delivery_hash) DO UPDATE SET state='pending',attempt_id=EXCLUDED.attempt_id
          WHERE gugu_im_native_deliveries.state='rejected' AND gugu_im_native_deliveries.session_id=EXCLUDED.session_id
            AND gugu_im_native_deliveries.run_id=EXCLUDED.run_id AND gugu_im_native_deliveries.prompt_id=EXCLUDED.prompt_id`,[identity.ownerId,deliveryHash,identity.sessionId,identity.runId,prompt.prompt_id,attempt])
        if(inserted.rowCount!==1){
          const old=(await options.pool.query('SELECT state,session_id,run_id,prompt_id FROM gugu_im_native_deliveries WHERE user_id=$1 AND delivery_hash=$2',[identity.ownerId,deliveryHash])).rows[0]
          if(!old||String(old.session_id)!==identity.sessionId||old.run_id!==identity.runId||old.prompt_id!==prompt.prompt_id)throw fail()
          return old.state==='accepted'?'accepted':old.state==='rejected'?'rejected':'unknown'
        }
        intent=true
        const cutoff=(await options.pool.query('SELECT clock_timestamp()::text AS cutoff')).rows[0].cutoff as string
        const scope:ImPreflightScope={ownerId:identity.ownerId,botId:dispatched.im.botId,platform:dispatched.im.platform,chatType:dispatched.im.chatType,chatId:dispatched.im.chatId,
          platformUserId:dispatched.im.platformUserId,eventId:`native-send:${deliveryHash}`,admissionCutoff:cutoff}
        const signal=new AbortController().signal
        const authorize=async()=>await access.authorizeDelivery(actor,snapshot.bot)&&await options.controls.authorizeNativeTarget(scope,{identity,promptId:prompt.prompt_id,toolCallId:String(event.payload.toolCallId)},signal)
        if(!await authorize())throw fail()
        const evidenceScope={ownerId:identity.ownerId,botId:dispatched.im.botId,platform:dispatched.im.platform,chatType:dispatched.im.chatType,
          chatId:dispatched.im.chatId,platformUserId:dispatched.im.platformUserId}
        const proof=createImRunScope({pool:options.pool,secretKey:options.secretKey,identity,actor,scope:evidenceScope,
          messageIds:(dispatched.im.batch?.messageIds??[dispatched.userMessageId]).map(String),payload:route.payload,authorize})
        const evidenceSource=await proof.read()
        const projected=event.payload.kind==='credential'&&actor.chatType==='c2c'&&actor.role==='owner'
          ?await withPostgresTransaction(options.pool,client=>projectPrivateImSecretPromptLocked(client,identity,String(event.payload.interactionId),scope,options.secretKey),fail)
          :await projection.interaction(event)
        const questions = readQuestionBatch({ questions: projected.questions })
        const questionIndex = input.questionIndex ?? 0
        const question = questions?.[questionIndex]
        if (questions && (!question || projected.question_index !== questionIndex)) throw fail()
        const stepOptions = question?.options?.map((_option, index) => questionStepOptionId(questionIndex, index)) ?? []
        const presentation = questions ? { ...projected, title: question!.title,
          body: questionBatchText(questions, questionIndex),
          options: projected.options.filter(option => stepOptions.includes(option.id) || option.id === '__cancel_questions__') } : projectImChoiceButtons(projected) ?? projected
        const sender=options.sender(route.binding)
        if(presentation.resolved||!sender||sender.platform!==dispatched.im.platform||!await access.authorizeDelivery(actor,snapshot.bot))throw fail()
        const rawChat=dispatched.im.chatType==='group'?dispatched.im.chatId:dispatched.im.platformUserId
        const chatId=id(rawChat,256)
        const sent = await sendAuthorizedImPrompt(authorize, async () =>
          sender.platform === 'telegram' ? sender.sender.interaction({ chatId, chatType: dispatched.im.chatType }, presentation, undefined, authorize)
            : sender.platform === 'qq' ? sender.sender.interaction({ id: chatId, chatType: dispatched.im.chatType }, presentation, undefined, authorize)
            : sender.platform === 'feishu' ? sender.sender.interaction(chatId, presentation, undefined, authorize) : null,
          { outcome: 'rejected' as const, platformMessageIds: [] })
        if(!sent)throw fail()
        let outcome=sent.outcome
        if(outcome==='accepted'&&(!sent.platformMessageIds.length||sender.platform==='qq'&&'delivery'in sent&&sent.delivery!=='native')){
          // 文本降级没有按钮可签；QQ没有message ID也不能制造可回调证明。
          outcome=sent.platformMessageIds.length?'accepted':'unknown'
        }
        await withPostgresTransaction(options.pool,async client=>{
          if(outcome==='accepted'&&presentation.options.length&&!(sender.platform==='qq'&&'delivery'in sent&&sent.delivery!=='native')){
            for(const messageId of sent.platformMessageIds){
              const indexed=await client.query(`INSERT INTO gugu_im_native_prompt_messages(user_id,platform,bot_id,chat_hash,message_hash,session_id,run_id,prompt_id)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,platform,bot_id,message_hash) DO UPDATE SET prompt_id=EXCLUDED.prompt_id
                  WHERE gugu_im_native_prompt_messages.session_id=EXCLUDED.session_id AND gugu_im_native_prompt_messages.run_id=EXCLUDED.run_id
                    AND gugu_im_native_prompt_messages.prompt_id=EXCLUDED.prompt_id AND gugu_im_native_prompt_messages.chat_hash=EXCLUDED.chat_hash`,
              [identity.ownerId,sender.platform,route.binding.botId,hmac('chat',[route.binding,chatId]),hmac('message',[route.binding,chatId,id(messageId,256)]),identity.sessionId,identity.runId,prompt.prompt_id])
              if(indexed.rowCount!==1)throw fail()
            }
          }
          const settled=await client.query('UPDATE gugu_im_native_deliveries SET state=$4 WHERE user_id=$1 AND delivery_hash=$2 AND attempt_id=$3 AND state=\'pending\'',[identity.ownerId,deliveryHash,attempt,outcome])
          if(settled.rowCount!==1)throw fail()
        },fail)
        return imAcceptedEvidence({scope:evidenceScope,recipient:chatId,kind:'interaction',source:evidenceSource,
          receipt:{outcome,platformMessageIds:sent.platformMessageIds}})
      }catch{
        if(intent)try{await options.pool.query("UPDATE gugu_im_native_deliveries SET state='unknown' WHERE user_id=$1 AND delivery_hash=$2 AND attempt_id=$3 AND state='pending'",[input.identity.ownerId,deliveryHash,attempt])}catch{/* pending同样禁止重发。 */}
        return'unknown'
      }
    }
  return { interaction: deliverInteraction,
    callback: (async(event,signal)=>{
      let token:string|undefined,scope:ImPreflightScope|undefined
      try{
        signal.throwIfAborted()
        const {binding,platform,data}=event
        if(platform==='wechat')throw fail()
        const interaction=readImReceivedInteraction(binding,platform,data),parsed=interaction.action
        // 飞书私聊以用户 open_id 投递；回调同时携带平台会话 ID 与操作者。
        const recipients = platform === 'feishu' ? [parsed.operator, parsed.chatId] : [parsed.chatId]
        // QQ 回调可能不带原消息 ID。仍要求同 Bot、会话和 Prompt 的原生发送证明，
        // 并在下方核对发起人及一次性动作令牌。
        const matches = (await options.pool.query(`SELECT DISTINCT session_id,run_id FROM gugu_im_native_prompt_messages
          WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND ($4::text[] IS NULL OR message_hash=ANY($4::text[]))
          AND chat_hash=ANY($5::text[]) AND prompt_id=$6`,
        [binding.ownerId,platform,binding.botId,parsed.messageId===null?null:recipients.map(recipient=>hmac('message',[binding,recipient,parsed.messageId])),
          recipients.map(recipient=>hmac('chat',[binding,recipient])),parsed.promptId])).rows
        if(matches.length!==1){
          if(platform==='qq')options.diagnose?.('qq_interaction_message_unmatched')
          return{consumed:true,accepted:false}
        }
        const row=matches[0]!
        const identity={ownerId:binding.ownerId,sessionId:String(row.session_id),runId:row.run_id},input=await source(identity),im=input.im
        if(!matchesImInteractionScope(interaction,{ownerId:identity.ownerId,platform:im.platform,botId:im.botId,
          chatType:im.chatType,chatId:im.chatId,platformUserId:im.platformUserId}))throw fail()
        scope={ownerId:binding.ownerId,botId:binding.botId,platform,chatType:im.chatType,chatId:im.chatId,platformUserId:parsed.operator,eventId:`native-callback:${parsed.eventId}`}
        const admitted=await admission.begin({scope,text:hmac('action',[parsed.promptId,parsed.token,parsed.messageId]),hasPendingMedia:false})
        const trusted={...scope,eventId:admitted.controlEventId,admissionCutoff:admitted.receivedAt}
        if(admitted.status==='first')token=admitted.token
        const result=await options.controls.consumeNativeAction(trusted,parsed.promptId,parsed.token,signal,admitted.status!=='first')
        if(token)await admission.finish(scope,token,'consumed')
        if (result.nextQuestion) {
          const { index, text } = result.nextQuestion
          const { rows: [current] } = await options.pool.query<{ interaction_id: string; tool_call_id: string }>(
            'SELECT interaction_id,tool_call_id FROM agent_interaction_bindings WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND prompt_id=$4',
            [identity.ownerId, identity.sessionId, identity.runId, parsed.promptId])
          if (current) {
            const deliveryId = `question:${parsed.promptId}:${index}`
            const next = await deliverInteraction({ identity, deliveryId, questionIndex: index, event: {
              id: deliveryId, identity, sequence: 0, round: 0, type: 'interaction_required',
              payload: { kind: 'question', interactionId: current.interaction_id, toolCallId: current.tool_call_id },
            } })
            if (next === 'rejected' || typeof next === 'object' && next.outcome === 'rejected')
              await options.controls.replyQuestion?.(trusted, text, signal)
          }
        }
        if(platform==='qq'&&!result.accepted)options.diagnose?.('qq_interaction_action_rejected')
        const feedback = result.nextQuestion ? '已保存本题答案，请回答下一题。' : result.awaitingText ? '请直接发送你的回复，咕咕会继续处理。' : '已确认收到选择；咕咕将继续处理。'
        return{consumed:true,accepted:result.accepted,...(platform==='feishu'&&result.accepted?{response:{
          toast:{type:'info',content:result.awaitingText?feedback:'已收到选择。'},card:{type:'raw',data:{config:{wide_screen_mode:true},elements:[{tag:'div',text:{tag:'plain_text',content:feedback}}]}}
        }}:{})}
      }catch(error){
        try { options.diagnose?.('interaction_callback_failed', error) } catch { /* 诊断不得影响回调结算。 */ }
        if(token&&scope)try{await admission.markUnknown(scope,token)}catch{/* pending不重做。 */}
        signal.throwIfAborted()
        return{consumed:!token,accepted:false}
      }
    }) satisfies NonNullable<GatewayConnectionServices['callback']>,
  }
}
