import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createMisreadMarkdownExporter} from '@gugu/core/perception-misread-export'
import {openLocalFile} from '@gugu/fs/node'

/** 受信 Local 存储根中的固定服务端文件，不接受请求路径；句柄始终关闭。 */
export function createLocalMisreadTextReader(storageRoot:string):()=>Promise<string>{
 return async()=>{
  const file=await openLocalFile(storageRoot,'_analytics/misread.md')
  if(!file)return ''
  try{return (await file.handle.readFile()).toString('utf8')}finally{await file.handle.close()}
 }
}
export interface AdminMisreadExportOptions {requireAdmin:preHandlerHookHandler;read:ReturnType<typeof createMisreadMarkdownExporter>}
export function registerAdminMisreadExportRoute(app:FastifyInstance,options:AdminMisreadExportOptions):void{
 app.get('/api/v1/admin/perception/misread/export',{preHandler:options.requireAdmin},async(_request,reply)=>reply.type('text/markdown; charset=utf-8').header('content-disposition','attachment; filename="misread_reflections.md"').send(await options.read()))
}
