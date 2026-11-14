import { CoreError } from '@gugu/core'
import type { PoolClient } from 'pg'

const FILE_LIBRARY = 'file_library'

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
