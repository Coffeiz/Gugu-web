import type {GatewayPairingStore} from '../../ports.js'
import {dataContext} from '@gugu/core/contracts'
import type {ProviderTransport} from '@gugu/core/providers'

export class WechatConnectionError extends Error {
 override name='WechatConnectionError'
 constructor(readonly statusCode:number,message:string){super(message)}
}
export interface WechatPairingOptions {
 transport:ProviderTransport;store:GatewayPairingStore;portalBase:string;allowLocal?:boolean;stateAvailable?:boolean
 generateId():string;randomUin():number
 platforms():readonly string[]|Promise<readonly string[]>
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
interface WechatPairingPersistence {
 saveBot(owner:string,token:string,base:string,identity:{botId:unknown;userId:unknown}):Promise<{id:number;name:string}>
 onSaved?(owner:string):Promise<void>
}

/** 微信扫码和轮询共用协议，凭据交给当前运行时持久化。 */
export function createWechatPairing(options:WechatPairingOptions & WechatPairingPersistence){
 async function ready(){if(options.stateAvailable===false)throw new WechatConnectionError(503,'微信连接状态暂不可用');if(!(await options.platforms()).includes('wechat'))throw new WechatConnectionError(503,'该即时通讯平台暂未开放')}
 const state=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work()}catch{throw new WechatConnectionError(503,'微信连接状态暂不可用')}}
 async function get(path:string,params:Record<string,string>,timeout:number){
  let response
  try{
   const url=new URL(options.portalBase.replace(/\/$/,'')+'/'+path);for(const [key,value] of Object.entries(params))url.searchParams.set(key,value)
   response=await options.transport.request({url:url.toString(),method:'GET',headers:{'Content-Type':'application/json',AuthorizationType:'ilink_bot_token','X-WECHAT-UIN':btoa(String(options.randomUin()))},timeoutMs:timeout,allowLocal:options.allowLocal??false},AbortSignal.timeout(timeout))
   if(response.status<200||response.status>=300)throw new Error('上游请求失败')
   const decoder=new TextDecoder('utf-8',{fatal:true});let raw='',size=0
   for await(const chunk of response.body){size+=chunk.byteLength;if(size>1024*1024)throw new Error('上游响应过大');raw+=decoder.decode(chunk,{stream:true})}raw+=decoder.decode()
   const value:unknown=JSON.parse(raw);if(!object(value))throw new Error('上游响应无效');return value
  }catch{throw new WechatConnectionError(502,path.endsWith('status')?'轮询微信扫码失败':'获取微信二维码失败')}
  finally{await response?.cancel()}
 }
 return {
  async start(ownerId:string){
   const owner=dataContext(ownerId).ownerId;await ready()
   const data=await get('ilink/bot/get_bot_qrcode',{bot_type:'3'},15000),code=data.qrcode,uri=data.qrcode_img_content
   if(typeof code!=='string'||!code||typeof uri!=='string'||!uri)throw new WechatConnectionError(502,'微信未返回二维码')
   try{const scan=new URL(uri);if(scan.protocol!=='https:'||scan.username||scan.password)throw new Error()}catch{throw new WechatConnectionError(502,'微信扫码地址无效')}
   const id=options.generateId()
   if(!await state(()=>options.store.saveIfAbsent('wechatconnect:'+id,JSON.stringify({uid:owner,qrcode:code}),600)))throw new WechatConnectionError(503,'微信连接任务冲突，请重试')
   return {task_id:id,scan_url:uri}
  },
  async poll(ownerId:string,id:string):Promise<{status:string;reason?:string;bot?:{id:number;name:string}}>{
   const owner=dataContext(ownerId).ownerId;await ready();const raw=await state(()=>options.store.get('wechatconnect:'+id));if(!raw)return {status:'expired'}
   let meta:Record<string,unknown>;try{const parsed:unknown=JSON.parse(raw);if(!object(parsed))throw new Error();meta=parsed}catch{throw new WechatConnectionError(503,'微信连接状态暂不可用')}
   if(meta.uid!==owner)throw new WechatConnectionError(403,'任务不属于当前用户')
   if(typeof meta.qrcode!=='string')throw new WechatConnectionError(503,'微信连接状态暂不可用')
   const data=await get('ilink/bot/get_qrcode_status',{qrcode:meta.qrcode},60000)
   if(data.status==='expired'){await state(()=>options.store.delete('wechatconnect:'+id));return {status:'expired'}}
   if(data.status!=='confirmed')return {status:'waiting'}
   const token=data.bot_token,base=data.baseurl??''
   if(typeof token!=='string'||!token)return {status:'fail',reason:'未拿到 bot_token'}
   if(typeof base!=='string')throw new WechatConnectionError(502,'微信返回的连接地址无效')
   const bot=await options.saveBot(owner,token,base,{botId:data.ilink_bot_id,userId:data.ilink_user_id})
   await state(()=>options.store.delete('wechatconnect:'+id))
   await options.onSaved?.(owner)
   return {status:'success',bot}
  },
 }
}

