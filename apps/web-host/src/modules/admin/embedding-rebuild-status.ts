import type {FastifyInstance,preHandlerHookHandler} from 'fastify'

export interface AdminEmbeddingRebuildStatusOptions{
 requireAdmin:preHandlerHookHandler
 available:()=>boolean
 read():Promise<unknown>
}
export function registerAdminEmbeddingRebuildStatusRoute(app:FastifyInstance,options:AdminEmbeddingRebuildStatusOptions):void{
 app.get('/api/v1/admin/config/embedding-rebuild/status',{preHandler:options.requireAdmin},(_request,reply)=>{
  if(!options.available())return reply.code(503).send({detail:'重建状态服务不可用'})
  return options.read()
 })
}
