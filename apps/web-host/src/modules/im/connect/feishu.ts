import {randomBytes} from 'node:crypto'
import type {FastifyInstance,FastifyRequest,preHandlerHookHandler,FastifyReply} from 'fastify'
import {NodeProviderTransport} from '@gugu/core/providers/node'
import type {createFeishuConnector} from '@gugu/core/im/feishu-connect'
import {createRedisExpiringValueStore,createRedisFeishuReachWriter} from '../../../adapters/cache/redis-events.js'
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
