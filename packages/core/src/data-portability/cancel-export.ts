import {CoreError,dataContext} from '../contracts/index.js'
import {createPortabilityJobReader,type PortabilityJobQuery} from './read-jobs.js'
export type PortabilityJobTransaction=<T>(work:(query:PortabilityJobQuery)=>Promise<T>)=>Promise<T>

/** 取消请求与Worker共享行锁；queued立即取消，running只请求进入canceling。 */
export function createDataExportCanceler(transaction:PortabilityJobTransaction,query:PortabilityJobQuery,now:()=>Date=()=>new Date()){
 const read=createPortabilityJobReader(query)
 return async(owner:string,job:string)=>{
  const ownerId=dataContext(owner).ownerId,jobId=dataContext(job).ownerId
  await transaction(async tx=>{
   const row=(await tx('SELECT status FROM data_export_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])).rows[0]
   if(!row)throw new CoreError('not_found','找不到此导出任务')
   const timestamp=now().toISOString()
   if(row.status==='queued')await tx("UPDATE data_export_jobs SET status='canceled',stage='canceled',finished_at=$3,updated_at=$3 WHERE user_id=$1 AND id=$2",[ownerId,jobId,timestamp])
   else if(row.status==='running')await tx("UPDATE data_export_jobs SET status='canceling',stage='canceling',updated_at=$3 WHERE user_id=$1 AND id=$2",[ownerId,jobId,timestamp])
   else throw new CoreError('conflict','此任务当前不能取消')
  })
  try{return await read.getExport(ownerId,jobId)}catch(error){
   if(error instanceof CoreError&&error.code==='not_found')throw new CoreError('storage_error','取消已提交，但任务状态刷新失败')
   throw error
  }
 }
}
