import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createFileSyncRunCancellation} from '@gugu/core/filesync-run-cancel'
import {fileSyncRunUuid} from './admin-run-read.js'

export interface AdminFileSyncRunCancelOptions{
 requireAdmin:preHandlerHookHandler
 cancel:ReturnType<typeof createFileSyncRunCancellation>
}
export function registerAdminFileSyncRunCancelRoute(app:FastifyInstance,options:AdminFileSyncRunCancelOptions):void{
 app.post<{Params:{run_id:string}}>('/api/v1/admin/filesync/runs/:run_id/cancel',{preHandler:options.requireAdmin},(request,reply)=>{
  const id=fileSyncRunUuid(request.params.run_id)
  if(id===null)return reply.code(422).send({detail:'任务标识无效'})
  return options.cancel(id)
 })
}
