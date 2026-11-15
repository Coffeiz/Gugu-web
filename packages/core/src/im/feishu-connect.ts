import {sql,type Kysely} from 'kysely'
import {dataContext} from '../contracts/index.js'
import type {ProviderTransport} from '../agent/providers/contracts.js'
import type {QqConnectStore} from './qq-connect.js'
import {insertUserBot,invalidateOwnerImSnapshots} from './user-bot-create.js'
export class FeishuConnectionError extends Error {
 override name='FeishuConnectionError'
 constructor(readonly statusCode:number,message:string){super(message)}
}
export interface FeishuConnectOptions {
 transport:ProviderTransport;store:QqConnectStore;portalBase:string;allowLocal?:boolean;stateAvailable?:boolean
 generateId():string;encrypt(value:string):string|Promise<string>;platforms():readonly string[]|Promise<readonly string[]>
 saveReach(owner:string,botId:string,openId:string):Promise<void>;publishChanged(owner:string):Promise<unknown>
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
export function createFeishuConnector<DB>(db:Kysely<DB>,options:FeishuConnectOptions) {
 async function ready(){if(options.stateAvailable===false)throw new FeishuConnectionError(503,'飞书连接状态暂不可用');if(!(await options.platforms()).includes('feishu'))throw new FeishuConnectionError(503,'该即时通讯平台暂未开放')}
 const state=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work()}catch{throw new FeishuConnectionError(503,'飞书连接状态暂不可用')}}
 async function post(action:string,fields:Record<string,string>={}) {
  let response
  try{
   response=await options.transport.request({url:options.portalBase.replace(/\/$/,'')+'/oauth/v1/app/registration',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new TextEncoder().encode(new URLSearchParams({action,...fields}).toString()),timeoutMs:15000,allowLocal:options.allowLocal??false},AbortSignal.timeout(15000))
   if(action!=='poll'&&response.status===429)throw new FeishuConnectionError(429,'飞书接口限流了，过一会儿再试～')
   if(response.status>=300&&!(action==='poll'&&response.status>=400))throw new Error('上游请求失败')
   let raw='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true})
   for await(const chunk of response.body){size+=chunk.byteLength;if(size>1024*1024)throw new Error('上游响应过大');raw+=decoder.decode(chunk,{stream:true})}raw+=decoder.decode()
   const value:unknown=JSON.parse(raw);if(!object(value))throw new Error('上游响应无效');return value
  }catch(error){if(error instanceof FeishuConnectionError)throw error;throw new FeishuConnectionError(502,action==='poll'?'轮询失败':'创建飞书连接任务失败')}
  finally{await response?.cancel()}
 }
 return {
  async start(ownerId:string){
   const owner=dataContext(ownerId).ownerId;await ready()
   const init=await post('init');if(!Array.isArray(init.supported_auth_methods)||!init.supported_auth_methods.includes('client_secret'))throw new FeishuConnectionError(502,'飞书不支持 client_secret 注册方式')
   const begin=await post('begin',{archetype:'PersonalAgent',auth_method:'client_secret',request_user_info:'open_id'}),code=begin.device_code,uri=begin.verification_uri_complete
   if(typeof code!=='string'||!code||typeof uri!=='string'||!uri)throw new FeishuConnectionError(502,'飞书未返回 device_code / 扫码地址')
   let scan:URL;try{scan=new URL(uri);if(scan.protocol!=='https:'||scan.username||scan.password)throw Error()}catch{throw new FeishuConnectionError(502,'飞书扫码地址无效')}
   const id=options.generateId();if(!await state(()=>options.store.saveIfAbsent('feishuconnect:'+id,JSON.stringify({uid:owner,device_code:code}),3600)))throw new FeishuConnectionError(503,'飞书连接任务冲突，请重试')
   return {poll_id:id,scan_url:uri+(uri.includes('?')?'&':'?')+'source=Gugu'}
  },
  async poll(ownerId:string,id:string):Promise<{status:string;reason?:string;bot?:{id:number;name:string;app_id:string}}>{
   const owner=dataContext(ownerId).ownerId;await ready();const raw=await state(()=>options.store.get('feishuconnect:'+id));if(!raw)return {status:'expired'}
   let meta:Record<string,unknown>;try{const parsed:unknown=JSON.parse(raw);if(!object(parsed))throw Error();meta=parsed}catch{throw new FeishuConnectionError(503,'飞书连接状态暂不可用')}
   if(meta.uid!==owner)throw new FeishuConnectionError(403,'任务不属于当前用户')
   if(typeof meta.device_code!=='string')throw new FeishuConnectionError(503,'飞书连接状态暂不可用')
   const data=await post('poll',{device_code:meta.device_code}),app=data.client_id,secret=data.client_secret
   if(app&&secret&&typeof app==='string'&&typeof secret==='string'){
    const userInfo=object(data.user_info)?data.user_info:{},oid=userInfo.open_id||data.open_id
    const bot=await db.transaction().execute(async tx=>{
     await sql`SELECT id FROM users WHERE id=${owner} FOR UPDATE`.execute(tx)
     const existing=(await sql<{id:number;name:string}>`SELECT id,name FROM user_bots WHERE user_id=${owner} AND platform='feishu' AND app_id=${app} ORDER BY id LIMIT 1 FOR UPDATE`.execute(tx)).rows[0]
     const encrypted=await options.encrypt(secret)
     const botId=existing?existing.id:await insertUserBot(tx,owner,{platform:'feishu',app_id:app,app_secret:secret},encrypted)
     if(existing)await sql`UPDATE user_bots SET app_secret=${encrypted},enabled=true WHERE id=${botId} AND user_id=${owner}`.execute(tx)
     return {id:botId,name:existing?.name??'我的飞书机器人',app_id:app}
    })
    // Python先提交凭据，再提交owner绑定；后一步失败不能误报已回滚凭据。
    if(oid)await sql`UPDATE user_bots SET owner_platform_user_id=${String(oid)},owner_bound_at=clock_timestamp() WHERE id=${bot.id} AND user_id=${owner}`.execute(db)
    if(oid)try{await options.saveReach(owner,String(bot.id),String(oid))}catch{/* 可触达缓存失败不撤销已经提交的绑定。 */}
    try{await invalidateOwnerImSnapshots(db,owner)}catch{/* 只失效当前owner的IM来源。 */}
    try{await options.publishChanged(owner)}catch{/* 持久凭据由现有网关周期扫描消费。 */}
    await state(()=>options.store.delete('feishuconnect:'+id))
    return {status:'success',bot}
   }
   if(data.error==='expired_token'||data.error==='invalid_grant'){await state(()=>options.store.delete('feishuconnect:'+id));return {status:'expired'}}
   if(data.error==='access_denied'){await state(()=>options.store.delete('feishuconnect:'+id));return {status:'fail',reason:'用户拒绝了授权'}}
   return {status:'waiting'}
  },
 }
}
