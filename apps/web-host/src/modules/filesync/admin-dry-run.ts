import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createFileSyncDryRun} from '@gugu/core/filesync-dry-run'
import {parsePythonInteger} from '../../http/request.js'

export interface AdminFileSyncDryRunOptions{
 requireAdmin:preHandlerHookHandler
 create:ReturnType<typeof createFileSyncDryRun>
}
export function registerAdminFileSyncDryRunRoute(app:FastifyInstance,options:AdminFileSyncDryRunOptions):void{
 app.post<{Params:{binding_id:string}}>('/api/v1/admin/filesync/bindings/:binding_id/dry-run',{preHandler:options.requireAdmin},(request,reply)=>{
  const id=parsePythonInteger(request.params.binding_id)
  if(id==null)return reply.code(422).send({detail:'绑定标识无效'})
  return options.create(id)
 })
}
