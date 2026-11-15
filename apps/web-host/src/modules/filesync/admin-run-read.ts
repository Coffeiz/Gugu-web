import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createFileSyncRunReader} from '@gugu/core/filesync-run-read'
import {parsePythonInteger} from '../../http/request.js'

export interface AdminFileSyncRunReadOptions{
 requireAdmin:preHandlerHookHandler
 reader:ReturnType<typeof createFileSyncRunReader>
}
// 与 Python UUID 接受的紧凑格式、花括号和 urn:uuid 前缀保持兼容。
export function fileSyncRunUuid(value:string):string|null{
 const text=value.replaceAll('urn:','').replaceAll('uuid:','').replace(/^[{}]+|[{}]+$/g,'').replaceAll('-','')
 if(!/^[0-9a-f]{32}$/i.test(text))return null
 return [text.slice(0,8),text.slice(8,12),text.slice(12,16),text.slice(16,20),text.slice(20)].join('-').toLowerCase()
}
export function registerAdminFileSyncRunReadRoutes(app:FastifyInstance,options:AdminFileSyncRunReadOptions):void{
 app.get<{Querystring:{user_id?:string;binding_id?:string;limit?:string}}>('/api/v1/admin/filesync/runs',{preHandler:options.requireAdmin},(request,reply)=>{
  const user=request.query.user_id===undefined?undefined:fileSyncRunUuid(request.query.user_id),binding=parsePythonInteger(request.query.binding_id),limit=request.query.limit===undefined?50:parsePythonInteger(request.query.limit)
  if(user===null||(request.query.binding_id!==undefined&&binding==null)||limit==null||limit<1||limit>100)return reply.code(422).send({detail:'任务筛选参数无效'})
  return options.reader.list({...(user===undefined?{}:{userId:user}),...(binding==null?{}:{bindingId:binding}),limit})
 })
 app.get<{Params:{run_id:string}}>('/api/v1/admin/filesync/runs/:run_id',{preHandler:options.requireAdmin},(request,reply)=>{
  const id=fileSyncRunUuid(request.params.run_id)
  if(!id)return reply.code(422).send({detail:'任务标识无效'})
  return options.reader.get(id)
 })
}
