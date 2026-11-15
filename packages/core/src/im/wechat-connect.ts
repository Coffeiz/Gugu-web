import {sql,type Kysely} from 'kysely'
import {dataContext} from '../contracts/index.js'
import type {ProviderTransport} from '../agent/providers/contracts.js'
import type {QqConnectStore} from './qq-connect.js'
import {insertUserBot,invalidateOwnerImSnapshots} from './user-bot-create.js'

export class WechatConnectionError extends Error {
 override name='WechatConnectionError'
 constructor(readonly statusCode:number,message:string){super(message)}
}
export interface WechatConnectOptions {
 transport:ProviderTransport;store:QqConnectStore;portalBase:string;allowLocal?:boolean;stateAvailable?:boolean
 generateId():string;randomUin():number;encrypt(value:string):string|Promise<string>
 platforms():readonly string[]|Promise<readonly string[]>;publishChanged(owner:string):Promise<unknown>
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
/** 微信二维码挑战仅在服务端保存；成功持久化后现有网关读取同一加密UserBot。 */
export function createWechatConnector<DB>(db:Kysely<DB>,options:WechatConnectOptions){
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
   const bot=await db.transaction().execute(async tx=>{
    await sql`SELECT id FROM users WHERE id=${owner} FOR UPDATE`.execute(tx)
    const old=(await sql<{id:number;name:string}>`SELECT id,name FROM user_bots WHERE user_id=${owner} AND platform='wechat' ORDER BY id LIMIT 1 FOR UPDATE`.execute(tx)).rows[0]
    const encrypted=await options.encrypt(token)
    const botId=old?old.id:await insertUserBot(tx,owner,{platform:'wechat',name:'我的微信',app_id:base},encrypted)
    if(old)await sql`UPDATE user_bots SET app_secret=${encrypted},app_id=${base},enabled=true WHERE id=${old.id} AND user_id=${owner}`.execute(tx)
    return {id:botId,name:old?.name??'我的微信'}
   })
   const refreshed=(await sql<{id:number;name:string}>`SELECT id,name FROM user_bots WHERE id=${bot.id} AND user_id=${owner}`.execute(db)).rows[0]
   if(!refreshed)throw new Error('微信机器人刷新失败')
   await state(()=>options.store.delete('wechatconnect:'+id))
   try{await invalidateOwnerImSnapshots(db,owner)}catch{/* 已提交凭据仍由网关周期扫描读取。 */}
   try{await options.publishChanged(owner)}catch{/* Redis发布失败不撤销已经持久化的连接。 */}
   return {status:'success',bot:refreshed}
  },
 }
}
