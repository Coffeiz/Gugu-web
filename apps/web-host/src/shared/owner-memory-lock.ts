import type { Database } from '@gugu/core/data'
import { sql, type Kysely, type Transaction } from 'kysely'

export async function lockOwnerMemory(tx: Transaction<Database>, ownerId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agent-owner-memory:' + ownerId}, 0))`.execute(tx)
}

/** 与数据导入确认和回滚入队串行化，返回计划需要复核的档案版本。 */
export async function lockOwnerMemoryArchive(tx: Transaction<Database>, ownerId: string) {
  const user = await sql`SELECT id FROM users WHERE id=${ownerId} FOR NO KEY UPDATE`.execute(tx)
  if (user.rows.length !== 1) return null
  const result = await sql<{ busy: boolean; revision: string | null }>`
    SELECT COALESCE(bool_or(status IN ('queued','running','applying','rolling_back','needs_recovery')), false) AS busy,
      extract(epoch FROM max(updated_at))::text AS revision FROM data_import_jobs
    WHERE user_id=${ownerId} AND mode IN ('incremental','replace','rollback')
  `.execute(tx)
  return result.rows[0]!
}

export function createOwnerMemoryLock(db: Kysely<Database>) {
  return <T>(ownerId: string, operation: () => Promise<T>) =>
    db.transaction().execute(async tx => {
      await lockOwnerMemory(tx, ownerId)
      return operation()
    })
}
