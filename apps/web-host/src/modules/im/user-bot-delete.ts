import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {createUserBotDeleter} from '@gugu/core/im/user-bot-delete'
export function registerUserBotDeleteRoute(app:FastifyInstance,options:{requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;remove:ReturnType<typeof createUserBotDeleter>}):void {
 app.delete<{Params:{bot_id:string}}>('/api/v1/me/bots/:bot_id',{preHandler:options.requireUser},async(request,reply)=>{
  const text=request.params.bot_id.trim(),id=/^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(text)?Number(text.replaceAll('_','')):NaN
  if(!Number.isSafeInteger(id))return reply.code(422).send({detail:'机器人标识必须是整数'})
  await options.remove(options.ownerIdFromRequest(request),id)
  return reply.code(204).send()
 })
}
