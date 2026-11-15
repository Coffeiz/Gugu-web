import {randomBytes} from 'node:crypto'
import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {NodeProviderTransport} from '@gugu/core/providers/node'
import type {createQqConnector} from '@gugu/core/im/qq-connect'
import {createRedisExpiringValueStore} from '../../adapters/redis-events.js'
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
