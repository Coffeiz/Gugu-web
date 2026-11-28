import { sql, Kysely, PostgresDialect, type PostgresPool } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import type { ProjectFileCountPort } from './project-read.js'

/** 借用 Host 连接池读取既有投影，不导入 pg，也不拥有池的关闭权。 */
export function createPostgresProjectFileCountReader(pool: PostgresPool): ProjectFileCountPort {
  return createKyselyProjectFileCountReader(new Kysely({ dialect: new PostgresDialect({ pool }) }), 'postgres')
}

async function read<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  try { return await work() }
  finally { signal?.throwIfAborted() }
}

/** 只读既有计数投影；不扫描files、不创建/刷新投影，也不拥有连接池生命周期。 */
export function createKyselyProjectFileCountReader<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres'): ProjectFileCountPort {
  const owner = (raw: string) => {
    const normalized = dataContext(raw).ownerId
    return backend === 'sqlite' ? normalized.replaceAll('-', '') : normalized
  }
  return {
    async forProjects(ownerId, projectIds, signal) {
      signal?.throwIfAborted()
      const normalizedOwner = owner(ownerId)
      if (!Array.isArray(projectIds) || projectIds.some(id => !Number.isSafeInteger(id)))
        throw new CoreError('invalid_request', '项目标识无效')
      const ids = [...projectIds]
      if (!ids.length) return new Map<number, number>()
      const result = await read(() => sql<{ project_id: number; file_count: number | string }>`
        SELECT counts.project_id, counts.file_count
        FROM project_file_counts AS counts
        JOIN projects ON projects.id = counts.project_id
        WHERE projects.user_id = ${normalizedOwner} AND counts.project_id IN (${sql.join(ids)})`.execute(db), signal)
      return new Map(result.rows.map(row => [Number(row.project_id), Number(row.file_count)]))
    },
    async list(ownerId, signal) {
      signal?.throwIfAborted()
      const normalizedOwner = owner(ownerId)
      const result = await read(() => sql<{ project_id: number; file_count: number | string }>`
        SELECT projects.id AS project_id, COALESCE(counts.file_count, 0) AS file_count
        FROM projects
        LEFT JOIN project_file_counts AS counts ON counts.project_id = projects.id
        WHERE projects.user_id = ${normalizedOwner}
        ORDER BY projects.id`.execute(db), signal)
      return result.rows.map(row => ({ projectId: Number(row.project_id), fileCount: Number(row.file_count) }))
    },
  }
}
