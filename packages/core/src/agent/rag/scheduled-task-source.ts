import { dataContext } from '../../contracts/index.js'
import type { createKyselyScheduledTaskRagReader } from '../../tasks/task-list.js'
import { buildSourceDocuments } from './index-builder.js'
import type { RagRebuildSource } from './rebuild-worker.js'

/** 定时任务事实读取由共享领域服务完成，不能从工具参数推导 owner。 */
export function createScheduledTaskRagSource(read:ReturnType<typeof createKyselyScheduledTaskRagReader>):RagRebuildSource {
 return async(rawOwner,sourceId,signal)=>{
  signal?.throwIfAborted()
  const owner=dataContext(rawOwner).ownerId
  if(sourceId!==null&&!/^[1-9]\d*$/u.test(sourceId))throw new Error('RAG 任务标识无效')
  const id=sourceId===null?null:Number(sourceId)
  if(id!==null&&!Number.isSafeInteger(id))throw new Error('RAG 任务标识无效')
  const tasks=await read(owner,id,signal)
  signal?.throwIfAborted()
  return buildSourceDocuments({scheduled_task:tasks.map(task=>({id:String(task.id),name:task.name,cron:task.cron,enabled:task.enabled,payload:task.payload||'',version_parts:[String(task.id),task.updated_at,task.cron,task.payload||''],scope:{scope_type:'owner',scope_id:''}}))})
 }
}
