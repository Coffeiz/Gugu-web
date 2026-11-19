import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {Pool} from 'pg'
import {createUserBotUnbinder} from '@gugu/core/im/user-bots'
export function createPostgresUserBotUnbinder(pool:Pick<Pool,'query'>,publishChanged:(ownerId:string)=>Promise<unknown>) {
 return createUserBotUnbinder((sql,params)=>pool.query(sql,params),publishChanged)
}
export interface UserBotUnbindOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;unbind:ReturnType<typeof createPostgresUserBotUnbinder>}
export function registerUserBotUnbindRoute(app:FastifyInstance,options:UserBotUnbindOptions):void {
 app.delete<{Params:{bot_id:number}}>('/api/v1/me/bots/:bot_id/qq-binding',{preHandler:options.requireUser,schema:{params:{type:'object',required:['bot_id'],properties:{bot_id:{type:'integer'}}}}},async(request,reply)=>{
  await options.unbind(options.ownerIdFromRequest(request),request.params.bot_id)
  return reply.code(204).send()
 })
}
