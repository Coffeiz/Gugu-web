import type { Pool } from 'pg'

/** 查询现存替换 Worker 状态；同一门禁由受保护用户 API 的认证 Hook 统一执行。 */
export function createPostgresDataReplacementWriteGate(pool: Pick<Pool, 'query'>) {
  return async (ownerId: string): Promise<boolean> => {
    const result = await pool.query<{ id: string }>(`SELECT id FROM data_import_jobs
      WHERE user_id=$1 AND status IN ('applying','rolling_back','needs_recovery') LIMIT 1`, [ownerId])
    return result.rows.length > 0
  }
}
