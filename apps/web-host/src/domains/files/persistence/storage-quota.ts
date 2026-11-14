import { CoreError } from '@gugu/core'
import type { PoolClient } from 'pg'

const FILE_LIBRARY = 'file_library'
const UNLIMITED_BYTES = '9223372036854775807'

/** 初始化新注册用户的文件库账本，账本与引导文件写入处于同一 PostgreSQL 事务。 */
export async function ensureRegistrationFileLibraryQuota(
  client: PoolClient,
  userId: string,
  defaultLimitBytes: number | null,
): Promise<void> {
  const user = await client.query<{ storage_limit_bytes: string | number | null }>(
    'SELECT storage_limit_bytes FROM users WHERE id=$1', [userId],
  )
  if (!user.rowCount) throw new CoreError('not_found', '用户不存在')

  const userLimit = user.rows[0]!.storage_limit_bytes
  const configuredLimit = userLimit === null ? defaultLimitBytes : userLimit
  const configuredLimitText = configuredLimit === null ? null : String(configuredLimit)
  const limitBytes = configuredLimitText === null || configuredLimitText === '-1'
    ? UNLIMITED_BYTES
    : configuredLimitText

  await client.query(
    `INSERT INTO storage_quota_ledgers
       (user_id,category,root_path,limit_bytes,used_bytes,reserved_bytes,status,
        initialized_at,last_reconciled_at,updated_at)
     VALUES ($1,$2,NULL,$3,0,0,'active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     ON CONFLICT (user_id,category) DO NOTHING`,
    [userId, FILE_LIBRARY, limitBytes],
  )
  await client.query(
    `INSERT INTO storage_quota_events
       (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
     VALUES ($1,$2,'initialize',0,'quota',$2,$3,'{"root_path":null}'::json,CURRENT_TIMESTAMP)
     ON CONFLICT (user_id,idempotency_key) DO NOTHING`,
    [userId, FILE_LIBRARY, `quota-init:${userId}:${FILE_LIBRARY}`],
  )
}

export type FileQuotaOperation = 'file_upload' | 'file_copy' | 'file_copy_overwrite' | 'onboarding_seed'

/** 在当前文件事务中更新配额账本与事件，调用方提供操作语义和幂等键。 */
export async function updateFileStorageQuota(
  client: PoolClient,
  userId: string,
  fileId: number,
  delta: number,
  operation: FileQuotaOperation,
  idempotencyKey: string,
): Promise<void> {
  const result = await client.query<{
    used_bytes: string | number
    reserved_bytes: string | number
    limit_bytes: string | number
  }>(
    `SELECT used_bytes,reserved_bytes,limit_bytes FROM storage_quota_ledgers
     WHERE user_id=$1 AND category=$2 AND status='active' FOR UPDATE`,
    [userId, FILE_LIBRARY],
  )
  const ledger = result.rows[0]
  if (!ledger) throw new CoreError('busy', '存储配额账本尚未就绪，请稍后重试')

  const usedBytes = Number(ledger.used_bytes) + delta
  if (usedBytes < 0
    || (Number(ledger.limit_bytes) < Number.MAX_SAFE_INTEGER
      && usedBytes + Number(ledger.reserved_bytes) > Number(ledger.limit_bytes))) {
    throw new CoreError('conflict', '存储空间已满，无法上传')
  }

  await client.query(
    `UPDATE storage_quota_ledgers SET used_bytes=$3,updated_at=CURRENT_TIMESTAMP
     WHERE user_id=$1 AND category=$2`,
    [userId, FILE_LIBRARY, usedBytes],
  )
  await client.query(
    `INSERT INTO storage_quota_events
       (user_id,category,operation,delta_bytes,resource_type,resource_id,idempotency_key,metadata_json,created_at)
     VALUES ($1,$2,$3,$4,'file',$5,$6,NULL,CURRENT_TIMESTAMP)`,
    [userId, FILE_LIBRARY, operation, delta, String(fileId), idempotencyKey],
  )
}
