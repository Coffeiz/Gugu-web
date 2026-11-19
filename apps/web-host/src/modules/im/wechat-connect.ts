import {randomUUID,randomInt} from 'node:crypto'
import type {FastifyInstance,FastifyReply,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {NodeProviderTransport} from '@gugu/core/providers/node'
import type {createWechatConnector} from '@gugu/core/im/wechat-connect'
import {createRedisExpiringValueStore} from '../../adapters/cache/redis-events.js'

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
