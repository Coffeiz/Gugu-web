import {CoreError,dataContext} from '../contracts/index.js'

export interface DataImportCancelRow {status:string;stagingKey:string|null}
export interface DataImportCancelTransaction {
 findOwnedForUpdate(ownerId:string,jobId:string):Promise<DataImportCancelRow|null>
 cancelQueued(ownerId:string,jobId:string):Promise<void>
}
export interface DataImportCancelStore {
 transaction<T>(work:(tx:DataImportCancelTransaction)=>Promise<T>):Promise<T>
}

/** 先在 owner 行锁内提交排队任务取消，再把暂存键交给 Host 做 best-effort 清理。 */
export function createDataImportCanceler(store:DataImportCancelStore){
 return async(rawOwner:string,rawJob:string):Promise<string|null>=>{
  const ownerId=dataContext(rawOwner).ownerId,jobId=dataContext(rawJob).ownerId
  return store.transaction(async tx=>{
   const row=await tx.findOwnedForUpdate(ownerId,jobId)
   if(!row)throw new CoreError('not_found','找不到此导入任务')
   if(row.status!=='queued')throw new CoreError('conflict','此导入任务当前不能取消')
   await tx.cancelQueued(ownerId,jobId)
   return row.stagingKey
  })
 }
}
