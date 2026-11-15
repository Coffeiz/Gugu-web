import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createAdminMaintenanceStatus} from '@gugu/core/maintenance/admin-status'

export function registerAdminMaintenanceStatusRoutes(app:FastifyInstance,options:{
 requireAdmin:preHandlerHookHandler
 available():boolean
 read:ReturnType<typeof createAdminMaintenanceStatus>
}):void{
 app.get('/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview/status',{preHandler:options.requireAdmin},async(_request,reply)=>{
  if(!options.available())return reply.code(503).send({detail:'维护状态服务不可用'})
  try{return await options.read.imMemoryModelPreview()}catch(error){if(error instanceof SyntaxError)throw error;return reply.code(503).send({detail:'维护状态服务不可用'})}
 })
 app.get('/api/v1/admin/config/index-rebuild/status',{preHandler:options.requireAdmin},async(_request,reply)=>{
  if(!options.available())return reply.code(503).send({detail:'维护状态服务不可用'})
  try{return await options.read.indexRebuild()}catch{return reply.code(503).send({detail:'维护状态服务不可用'})}
 })
 app.get('/api/v1/admin/config/memory-cleanup/status',{preHandler:options.requireAdmin},async(_request,reply)=>{
  if(!options.available())return reply.code(503).send({detail:'维护状态服务不可用'})
  try{return await options.read.memoryCleanup()}catch{return reply.code(503).send({detail:'维护状态服务不可用'})}
 })
}
