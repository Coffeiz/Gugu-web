import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'

export interface EmbeddingRebuildStatusOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 available?:()=>boolean
 read(ownerId:string):Promise<unknown>
}
export function registerEmbeddingRebuildStatusRoute(app:FastifyInstance,options:EmbeddingRebuildStatusOptions):void{
 app.get('/api/v1/byok/embedding-rebuild/status',{preHandler:options.requireUser},(request,reply)=>{
  if(options.available && !options.available()) return reply.code(503).send({detail:'重建状态服务不可用'})
  return options.read(options.ownerIdFromRequest(request))
 })
}
