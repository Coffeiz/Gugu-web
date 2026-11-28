import {randomBytes} from 'node:crypto'
import type {FastifyInstance,FastifyRequest,preHandlerHookHandler,FastifyReply} from 'fastify'
import {NodeProviderTransport} from '@gugu/core/providers/node'
import {sql,type Kysely} from 'kysely'
import {createFeishuPairing,type FeishuPairingProtocolOptions} from '@gugu/gateway/feishu'
import {insertUserBot,invalidateOwnerImSnapshots} from '@gugu/core/im/user-bot-create'
import {createRedisExpiringValueStore,createRedisFeishuReachWriter} from '../../../../../adapters/cache/redis-events.js'
/** 与Python一致固定官方设备授权目标；合成门户只能由测试显式注入Core依赖。 */
export function createFeishuConnectHostOptions(env:NodeJS.ProcessEnv,redisUrl:string) {
 return {portalBase:'https://accounts.feishu.cn',allowLocal:false,stateAvailable:Boolean(redisUrl),transport:new NodeProviderTransport({environment:()=>env}),store:createRedisExpiringValueStore(redisUrl),saveReach:createRedisFeishuReachWriter(redisUrl),generateId:()=>randomBytes(16).toString('base64url')}
}
export interface FeishuConnectRouteOptions {
 requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string
 connect:ReturnType<typeof createFeishuConnector>
}
export function registerFeishuConnectRoutes(app:FastifyInstance,options:FeishuConnectRouteOptions):void {
 const run=async(work:()=>Promise<unknown>,reply:FastifyReply)=>{
  try{return await work()}catch(error){
   if(error instanceof Error&&error.name==='FeishuConnectionError'){
    const status=(error as Error&{statusCode?:number}).statusCode
    if(status===403)return reply.code(403).send({detail:'任务不属于当前用户'})
    if(status===429)return reply.code(429).send({detail:'飞书接口限流了，过一会儿再试～'})
    if(status===503)return reply.code(503).send({detail:'飞书连接状态或平台暂不可用'})
    if(status===502)return reply.code(502).send({detail:'飞书连接请求失败，请稍后重试'})
   }
   throw error
  }
 }
 app.post('/api/v1/me/feishu/connect',{preHandler:options.requireUser},(request,reply)=>run(()=>options.connect.start(options.ownerIdFromRequest(request)),reply))
 app.get<{Params:{poll_id:string}}>('/api/v1/me/feishu/connect/:poll_id',{preHandler:options.requireUser},(request,reply)=>run(()=>options.connect.poll(options.ownerIdFromRequest(request),request.params.poll_id),reply))
}

type FeishuConnectOptions = FeishuPairingProtocolOptions & {
 encrypt(value:string):string|Promise<string>
 saveReach(owner:string,botId:string,openId:string):Promise<void>
 publishChanged(owner:string):Promise<unknown>
}

export function createFeishuConnector<DB>(db:Kysely<DB>,options:FeishuConnectOptions) {
 return createFeishuPairing({...options,async saveBot(owner,app,secret,oid) {
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
    return bot
 }})
}
