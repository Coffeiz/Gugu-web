import {createDataExportDeleter,type DataExportDeleteStore} from '@gugu/core/data-portability/delete-export'
import {withPostgresTransaction} from '../../adapters/postgres-transaction.js'
import {removeLocalFile} from '@gugu/fs/node'
import type {Pool,PoolClient} from 'pg'
import path from 'node:path'

type Row={status:string;artifact_key:string|null}
function query(client:PoolClient){
  return {
    async findOwnedForUpdate(ownerId:string,jobId:string){
      const result=await client.query<Row>('SELECT status,artifact_key FROM data_export_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])
      const row=result.rows[0]
      return row?{status:row.status,artifactKey:row.artifact_key}:null
    },
    async deleteOwned(ownerId:string,jobId:string){
      const result=await client.query('DELETE FROM data_export_jobs WHERE user_id=$1 AND id=$2',[ownerId,jobId])
      if(result.rowCount!==1)throw new Error('导出任务删除状态已变化')
    },
  }
}

export function createPostgresDataExportDeleter(pool:Pick<Pool,'connect'>,storageRoot:string){
  const store:DataExportDeleteStore={transaction:work=>withPostgresTransaction(pool,client=>work(query(client)))}
  return createDataExportDeleter(store,async(ownerId,jobId,key)=>{
    const ownerHex=ownerId.replaceAll('-',''),jobHex=jobId.replaceAll('-','')
    const expected=`${ownerHex}/.data-portability/exports/${jobHex}.gupa`
    if(key!==expected)throw new Error('导出归档路径无效')
    await removeLocalFile(path.resolve(storageRoot),expected)
  })
}
