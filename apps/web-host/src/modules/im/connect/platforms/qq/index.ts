import {randomBytes} from 'node:crypto'
import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {NodeProviderTransport} from '@gugu/core/providers/node'
import {sql,type Kysely} from 'kysely'
import {createQqPairing,type QqPairingProtocolOptions} from '@gugu/gateway/qq'
import {insertQqBot,invalidateOwnerImSnapshots} from '@gugu/core/im/user-bot-create'
import {createRedisExpiringValueStore} from '../../../../../adapters/cache/redis-events.js'
/** 自定义门户仅来自可信Host环境；请求体不能改变目标或开启本地网络访问。 */
export function createQqConnectHostOptions(env:NodeJS.ProcessEnv,redisUrl:string) {
 const host=env.QQ_PORTAL_HOST||'q.qq.com',portal=new URL(`https://${host}`)
 if(portal.username||portal.password||portal.pathname!=='/'||portal.search||portal.hash||portal.host!==host)throw new Error('QQ门户配置无效')
 const allowLocal=Boolean(env.QQ_PORTAL_HOST)
 return {portalBase:portal.origin,allowLocal,stateAvailable:Boolean(redisUrl),transport:new NodeProviderTransport({allowLocal,environment:()=>env}),store:createRedisExpiringValueStore(redisUrl),generateKey:()=>randomBytes(32).toString('base64')}
}
export interface QqConnectRouteOptions {
 requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string
 connect:ReturnType<typeof createQqConnector>
}
export function registerQqConnectRoutes(app:FastifyInstance,options:QqConnectRouteOptions):void {
 const run=async(work:()=>Promise<unknown>,reply:import('fastify').FastifyReply)=>{
  try{return await work()}catch(error){
   if(error instanceof Error&&error.name==='QqConnectionError'){
    const status=(error as Error&{statusCode?:number}).statusCode
    if(status===403)return reply.code(403).send({detail:'任务不属于当前用户'})
    if(status===503)return reply.code(503).send({detail:'QQ 连接状态或平台暂不可用'})
    if(status===502)return reply.code(502).send({detail:'QQ 连接请求失败，请稍后重试'})
   }
   throw error
  }
 }
 app.post('/api/v1/me/qq/connect',{preHandler:options.requireUser},(request,reply)=>run(()=>options.connect.start(options.ownerIdFromRequest(request)),reply))
 app.get<{Params:{task_id:string}}>('/api/v1/me/qq/connect/:task_id',{preHandler:options.requireUser},(request,reply)=>run(()=>options.connect.poll(options.ownerIdFromRequest(request),request.params.task_id),reply))
}

type QqConnectOptions = QqPairingProtocolOptions & {
 encrypt(value:string):string|Promise<string>
 publishChanged(ownerId:string):Promise<unknown>
}

export function createQqConnector<DB>(db:Kysely<DB>,options:QqConnectOptions) {
 return createQqPairing({...options,async saveBot(owner,app,secret) {
   const result=await db.transaction().execute(async tx=>{
    await sql`SELECT id FROM users WHERE id=${owner} FOR UPDATE`.execute(tx)
    const existing=(await sql<{id:number;name:string;app_id:string}>`SELECT id,name,app_id FROM user_bots WHERE user_id=${owner} AND platform='qq' ORDER BY (app_id=${app}) DESC,id LIMIT 1 FOR UPDATE`.execute(tx)).rows[0]
    if(existing&&existing.app_id!==app)return null
    const cipher=await options.encrypt(secret)
    if(existing){await sql`UPDATE user_bots SET app_secret=${cipher},enabled=true WHERE id=${existing.id} AND user_id=${owner}`.execute(tx);return {id:existing.id,name:existing.name,app_id:app}}
    const id=await insertQqBot(tx,owner,{app_id:app,app_secret:secret},cipher)
    return {id,name:'我的 QQ 机器人',app_id:app}
   })
   return result
 },async onSaved(owner){
   try{await invalidateOwnerImSnapshots(db,owner)}catch{/* 与Python渠道失效相同，通知失败不撤销凭据提交。 */}
   try{await options.publishChanged(owner)}catch{/* 允许后续网关扫描读取已保存凭据。 */}
 }})
}
