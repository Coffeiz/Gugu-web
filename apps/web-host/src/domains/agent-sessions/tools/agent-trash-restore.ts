import { createHash } from 'node:crypto'
import { CoreError, dataContext } from '@gugu/core'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { TrashRestorePort, TrashRestoreRequest } from '@gugu/core/tools'
import type { FileRestoreOperations } from '../../files/file-restore.js'

/** 文件恢复跨 SQL 和磁盘，先预留调用；未记录结果时绝不重放文件操作。 */
export function createAgentTrashRestorePort(core:SqlDataRuntime,operations:FileRestoreOperations):TrashRestorePort {
 if(!core.receipts || !operations.restoreFolder)throw new Error('回收站恢复后端未装配')
 const absent=new Error('收据不存在')
 function keys(input:TrashRestoreRequest,phase:string){
  const context=dataContext(input.identity.ownerId),parts=['trash.restore',phase,context.ownerId,input.identity.sessionId,input.identity.runId,input.roundId,input.toolCallId]
  if(parts.some(value=>typeof value!=='string'||!value.trim()))throw new Error('工具运行身份无效')
  const hash=createHash('sha256').update(JSON.stringify(parts)).digest('hex'),raw=hash.slice(0,12)+'5'+hash.slice(13,16)+'8'+hash.slice(17,32)
  return {context,id:[raw.slice(0,8),raw.slice(8,12),raw.slice(12,16),raw.slice(16,20),raw.slice(20)].join('-'),params:{kind:input.kind,id:input.id}}
 }
 async function read(input:TrashRestoreRequest){
  try{
   const reserve=keys(input,'reserve'),result=keys(input,'result')
   await core.operationWithTransaction(reserve.context,reserve.id,'agent.trash.restore.reserve',reserve.params,async()=>{throw absent})
   const saved=await core.operationWithTransaction(result.context,result.id,'agent.trash.restore.result',result.params,async()=>{throw absent})
   const value=saved.result as Record<string,unknown>
   return {kind:'completed' as const,successful:value.success===true,mutated:false,value}
  }catch{return {kind:'unknown' as const}}
 }
 return {reconcile:read,async apply(input){
  input.signal.throwIfAborted()
  const reserve=keys(input,'reserve')
  let reservation
  try{reservation=await core.operationWithTransaction(reserve.context,reserve.id,'agent.trash.restore.reserve',reserve.params,async()=>({reserved:true}),{signal:input.signal})}catch{return read(input)}
  if(reservation.replayed)return read(input)
  if(input.signal.aborted)return {kind:'unknown'}
  let value:Record<string,unknown>
  try{
   if(input.kind==='file'){await operations.restore(input.identity.ownerId,input.id);value={success:true,file_id:input.id}}
   else {
    const folder=await operations.restoreFolder!(input.identity.ownerId,input.id)
    if(!folder || typeof folder!=='object'||!('id' in folder)||!('name' in folder)||folder.id!==input.id||typeof folder.name!=='string')return {kind:'unknown'}
    value={success:true,folder_id:input.id,name:folder.name}
   }
  }catch(error){
   if(!(error instanceof CoreError))return {kind:'unknown'}
   if(error.code==='conflict'&&input.kind==='file'&&error.message==='所属文件夹仍在回收站，请先恢复文件夹')value={error:'所属文件夹仍在回收站，请先恢复文件夹'}
   else if(error.code==='not_found'||error.code==='invalid_request'&&input.id<1)value={error:input.kind==='file'?'文件不在回收站':'文件夹不在回收站'}
   else return {kind:'unknown'}
  }
  try{
   const result=keys(input,'result'),saved=await core.operationWithTransaction(result.context,result.id,'agent.trash.restore.result',result.params,async()=>value)
   const stored=saved.result as Record<string,unknown>
   return {kind:'completed',successful:stored.success===true,mutated:stored.success===true&&!saved.replayed,value:stored}
  }catch{return read(input)}
 }}
}
