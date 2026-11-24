import { normalizeOnboardingState } from '@gugu/core/onboarding'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { withPostgresTransaction } from '../../adapters/database/postgres-transaction.js'
import { enqueuePostgresAgentRagRebuild } from '../agent/rag/jobs.js'
import { normalizeFileOwnerId, isOwnedFileStorageKey } from '../files/store.js'
import { removeLocalFile } from '../files/storage/removal.js'

interface SeedStateRow extends QueryResultRow { state: unknown }
interface SeedFileRow extends QueryResultRow {
  path: string
  size_bytes: number | string
  deleted_at: Date | string | null
}

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value
}

async function lockedState(client: PoolClient, ownerId: string): Promise<Record<string, unknown>> {
  const empty = JSON.stringify(normalizeOnboardingState({}))
  await client.query(`INSERT INTO onboarding_state (user_id,state,created_at,updated_at)
    VALUES ($1,$2::json,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (user_id) DO NOTHING`, [ownerId, empty])
  const result = await client.query<SeedStateRow>('SELECT state FROM onboarding_state WHERE user_id=$1 FOR UPDATE', [ownerId])
  return normalizeOnboardingState(jsonValue(result.rows[0]?.state))
}

/** PostgreSQL 事务只删除 owner 的播种项目/文件；物理清理由 Core 用例按返回键逐个完成。 */
export function createPostgresOnboardingReseedOperations(pool: Pick<Pool, 'connect' | 'query'>, storageRoot: string) {
  return {
    async removeSeedProject(rawOwnerId: string, projectId: number): Promise<readonly string[]> {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      if (!Number.isSafeInteger(projectId) || projectId < 1) throw new TypeError('引导项目标识无效')
      return withPostgresTransaction(pool, async client => {
        const files = await client.query<SeedFileRow>(`SELECT path,size_bytes,deleted_at FROM files
          WHERE user_id=$1 AND project_id=$2 FOR UPDATE`, [ownerId, projectId])
        for (const file of files.rows) {
          if (!isOwnedFileStorageKey(ownerId, file.path)) throw new Error('引导文件存储归属无效')
        }
        await client.query('DELETE FROM files WHERE user_id=$1 AND project_id=$2', [ownerId, projectId])
        const deleted = await client.query('DELETE FROM projects WHERE id=$1 AND user_id=$2', [projectId, ownerId])
        if (deleted.rowCount) {
          await enqueuePostgresAgentRagRebuild(client, ownerId, 'calendar')
          await enqueuePostgresAgentRagRebuild(client, ownerId, 'project')
        }

        return files.rows.map(file => file.path)
      })
    },
    async removeStorage(ownerId: string, storageKey: string): Promise<void> {
      await removeLocalFile(storageRoot, ownerId, storageKey)
    },
    resetSeed(rawOwnerId: string): Promise<void> {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      return withPostgresTransaction(pool, async client => {
        const state = await lockedState(client, ownerId)
        const seed = state.seed && typeof state.seed === 'object' && !Array.isArray(state.seed)
          ? state.seed as Record<string, unknown> : {}
        const next = JSON.stringify(normalizeOnboardingState({
          ...state,
          seed: { ...seed, seeded: false, project_id: null, project_name: null },
        }))
        await client.query('UPDATE onboarding_state SET state=$2::json,updated_at=CURRENT_TIMESTAMP WHERE user_id=$1', [ownerId, next])
      })
    },
    async locale(rawOwnerId: string): Promise<string | null> {
      const ownerId = normalizeFileOwnerId(rawOwnerId)
      const result = await pool.query<{ data_json: string | null }>('SELECT data_json FROM user_preferences WHERE user_id=$1', [ownerId])
      if (!result.rows[0]?.data_json) return null
      const value = jsonValue(result.rows[0].data_json)
      return value && typeof value === 'object' && !Array.isArray(value)
        && typeof (value as Record<string, unknown>).locale === 'string'
        ? (value as Record<string, string>).locale : null
    },
  }
}
