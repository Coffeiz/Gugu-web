import {sql,type Kysely} from 'kysely'
import {CoreError} from '../contracts/index.js'
import {createFileSyncRunReader} from './read-runs.js'

export interface FileSyncRunInvalidation {runId:string;bindingId:number;revision:number}
/** 管理员取消请求与实际Worker共享行锁；不扫描或删除文件。 */
export function createFileSyncRunCancellation<DB>(db:Kysely<DB>,publish:(event:FileSyncRunInvalidation)=>Promise<unknown>){
 return async(runId:string)=>{
  const snapshot=await db.transaction().execute(async tx=>{
   const row=(await sql<{status:string}>`SELECT status FROM file_sync_reconcile_runs WHERE id=${runId} FOR UPDATE`.execute(tx)).rows[0]
   if(!row)throw new CoreError('not_found','对账任务不存在')
   if(row.status==='queued')await sql`UPDATE file_sync_reconcile_runs SET status='cancelled',stage='cancelled',finished_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=${runId}`.execute(tx)
   else if(row.status==='running')await sql`UPDATE file_sync_reconcile_runs SET status='cancelling',cancel_requested=true,revision=revision+1,updated_at=clock_timestamp() WHERE id=${runId}`.execute(tx)
   // 与Python返回同次事务快照；提交后Worker即使已收尾，也不改本次取消响应。
   return createFileSyncRunReader(tx).get(runId)
  })
  try{await publish({runId:snapshot.id,bindingId:snapshot.bindingId,revision:snapshot.revision})}catch{/* 与Python一致，提交后失效通知失败不回滚已持久化的取消请求。 */}
  return snapshot
 }
}
