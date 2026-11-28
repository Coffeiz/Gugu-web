import {CoreError,dataContext} from '../contracts/index.js'

export interface DataImportDeleteRow {status:string;stagingKey:string|null;rollbackKey:string|null}
export interface DataImportDeleteTransaction {
 findOwnedForUpdate(ownerId:string,jobId:string):Promise<DataImportDeleteRow|null>
 deleteOwned(ownerId:string,jobId:string):Promise<void>
}
export interface DataImportDeleteStore {
 transaction<T>(work:(tx:DataImportDeleteTransaction)=>Promise<T>):Promise<T>
}

/** 删除可安全丢弃的导入任务；暂存及回滚文件成功清除前保留数据库行。 */
export function createDataImportDeleter(store:DataImportDeleteStore,removeArtifact:(ownerId:string,jobId:string,key:string)=>Promise<void>){
 return async(rawOwner:string,rawJob:string):Promise<void>=>{
  const ownerId=dataContext(rawOwner).ownerId,jobId=dataContext(rawJob).ownerId
  await store.transaction(async tx=>{
   const row=await tx.findOwnedForUpdate(ownerId,jobId)
   if(!row)throw new CoreError('not_found','找不到此导入任务')
   if(!['preview_ready','failed','canceled','expired'].includes(row.status))throw new CoreError('conflict','此导入任务当前不能删除')
   for(const key of new Set([row.stagingKey,row.rollbackKey].filter((value):value is string=>Boolean(value)))){
    try{await removeArtifact(ownerId,jobId,key)}catch{throw new CoreError('storage_error','导入暂存数据暂时无法删除，请稍后重试')}
   }
   await tx.deleteOwned(ownerId,jobId)
  })
 }
}
