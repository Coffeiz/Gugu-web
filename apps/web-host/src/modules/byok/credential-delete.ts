import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
export interface CredentialDeleteOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 remove(ownerId:string,credentialId:number):Promise<void>
}
export function registerCredentialDeleteRoute(app:FastifyInstance,options:CredentialDeleteOptions):void{
 app.delete<{Params:{credential_id:number}}>('/api/v1/byok/:credential_id',{
  preHandler:options.requireUser,
  schema:{params:{type:'object',required:['credential_id'],properties:{credential_id:{type:'integer'}}}},
 },async(request,reply)=>{
  await options.remove(options.ownerIdFromRequest(request),request.params.credential_id)
  return reply.code(204).send()
 })
}
