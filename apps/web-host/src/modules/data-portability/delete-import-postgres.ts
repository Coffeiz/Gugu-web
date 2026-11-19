import {createDataImportDeleter,type DataImportDeleteStore} from '@gugu/core/data-portability/delete-import'
import {withPostgresTransaction} from '../../adapters/postgres-transaction.js'
import {removeLocalFile} from '@gugu/fs/node'
import type {Pool,PoolClient} from 'pg'

type Row={status:string;staging_key:string|null;rollback_key:string|null}
function query(client:PoolClient){
 return {
  async findOwnedForUpdate(ownerId:string,jobId:string){
   const result=await client.query<Row>('SELECT status,staging_key,rollback_key FROM data_import_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])
   const row=result.rows[0]
   return row?{status:row.status,stagingKey:row.staging_key,rollbackKey:row.rollback_key}:null
  },
  async deleteOwned(ownerId:string,jobId:string){
   const result=await client.query('DELETE FROM data_import_jobs WHERE user_id=$1 AND id=$2',[ownerId,jobId])
   if(result.rowCount!==1)throw new Error('导入任务删除状态已变化')
  },
 }
}

export function createLocalDataImportArtifactRemover(storageRoot:string){
 return async(ownerId:string,jobId:string,key:string)=>{
  const ownerHex=ownerId.replaceAll('-',''),jobHex=jobId.replaceAll('-','')
  const base=`${ownerHex}/.data-portability/imports/${jobHex}`
  if(key!==`${base}.gupi`&&key!==`${base}.rollback.gupi`)throw new Error('导入暂存路径无效')
  await removeLocalFile(storageRoot,key)
 }
}

export function createPostgresDataImportDeleter(pool:Pick<Pool,'connect'>,storageRoot:string){
 const store:DataImportDeleteStore={transaction:work=>withPostgresTransaction(pool,client=>work(query(client)))}
 return createDataImportDeleter(store,createLocalDataImportArtifactRemover(storageRoot))
}
