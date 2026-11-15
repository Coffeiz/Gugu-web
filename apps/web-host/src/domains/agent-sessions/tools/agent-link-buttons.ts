import { createHash } from 'node:crypto'
import type { ImLinkButtonSender } from '@gugu/core/tools'
import { validateLinkButtons } from '@gugu/core/tools'
import type { RunIdentity } from '@gugu/core/agent'

/** 飞书凭据和目标只能由 Host 根据运行身份解析，不能从工具参数读取。 */
export interface FeishuLinkButtonTarget { botId:string; receiveId:string; accessToken:string }
export function createFeishuLinkButtonSender(options:{
  resolve(identity:RunIdentity):Promise<FeishuLinkButtonTarget|null>
  fetch?:typeof fetch
}):ImLinkButtonSender {
  const binding=(target:FeishuLinkButtonTarget)=>createHash('sha256').update(JSON.stringify([target.botId,target.receiveId])).digest('hex')
  return {
    async resolve(identity){
      const target=await options.resolve(identity)
      return target?.botId && target.receiveId && target.accessToken?{platform:'feishu',binding:binding(target)}:null
    },
    async send(input){
      if('error' in validateLinkButtons(input.message,input.buttons))return {status:'failed',delivery:'none',buttonCount:input.buttons.length}
      const target=await options.resolve(input.identity)
      if(!target?.botId || !target.receiveId || !target.accessToken || input.channel.platform!=='feishu' || binding(target)!==input.channel.binding)return {status:'unknown'}
      const recipientType=target.receiveId.startsWith('ou_')?'open_id':'chat_id'
      const url=`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${recipientType}`
      const send=async(msgType:'interactive'|'text',content:unknown):Promise<'accepted'|'rejected'|'unknown'>=>{
        try{
          const response=await (options.fetch??fetch)(url,{method:'POST',redirect:'error',signal:input.signal,
            headers:{authorization:`Bearer ${target.accessToken}`,'content-type':'application/json; charset=utf-8'},
            body:JSON.stringify({receive_id:target.receiveId,msg_type:msgType,content:JSON.stringify(content)})})
          if(!response.ok)return response.status>=400&&response.status<500&&![408,409,429].includes(response.status)?'rejected':'unknown'
          const payload:unknown=await response.json()
          if(!payload || typeof payload!=='object' || !('code' in payload) || typeof payload.code!=='number')return 'unknown'
          return payload.code===0?'accepted':'rejected'
        }catch{return 'unknown'}
      }
      const actions=input.buttons.map(button=>({tag:'button',text:{tag:'plain_text',content:button.label},type:'primary',behaviors:[{type:'open_url',default_url:button.url}]}))
      const card={config:{wide_screen_mode:true},elements:[{tag:'markdown',content:input.message},{tag:'action',actions}]}
      const native=await send('interactive',card)
      if(native==='accepted')return {status:'sent',delivery:'native',buttonCount:input.buttons.length}
      if(native==='unknown')return {status:'unknown'}
      const text=[input.message,...input.buttons.map(button=>`· ${button.label}：${button.url}`)].join('\n')
      const fallback=await send('text',{text})
      if(fallback==='accepted')return {status:'sent_with_fallback',delivery:'text',buttonCount:input.buttons.length}
      return fallback==='unknown'?{status:'unknown'}:{status:'failed',delivery:'none',buttonCount:input.buttons.length}
    },
  }
}
