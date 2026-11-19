import { CoreError } from '@gugu/core'
import type { DataImportPreflightStore, DataImportPreflightStorage } from '@gugu/core/data-portability/preflight-import'
import { withPostgresTransaction } from '../../adapters/postgres-transaction.js'
import { writeLocalFileStream, removeLocalFile } from '@gugu/fs/node'
import type { Pool, PoolClient } from 'pg'

function assertStorageKey(key: string): void {
  if (!/^[0-9a-f]{32}\/\.data-portability\/imports\/[0-9a-f]{32}\.gupi$/u.test(key))
    throw new Error('导入暂存路径无效')
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

export function createLocalDataImportPreflightStorage(storageRoot: string): DataImportPreflightStorage {
  return {
    async put(key, content) {
      assertStorageKey(key)
      await writeLocalFileStream(storageRoot, key, content, new AbortController().signal)
    },
    async remove(key) {
      assertStorageKey(key)
      await removeLocalFile(storageRoot, key)
    },
  }
}
