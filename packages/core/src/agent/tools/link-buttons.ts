import { z } from 'zod'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { dataContext } from '../../contracts/index.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import { strip } from '../../shared/values.js'
import type { ToolDefinition } from './contracts.js'
import type { RunIdentity, ToolResult } from '../models.js'

export interface LinkButton { id:string; label:string; url:string }
/** 可信Host提供实际平台投递和持久恢复；模型不得指定平台或接收者。 */
export interface LinkButtonDeliveryPort {
  deliver(input:{identity:RunIdentity;roundId:string;toolCallId:string;message:string;buttons:LinkButton[];signal:AbortSignal}):Promise<ToolResult>
  reconcile(input:{identity:RunIdentity;roundId:string;toolCallId:string;message:string;buttons:LinkButton[]}):Promise<ToolResult>
}
type DeliveryInput = Parameters<LinkButtonDeliveryPort['reconcile']>[0]
export interface ImLinkButtonChannel {
  platform:'qq'|'feishu'|'wechat'
  /** 由可信 Host 生成的渠道和接收者绑定摘要，不含凭据。 */
  binding:string
}
export interface ImLinkButtonSender {
  resolve(identity:RunIdentity):Promise<ImLinkButtonChannel|null>
  send(input:DeliveryInput & {channel:ImLinkButtonChannel;signal:AbortSignal}):Promise<
    | {status:'sent'|'sent_with_fallback';delivery:'native'|'text';buttonCount:number}
    | {status:'failed'|'unsupported';delivery:'none';buttonCount:number}
    | {status:'unknown'}>
}

/** 外部发送前先持久保留调用坐标；提交状态未知时绝不重发。 */
export function createDurableImLinkButtonDeliveryPort(core:SqlDataRuntime,sender:ImLinkButtonSender):LinkButtonDeliveryPort {
  if(!core.receipts)throw new Error('链接按钮投递需要持久收据')
  const absent=new Error('收据尚不存在')
  const operationId=(input:DeliveryInput,phase:string)=>{
    const parts=['link_buttons',phase,input.identity.ownerId,input.identity.sessionId,input.identity.runId,input.roundId,input.toolCallId]
    if(parts.some(value=>typeof value!=='string'||!value.trim()))throw new Error('工具运行身份无效')
    const h=createHash('sha256').update(JSON.stringify(parts)).digest('hex'),id=h.slice(0,12)+'5'+h.slice(13,16)+'8'+h.slice(17,32)
    return [id.slice(0,8),id.slice(8,12),id.slice(12,16),id.slice(16,20),id.slice(20)].join('-')
  }
  const params=(input:DeliveryInput,channel:ImLinkButtonChannel)=>({digest:createHash('sha256').update(JSON.stringify([channel.platform,channel.binding,input.message,input.buttons])).digest('hex')})
  async function recover(input:DeliveryInput,channel:ImLinkButtonChannel):Promise<ToolResult>{
    const context=dataContext(input.identity.ownerId),fields=params(input,channel)
    try{
      await core.operationWithTransaction(context,operationId(input,'reserve'),'agent.link_buttons.reserve',fields,async()=>{throw absent})
      const outcome=await core.operationWithTransaction(context,operationId(input,'result'),'agent.link_buttons.result',fields,async()=>{throw absent})
      return {kind:'completed',successful:(outcome.result as {status:string}).status.startsWith('sent'),mutated:false,value:outcome.result}
    }catch{return {kind:'unknown'}}
  }
  return {
    async reconcile(input){const channel=await sender.resolve(input.identity);return channel?recover(input,channel):{kind:'unknown'}},
    async deliver(input){
      input.signal.throwIfAborted()
      const channel=await sender.resolve(input.identity)
      if(!channel || !channel.binding)return {kind:'unknown'}
      input.signal.throwIfAborted()
      const context=dataContext(input.identity.ownerId),fields=params(input,channel)
      let reserved
      try{reserved=await core.operationWithTransaction(context,operationId(input,'reserve'),'agent.link_buttons.reserve',fields,async()=>({reserved:true}),{signal:input.signal})}
      catch{return recover(input,channel)}
      if(reserved.replayed)return recover(input,channel)
      if(input.signal.aborted)return {kind:'unknown'}
      let outcome:Awaited<ReturnType<ImLinkButtonSender['send']>>
      try{outcome=await sender.send({...input,channel})}catch{return {kind:'unknown'}}
      if(outcome.status==='unknown')return {kind:'unknown'}
      if(!Number.isSafeInteger(outcome.buttonCount)||outcome.buttonCount<0||outcome.buttonCount>input.buttons.length)return {kind:'unknown'}
      const value={status:outcome.status,platform:channel.platform,delivery:outcome.delivery,button_count:outcome.buttonCount}
      try{
        const receipt=await core.operationWithTransaction(context,operationId(input,'result'),'agent.link_buttons.result',fields,async()=>value)
        return {kind:'completed',successful:receipt.result.status.startsWith('sent'),mutated:true,value:receipt.result}
      }catch{return recover(input,channel)}
    },
  }
}
const control=/[\x00-\x1f\x7f]/u
const blocked=new Set(['javascript','data','vbscript','file','blob','filesystem','about','chrome','chrome-extension','resource','view-source'])
function urlError(raw:string):string|null {
  if(!raw)return 'URL 不能为空'
  if([...raw].length>2048)return 'URL 超过 2048 字符上限'
  if(control.test(raw))return 'URL 含有非法控制字符'
  const match=/^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(raw)
  if(!match)return 'URL 必须包含协议 Scheme'
  if(blocked.has(match[1]!.toLowerCase()))return '该 URL 使用了禁止的危险 Scheme'
  const authority=/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u.exec(raw)?.[1]
  if(authority !== undefined){
    // 与 Python urlparse 一样拒绝 NFKC 归一化后变为分隔符的字符，
    // 防止渲染端与服务端对主机或凭据边界产生不同解释。
    const normalized=authority.replace(/[@:#?]/gu,'').normalize('NFKC')
    if(/[/?#@:]/u.test(normalized))return 'URL 主机格式无效'
    const at=authority.lastIndexOf('@')
    if(at>=0){
      const userinfo=authority.slice(0,at), colon=userinfo.indexOf(':')
      const username=colon<0?userinfo:userinfo.slice(0,colon), password=colon<0?'':userinfo.slice(colon+1)
      if(username || password)return 'URL 不能包含用户名或密码'
    }
    const host=authority.slice(at+1)
    if(host.includes('[')||host.includes(']')){
      const match=/^\[([^\]]+)\](?::[^\[\]]*)?$/u.exec(host)
      if(!match || (isIP(match[1]!)!==6 && !/^v[\da-f]+\..+$/iu.test(match[1]!)))return 'URL 主机格式无效'
    }
  }
  return null
}

/** Web 按钮通过运行检查点中的 artifact 投递；恢复时可安全重建同一结果。 */
export function createWebLinkButtonDeliveryPort(isWebSession:(identity:RunIdentity)=>Promise<boolean>):LinkButtonDeliveryPort {
  async function result(input:{identity:RunIdentity;message:string;buttons:LinkButton[]}):Promise<ToolResult>{
    if(!await isWebSession(input.identity))return {kind:'unknown'}
    return {kind:'completed',successful:true,mutated:false,
      value:{status:'sent',platform:'web',delivery:'native',button_count:input.buttons.length,message:'入口已在对话窗口以按钮展示。'},
      artifact:{kind:'link_buttons',message:input.message,buttons:input.buttons}}
  }
  return {async deliver(input){input.signal.throwIfAborted();const value=await result(input);input.signal.throwIfAborted();return value},reconcile:result}
}
export function validateLinkButtons(message:string,buttons:LinkButton[]):{message:string;buttons:LinkButton[]}|{error:string} {
  const text=strip(message)
  if(!text)return {error:'message 不能为空'}
  if([...text].length>2000)return {error:'message 超过 2000 字符上限'}
  if(control.test(text))return {error:'message 含有非法控制字符'}
  if(!buttons.length||buttons.length>5)return {error:'buttons 必须是 1 到 5 个按钮的数组'}
  const seen=new Set<string>(),normalized:LinkButton[]=[]
  for(const [index,item] of buttons.entries()){
    const id=strip(item.id),label=strip(item.label),url=strip(item.url)
    if(!id||[...id].length>64)return {error:`第 ${index+1} 个按钮的 id 长度须为 1~64`}
    if(seen.has(id))return {error:`按钮 id「${id}」重复，同一调用内必须唯一`}
    seen.add(id)
    if(!label)return {error:`第 ${index+1} 个按钮缺少 label`}
    if([...label].length>40)return {error:`按钮「${label}」的 label 超过 40 字符上限`}
    if(control.test(label))return {error:`按钮「${label}」的 label 含有非法控制字符`}
    const error=urlError(url);if(error)return {error:`按钮「${label}」的 URL 未通过安全校验：${error}`}
    normalized.push({id,label,url})
  }
  return {message:text,buttons:normalized}
}
export function createLinkButtonsTools(port:LinkButtonDeliveryPort):ToolDefinition[]{
  const limited=(max:number)=>z.string().min(1).refine(value=>[...value].length<=max).meta({maxLength:max})
  const schema=z.object({message:limited(2000),buttons:z.array(z.object({id:limited(64),label:limited(40),url:limited(2048)}).strict()).min(1).max(5)}).strict()
  return [{definition:{name:'send_link_buttons',schema:{type:'function',function:{name:'send_link_buttons',description:'向当前会话发送导航链接，不等待点击。buttons 直接传含 1–5 个按钮对象的数组。',parameters:z.toJSONSchema(schema) as Record<string,import('../models.js').Json>}}},effect:'write',validate:input=>schema.safeParse(input),
    async execute(input,scope,call){
      const value=input as z.infer<typeof schema>,result=validateLinkButtons(value.message,value.buttons)
      if('error' in result)return {kind:'completed',successful:false,mutated:false,value:{status:'rejected',delivery:'none',button_count:0,error:result.error}}
      scope.signal.throwIfAborted()
      return port.deliver({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,...result,signal:scope.signal})
    },
    async reconcile(input,identity,call){
      const value=input as z.infer<typeof schema>,result=validateLinkButtons(value.message,value.buttons)
      if('error' in result)return {kind:'unknown'}
      return port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,...result})
    }}]
}
