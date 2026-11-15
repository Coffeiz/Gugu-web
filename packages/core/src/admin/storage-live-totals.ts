export interface StorageTotalsRow { object_count: string | number; total_bytes: string | number }
export type StorageTotalsQuery = (text: string, params: unknown[]) => Promise<{ rows: StorageTotalsRow[] }>

/** 实时数据库占用；包含回收站文件，不依赖历史快照或文件系统扫描。 */
export function createStorageLiveTotals(query: StorageTotalsQuery) {
  return async () => {
    const categories: Record<string, { object_count: number; total_bytes: number }> = {}
    for (const [state, category] of [['draft','chat_staging_draft'],['attached','chat_staging_attached']] as const) {
      const result = await query('SELECT COUNT(id) AS object_count, COALESCE(SUM(size),0) AS total_bytes FROM chat_attachments WHERE state=$1', [state])
      const row = result.rows[0]!
      categories[category] = { object_count: Number(row.object_count), total_bytes: Number(row.total_bytes) }
    }
    const files = await query('SELECT COUNT(id) AS object_count, COALESCE(SUM(size_bytes),0) AS total_bytes FROM files', [])
    const row = files.rows[0]!
    categories.user_files = { object_count: Number(row.object_count), total_bytes: Number(row.total_bytes) }
    return { categories }
  }
}
