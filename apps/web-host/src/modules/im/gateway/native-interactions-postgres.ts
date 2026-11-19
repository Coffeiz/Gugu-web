import { createHmac,randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { stableJson,type RunEvent,type RunIdentity } from '@gugu/core/agent'
import type { ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import type { ImDeliveryAcknowledgement } from '@gugu/core/im/run-delivery'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import { createPostgresInteractionProjection } from '../../agent-sessions/persistence/agent-interaction-projection-postgres.js'
import { decryptAgentDispatchInput } from '../../agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createPostgresImAccess } from './access-postgres.js'
import { createPostgresImGatewayAdmission } from './admission-postgres.js'
import { imActorInputForDispatch,type ImAgentReconstructorOptions } from './agent-reconstructor.js'
import type { createPostgresImControls } from './controls-postgres.js'
import type { GatewayConnectionServices,GatewayPlatformSender } from './platform-connections.js'
import type { NodeImBotBinding } from './inbox.js'
import { projectPrivateImSecretPromptLocked } from './native-secret-projection.js'
import { createImRunScope } from './run-scope.js'
import { imAcceptedEvidence } from './run-evidence.js'

type Payload=Record<string,unknown>
const object=(v:unknown):v is Payload=>!!v&&typeof v==='object'&&!Array.isArray(v)
const record=(v:unknown):Payload=>object(v)?v:{}
const id=(v:unknown,max=8192):string=>{
  if((typeof v!=='string'&&typeof v!=='number')||typeof v==='number'&&!Number.isSafeInteger(v))throw fail()
  const value=String(v)
  if(!value||value.length>max||/[\x00-\x1f\x7f]/u.test(value))throw fail()
  return value
}
const fail=()=>new Error('IM 原生交互暂不可用')
function actionData(value:unknown,limit=1024){
  if(typeof value!=='string'||Buffer.byteLength(value)>limit)throw fail()
  const match=/^([1-9]\d{0,9}):([^:\s]{1,256})$/u.exec(value)
  if(!match||Number(match[1])>2147483647)throw fail()
  return{promptId:Number(match[1]),token:match[2]!}
}
interface Parsed { promptId:number;token:string;operator:string;eventId:string;messageId:string;chatId:string;chatType?:'c2c'|'group' }
function parse(platform:string,data:Payload):Parsed{
  if(platform==='telegram'){
    const actor=record(data.from),message=record(data.message),chat=record(message.chat)
    const kind=chat.type
    if(!['private','group','supergroup'].includes(String(kind)))throw fail()
    const operator=id(actor.id),chatId=id(chat.id)
    if(!/^[1-9]\d*$/u.test(operator)||kind==='private'&&chatId!==operator)throw fail()
    return{...actionData(data.data,64),operator,eventId:id(data.id,200),messageId:id(message.message_id,128),chatId,chatType:kind==='private'?'c2c':'group'}
  }
  if(platform==='qq'){
    const nested=object(data.data)?data.data:data,action=object(nested.action)?nested.action:nested,resolved=record(nested.resolved),actor=record(nested.user??nested.author)
    let value=resolved.button_data||action.action_data||action.data||action.custom_data
    if(object(value))value=value.action_data||value.data
    const operator=id(data.user_openid||data.group_member_openid||nested.user_openid||nested.group_member_openid||actor.user_openid||actor.openid||actor.id||resolved.user_id,256)
    const group=data.group_openid||nested.group_openid||data.group_id||nested.group_id
    const chatType=group||data.chat_type===1?'group':'c2c'
    if(chatType==='group'&&!group)throw fail()
    return{...actionData(value),operator,eventId:id(data.id||nested.id,200),messageId:id(data.message_id||nested.message_id||resolved.message_id,256),
      chatId:chatType==='group'?id(group,256):operator,chatType}
  }
  if(platform==='feishu'){
    if(data.kind!=='card_action')throw fail()
    const raw=record(data.raw),event=object(raw.event)?raw.event:raw,context=record(event.context)
    const action=record(record(event.action).value),operator=record(event.operator),header=record(raw.header)
    if(operator.open_id!==data.operatorId||action.token!==data.actionToken||Number(action.prompt_id)!==Number(data.promptId)
      ||header.event_id!==undefined&&header.event_id!==data.eventId)throw fail()
    const promptId=Number(data.promptId)
    if(!Number.isSafeInteger(promptId)||promptId<1||promptId>2147483647)throw fail()
    // raw context只作为待核验定位事实，必须命中实际发送后的message/prompt索引。
    return{promptId,token:id(data.actionToken,256),operator:id(data.operatorId,256),eventId:id(data.eventId,200),messageId:id(context.open_message_id,256),chatId:id(context.open_chat_id,256)}
  }
  throw fail()
}

/** 同时提供实际原生发送与消费，消息证明只由发送成功的合法message ID登记。 */
export function createPostgresImNativeInteractions(options:{
  pool:Pick<Pool,'query'|'connect'>;secretKey:string;supportedPlatforms():readonly string[]|Promise<readonly string[]>
  readRoute:ImAgentReconstructorOptions['readRoute']
  controls:Pick<ReturnType<typeof createPostgresImControls>,'consumeNativeAction'|'authorizeNativeTarget'>
  /** 由platform-connections.sender按可信owner/Bot取当前实例，不自行获取平台凭据。 */
  sender(binding:NodeImBotBinding):GatewayPlatformSender|null
}){
  if(!options.secretKey||typeof options.sender!=='function'||typeof options.controls?.consumeNativeAction!=='function'||typeof options.controls.authorizeNativeTarget!=='function'||typeof options.readRoute!=='function')throw fail()
  const hmac=(purpose:string,value:unknown)=>createHmac('sha256',options.secretKey).update(`gugu-im-native-${purpose}-v1\0`).update(stableJson(value)).digest('hex')
  const projection=createPostgresInteractionProjection(options.pool)
  const access=createPostgresImAccess({query:(q,p)=>options.pool.query(q,p),supportedPlatforms:options.supportedPlatforms})
  const admission=createPostgresImGatewayAdmission(options)
  async function source(identity:RunIdentity){
    const row=(await options.pool.query('SELECT nonce,payload FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND run_id=$3',[identity.ownerId,identity.sessionId,identity.runId])).rows[0]
    if(!row)throw fail()
    const input=decryptAgentDispatchInput(options.secretKey,identity,row.nonce,row.payload)
    if(input.v!==3||input.source!=='im'||input.im.platform==='wechat')throw fail()
    return input
  }
  return{
    async interaction(input:{identity:RunIdentity;deliveryId:string;event:RunEvent}):Promise<ImDeliveryAcknowledgement>{
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
        const presentation=event.payload.kind==='credential'&&actor.chatType==='c2c'&&actor.role==='owner'
          ?await withPostgresTransaction(options.pool,client=>projectPrivateImSecretPromptLocked(client,identity,String(event.payload.interactionId),scope),fail)
          :await projection.interaction(event)
        const sender=options.sender(route.binding)
        if(presentation.resolved||!sender||sender.platform!==dispatched.im.platform||!await access.authorizeDelivery(actor,snapshot.bot))throw fail()
        const rawChat=dispatched.im.chatType==='group'?dispatched.im.chatId:sender.platform==='feishu'?route.payload.chat_id:dispatched.im.platformUserId
        const chatId=id(rawChat,256)
        const sent=sender.platform==='telegram'?await sender.sender.interaction({chatId,chatType:dispatched.im.chatType},presentation,undefined,authorize)
          :sender.platform==='qq'?await sender.sender.interaction({id:chatId,chatType:dispatched.im.chatType},presentation,undefined,authorize)
          :sender.platform==='feishu'?await sender.sender.interaction(chatId,presentation,undefined,authorize):null
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
    },
    callback: (async(event,signal)=>{
      let token:string|undefined,scope:ImPreflightScope|undefined
      try{
        signal.throwIfAborted()
        const {binding,platform,data}=event
        if(binding.platform!==platform||platform==='wechat')throw fail()
        if(platform==='feishu'&&(data.ownerId!==binding.ownerId||data.botId!==binding.botId))throw fail()
        const parsed=parse(platform,data)
        const row=(await options.pool.query(`SELECT session_id,run_id FROM gugu_im_native_prompt_messages WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND message_hash=$4 AND chat_hash=$5 AND prompt_id=$6`,
        [binding.ownerId,platform,binding.botId,hmac('message',[binding,parsed.chatId,parsed.messageId]),hmac('chat',[binding,parsed.chatId]),parsed.promptId])).rows[0]
        if(!row)return{consumed:true,accepted:false}
        const identity={ownerId:binding.ownerId,sessionId:String(row.session_id),runId:row.run_id},input=await source(identity),im=input.im
        if(im.platform!==platform||im.botId!==binding.botId||parsed.chatType&&parsed.chatType!==im.chatType||im.chatType==='group'&&parsed.chatId!==im.chatId||im.chatType==='c2c'&&parsed.operator!==im.platformUserId)throw fail()
        scope={ownerId:binding.ownerId,botId:binding.botId,platform,chatType:im.chatType,chatId:im.chatId,platformUserId:parsed.operator,eventId:`native-callback:${parsed.eventId}`}
        const admitted=await admission.begin({scope,text:hmac('action',[parsed.promptId,parsed.token,parsed.messageId]),hasPendingMedia:false})
        const trusted={...scope,eventId:admitted.controlEventId,admissionCutoff:admitted.receivedAt}
        if(admitted.status==='first')token=admitted.token
        const result=await options.controls.consumeNativeAction(trusted,parsed.promptId,parsed.token,signal,admitted.status!=='first')
        if(token)await admission.finish(scope,token,'consumed')
        return{consumed:true,accepted:result.accepted,...(platform==='feishu'&&result.accepted?{response:{
          toast:{type:'info',content:'已收到选择。'},card:{type:'raw',data:{config:{wide_screen_mode:true},elements:[{tag:'div',text:{tag:'plain_text',content:'已确认收到选择；咕咕将继续处理。'}}]}}
        }}:{})}
      }catch{
        if(token&&scope)try{await admission.markUnknown(scope,token)}catch{/* pending不重做。 */}
        signal.throwIfAborted()
        return{consumed:!token,accepted:false}
      }
    }) satisfies NonNullable<GatewayConnectionServices['callback']>,
  }
}
