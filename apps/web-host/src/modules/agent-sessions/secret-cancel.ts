import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {parsePythonInteger} from '../../http/request.js'

export interface SecretPromptCancelOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 cancel(ownerId:string,promptId:number):Promise<{ok:boolean;prompt_id:number;status:string}>
}
export function registerSecretPromptCancelRoute(app:FastifyInstance,options:SecretPromptCancelOptions):void{
 app.post<{Params:{prompt_id:string}}>('/api/v1/agent/interactions/:prompt_id/secrets/cancel',{preHandler:options.requireUser},(request,reply)=>{
  const id=parsePythonInteger(request.params.prompt_id)
  if(id==null)return reply.code(422).send({detail:'交互标识无效'})
  return options.cancel(options.ownerIdFromRequest(request),id)
 })
}
