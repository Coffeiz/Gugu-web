import {randomUUID,randomInt} from 'node:crypto'
import type {FastifyInstance,FastifyReply,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {NodeProviderTransport} from '@gugu/core/providers/node'
import {sql,type Kysely} from 'kysely'
import {createWechatPairing,type WechatPairingOptions} from '@gugu/gateway/wechat'
import {insertUserBot,invalidateOwnerImSnapshots} from '@gugu/core/im/user-bot-create'
import {createRedisExpiringValueStore} from '../../../../../adapters/cache/redis-events.js'

/** 与Python一致固定官方iLink目标；合成服务只由测试依赖或隔离代理提供。 */
export function createWechatConnectHostOptions(env:NodeJS.ProcessEnv,redisUrl:string){
 return {portalBase:'https://ilinkai.weixin.qq.com',allowLocal:false,stateAvailable:Boolean(redisUrl),transport:new NodeProviderTransport({environment:()=>env}),store:createRedisExpiringValueStore(redisUrl),generateId:()=>randomUUID().replaceAll('-',''),randomUin:()=>randomInt(0xFFFFFFFF)}
}

export interface WechatConnectRouteOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;connect:ReturnType<typeof createWechatConnector>}
export function registerWechatConnectRoutes(app:FastifyInstance,options:WechatConnectRouteOptions):void{
 const run=async(work:()=>Promise<unknown>,reply:FastifyReply)=>{
  try{return await work()}catch(error){
   if(error instanceof Error&&error.name==='WechatConnectionError'){
    const code=(error as Error&{statusCode:number}).statusCode
    if(code===403)return reply.code(403).send({detail:'任务不属于当前用户'})
    if(code===503)return reply.code(503).send({detail:'微信连接状态或平台暂不可用'})
    if(code===502)return reply.code(502).send({detail:'微信连接请求失败，请稍后重试'})
   }
   throw error
  }
 }
 app.post('/api/v1/me/wechat/connect',{preHandler:options.requireUser},(request,reply)=>run(()=>options.connect.start(options.ownerIdFromRequest(request)),reply))
 app.get<{Params:{task_id:string}}>('/api/v1/me/wechat/connect/:task_id',{preHandler:options.requireUser},(request,reply)=>run(()=>options.connect.poll(options.ownerIdFromRequest(request),request.params.task_id),reply))
}

type WechatConnectOptions = WechatPairingOptions & {
 encrypt(value:string):string|Promise<string>
 publishChanged(owner:string):Promise<unknown>
}

/** Web Host 使用事务更新加密凭据，并通知网关重新读取。 */
export function createWechatConnector<DB>(db:Kysely<DB>,options:WechatConnectOptions){
 return createWechatPairing({...options,async saveBot(owner,token,base){
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
   return refreshed
 },async onSaved(owner){
   try{await invalidateOwnerImSnapshots(db,owner)}catch{/* 已提交凭据仍由网关周期扫描读取。 */}
   try{await options.publishChanged(owner)}catch{/* Redis发布失败不撤销已经持久化的连接。 */}
 }})
}
