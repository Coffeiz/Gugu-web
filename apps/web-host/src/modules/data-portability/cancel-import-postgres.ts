import {createDataImportCanceler,type DataImportCancelStore} from '@gugu/core/data-portability/cancel-import'
import {withPostgresTransaction} from '../../adapters/postgres-transaction.js'
import {removeLocalFile} from '@gugu/fs/node'
import type {Pool,PoolClient} from 'pg'

type Row={status:string;staging_key:string|null}
function query(client:PoolClient){
 return {
  async findOwnedForUpdate(ownerId:string,jobId:string){
   const result=await client.query<Row>('SELECT status,staging_key FROM data_import_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])
   const row=result.rows[0]
   return row?{status:row.status,stagingKey:row.staging_key}:null
  },
  async cancelQueued(ownerId:string,jobId:string){
   const result=await client.query(`UPDATE data_import_jobs SET status='canceled',stage='canceled',import_token_hash=NULL,
     finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND id=$2 AND status='queued'`,[ownerId,jobId])
   if(result.rowCount!==1)throw new Error('导入任务取消状态已变化')
  },
 }
}

export function createPostgresDataImportCanceler(pool:Pick<Pool,'connect'>){
 const store:DataImportCancelStore={transaction:work=>withPostgresTransaction(pool,client=>work(query(client)))}
 return createDataImportCanceler(store)
}

export function createLocalDataImportStagingRemover(storageRoot:string){
 return async(ownerId:string,jobId:string,key:string)=>{
  const expected=`${ownerId.replaceAll('-','')}/.data-portability/imports/${jobId.replaceAll('-','')}.gupi`
  if(key!==expected)throw new Error('导入暂存路径无效')
  await removeLocalFile(storageRoot,key)
 }
}
