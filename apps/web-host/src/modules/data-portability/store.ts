import { createDataImportCanceler, type DataImportCancelStore } from '@gugu/core/data-portability/cancel-import'
import { withPostgresTransaction } from '../../adapters/database/postgres-transaction.js'
import type { Pool, PoolClient } from 'pg'
import { createDataImportDeleter, type DataImportDeleteStore } from '@gugu/core/data-portability/delete-import'
import { createDataExportDeleter, type DataExportDeleteStore } from '@gugu/core/data-portability/delete-export'
import { CoreError } from '@gugu/core'
import type { DataImportPreflightStore } from '@gugu/core/data-portability/preflight-import'
import { createLocalDataExportArtifactRemover, createLocalDataImportArtifactRemover } from './archive.js'

type ImportCancelRow={status:string;staging_key:string|null}

function queryImportCancel(client:PoolClient){
 return {
  async findOwnedForUpdate(ownerId:string,jobId:string){
   const result=await client.query<ImportCancelRow>('SELECT status,staging_key FROM data_import_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])
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
 const store:DataImportCancelStore={transaction:work=>withPostgresTransaction(pool,client=>work(queryImportCancel(client)))}
 return createDataImportCanceler(store)
}

type ImportDeleteRow={status:string;staging_key:string|null;rollback_key:string|null}

function queryImportDelete(client:PoolClient){
 return {
  async findOwnedForUpdate(ownerId:string,jobId:string){
   const result=await client.query<ImportDeleteRow>('SELECT status,staging_key,rollback_key FROM data_import_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])
   const row=result.rows[0]
   return row?{status:row.status,stagingKey:row.staging_key,rollbackKey:row.rollback_key}:null
  },
  async deleteOwned(ownerId:string,jobId:string){
   const result=await client.query('DELETE FROM data_import_jobs WHERE user_id=$1 AND id=$2',[ownerId,jobId])
   if(result.rowCount!==1)throw new Error('导入任务删除状态已变化')
  },
 }
}

export function createPostgresDataImportDeleter(pool:Pick<Pool,'connect'>,storageRoot:string){
 const store:DataImportDeleteStore={transaction:work=>withPostgresTransaction(pool,client=>work(queryImportDelete(client)))}
 return createDataImportDeleter(store,createLocalDataImportArtifactRemover(storageRoot))
}

type ExportDeleteRow={status:string;artifact_key:string|null}

function queryExportDelete(client:PoolClient){
  return {
    async findOwnedForUpdate(ownerId:string,jobId:string){
      const result=await client.query<ExportDeleteRow>('SELECT status,artifact_key FROM data_export_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])
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
  const store:DataExportDeleteStore={transaction:work=>withPostgresTransaction(pool,client=>work(queryExportDelete(client)))}
  return createDataExportDeleter(store, createLocalDataExportArtifactRemover(storageRoot))
}

export function createPostgresDataImportPreflightStore(pool: Pick<Pool, 'connect'>): DataImportPreflightStore {
  return {
    async begin(ownerId, jobId, tokenHash, expiresAt) {
      await withPostgresTransaction(pool, async (client: PoolClient) => {
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerId])
        const active = await client.query(`
          SELECT id FROM data_export_jobs WHERE user_id=$1 AND status IN ('queued','running','canceling')
          UNION ALL
          SELECT id FROM data_import_jobs WHERE user_id=$1 AND status IN ('uploading','queued','running','applying','rolling_back','needs_recovery')
          LIMIT 1`, [ownerId])
        if (active.rowCount) throw new CoreError('conflict', '已有数据迁移任务正在处理')
        await client.query(`INSERT INTO data_import_jobs(id,user_id,mode,status,stage,progress_current,import_token_hash,expires_at,created_at,updated_at)
          VALUES($1,$2,'preflight','uploading','uploading',0,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [jobId, ownerId, tokenHash, expiresAt])
      })
    },
    async finish(ownerId, jobId, digest, key) {
      return withPostgresTransaction(pool, async (client: PoolClient) => {
        const locked = await client.query<{ expired: boolean }>(`SELECT expires_at<=CURRENT_TIMESTAMP AS expired FROM data_import_jobs
          WHERE id=$1 AND user_id=$2 AND status='uploading' FOR UPDATE`, [jobId, ownerId])
        const row = locked.rows[0]
        if (!row) return 'missing'
        if (row.expired) {
          await client.query(`UPDATE data_import_jobs SET status='expired',stage='expired',import_token_hash=NULL,
            finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2 AND status='uploading'`, [jobId, ownerId])
          return 'expired'
        }
        await client.query(`UPDATE data_import_jobs SET archive_sha256=$3,staging_key=$4,status='queued',stage='queued',updated_at=CURRENT_TIMESTAMP
          WHERE id=$1 AND user_id=$2 AND status='uploading'`, [jobId, ownerId, digest, key])
        return 'queued'
      })
    },
    async fail(ownerId, jobId, orphanedStagingKey) {
      await withPostgresTransaction(pool, async (client: PoolClient) => {
        await client.query(`UPDATE data_import_jobs SET status='failed',stage='failed',error_code='upload_failed',
          import_token_hash=NULL,staging_key=COALESCE($3,staging_key),finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
          WHERE id=$1 AND user_id=$2 AND status='uploading'`, [jobId, ownerId, orphanedStagingKey])
        if (orphanedStagingKey) {
          // finish() may already have changed uploading→expired; keep the canonical key visible to the expiry sweeper.
          await client.query(`UPDATE data_import_jobs SET staging_key=COALESCE(staging_key,$3),updated_at=CURRENT_TIMESTAMP
            WHERE id=$1 AND user_id=$2 AND status='expired'`, [jobId, ownerId, orphanedStagingKey])
        }
      })
    },
  }
}
