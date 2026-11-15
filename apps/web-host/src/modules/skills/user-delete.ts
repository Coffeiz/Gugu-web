import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'

export interface UserSkillDeleteOptions {
  requireUser:preHandlerHookHandler
  ownerIdFromRequest(request:FastifyRequest):string
  remove(ownerId:string,skillId:string):Promise<void>
}
export function registerUserSkillDeleteRoute(app:FastifyInstance,options:UserSkillDeleteOptions):void {
  app.delete<{Params:{skill_id:string}}>('/api/v1/skills/:skill_id',{preHandler:options.requireUser},async(request,reply)=>{
    await options.remove(options.ownerIdFromRequest(request),request.params.skill_id)
    return reply.code(204).send()
  })
}
