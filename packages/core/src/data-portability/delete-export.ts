import {CoreError,dataContext} from '../contracts/index.js'

export interface DataExportDeleteRow {status:string;artifactKey:string|null}
export interface DataExportDeleteTransaction {
  findOwnedForUpdate(ownerId:string,jobId:string):Promise<DataExportDeleteRow|null>
  deleteOwned(ownerId:string,jobId:string):Promise<void>
}
export interface DataExportDeleteStore {
  transaction<T>(work:(tx:DataExportDeleteTransaction)=>Promise<T>):Promise<T>
}

/** Lock the owner-scoped job while its private artifact is removed and the row is deleted. */
export function createDataExportDeleter(store:DataExportDeleteStore,removeArtifact:(ownerId:string,jobId:string,key:string)=>Promise<void>){
  return async(rawOwner:string,rawJob:string):Promise<void>=>{
    const ownerId=dataContext(rawOwner).ownerId,jobId=dataContext(rawJob).ownerId
    await store.transaction(async tx=>{
      const row=await tx.findOwnedForUpdate(ownerId,jobId)
      if(!row)throw new CoreError('not_found','找不到此导出任务')
      if(['queued','running','canceling'].includes(row.status))throw new CoreError('conflict','请先取消仍在运行的导出任务')
      if(row.artifactKey!==null){
        try{await removeArtifact(ownerId,jobId,row.artifactKey)}
        catch{throw new CoreError('storage_error','导出归档暂时无法删除，请稍后重试')}
      }
      await tx.deleteOwned(ownerId,jobId)
    })
  }
}
