import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { WriteRequestMetadata } from '../../app.js'
import { writeRequestMetadata } from '../../http/request.js'

export interface FileCopyInput {
  folderId: number | null
  projectId: number | null
  workspaceDirectoryId: number | null
  onConflict: 'keep_both' | 'overwrite'
  overwriteFileId: number | null
}
export interface FileCopyOperations { copy(ownerId:string,fileId:number,input:FileCopyInput,metadata:WriteRequestMetadata):Promise<unknown> }
export interface FileCopyRouteOptions { requireUser:preHandlerHookHandler; ownerIdFromRequest(request:FastifyRequest):string; operations:FileCopyOperations }

function id(value:unknown,field:string):number|null {
  if(value===undefined||value===null)return null
  if(!Number.isSafeInteger(value)||Number(value)<1)throw new CoreError('invalid_request',`${field} 无效`)
  return Number(value)
}
function fileId(value:string):number {
  if(!/^\d+$/.test(value))throw new CoreError('invalid_request','文件 ID 无效')
  const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<1)throw new CoreError('invalid_request','文件 ID 无效');return parsed
}
export function registerFileCopyRoutes(app:FastifyInstance,options:FileCopyRouteOptions):void {
  app.post<{Params:{fid:string}}>('/api/v1/files/:fid/copy',{preHandler:options.requireUser},async request=>{
    if(!request.body||typeof request.body!=='object'||Array.isArray(request.body))throw new CoreError('invalid_request','复制参数无效')
    const body=request.body as Record<string,unknown>
    const onConflict=body.onConflict??'keep_both'
    if(onConflict!=='keep_both'&&onConflict!=='overwrite')throw new CoreError('invalid_request','冲突处理方式无效')
    const overwriteFileId=id(body.overwriteFileId,'overwriteFileId')
    if(onConflict==='overwrite'&&overwriteFileId===null)throw new CoreError('invalid_request','覆盖复制缺少目标文件')
    if(onConflict==='keep_both'&&overwriteFileId!==null)throw new CoreError('invalid_request','保留两者时不能指定覆盖目标')
    return options.operations.copy(options.ownerIdFromRequest(request),fileId(request.params.fid),{
      folderId:id(body.folderId,'folderId'),projectId:id(body.projectId,'projectId'),
      workspaceDirectoryId:id(body.workspaceDirectoryId,'workspaceDirectoryId'),onConflict,overwriteFileId,
    },writeRequestMetadata(request, { limitHeaders: true }))
  })
}
