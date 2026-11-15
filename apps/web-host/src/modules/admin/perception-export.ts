import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createPerceptionEventExporter} from '@gugu/core/perception-export'
import {parsePerceptionInteger} from './perception-recent-misread.js'

export interface AdminPerceptionExportOptions {
 requireAdmin:preHandlerHookHandler
 available():boolean
 read:ReturnType<typeof createPerceptionEventExporter>
}
export function registerAdminPerceptionExportRoute(app:FastifyInstance,options:AdminPerceptionExportOptions):void{
 app.get('/api/v1/admin/perception/export',{preHandler:options.requireAdmin},async(request,reply)=>{
  const query=request.query as Record<string,unknown>,hours=parsePerceptionInteger(query.hours,0n)
  if(!options.available())return reply.code(503).send({detail:'感知记录服务不可用'})
  const snapshot=await options.read(hours)
  return reply.type('application/json; charset=utf-8').header('content-disposition',`attachment; filename="${snapshot.filename}"`).send(JSON.stringify(snapshot.events,null,1))
 })
}
