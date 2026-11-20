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
interface Parsed { promptId:number;token:string;operator:string;eventId:string;messageId:string|null;chatId:string;chatType?:'c2c'|'group' }
export function parseGatewayInteraction(platform:string,data:Payload):Parsed{
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
    const messageId=data.message_id??nested.message_id??resolved.message_id
    return{...actionData(value),operator,eventId:id(data.id||nested.id,200),messageId:messageId==null?null:id(messageId,256),
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
