import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createFileSyncInitialize} from '@gugu/core/filesync-dry-run'
import {parsePythonInteger} from '../../http/request.js'
import {pythonQueryBoolean} from '../../http/python-query.js'
export interface AdminFileSyncInitializeOptions {requireAdmin:preHandlerHookHandler;create:ReturnType<typeof createFileSyncInitialize>}
export function registerAdminFileSyncInitializeRoute(app:FastifyInstance,options:AdminFileSyncInitializeOptions):void{
 app.post<{Params:{binding_id:string}}>('/api/v1/admin/filesync/bindings/:binding_id/initialize',{preHandler:options.requireAdmin},(request,reply)=>{
  const id=parsePythonInteger(request.params.binding_id),body=request.body
  if(id==null||!body||typeof body!=='object'||Array.isArray(body))return reply.code(422).send({detail:'初始化参数无效'})
  const value=body as Record<string,unknown>;let confirm=false,allowDelete=false
  try{if(value.confirm!==undefined)confirm=pythonQueryBoolean(value.confirm);if(value.allow_delete!==undefined)allowDelete=pythonQueryBoolean(value.allow_delete)}catch{return reply.code(422).send({detail:'初始化参数无效'})}
  if(!confirm)return reply.code(400).send({detail:'初始化必须显式确认'})
  if(allowDelete)return reply.code(400).send({detail:'初始化不能删除文件库记录'})
  return options.create(id)
 })
}
