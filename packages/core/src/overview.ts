import { sql, type Kysely } from 'kysely'
import { dataContext } from './contracts/index.js'
import { integer } from './data/codec.js'

export interface DashboardCounts { pending: number; active: number; done: number; upcoming_events: number; files: number; clients: number }
export interface DashboardCountPort { count(ownerId: string, today: string, signal?: AbortSignal): Promise<DashboardCounts> }

/** 完整owner聚合；不采用文件库根层统计或上下文限额，不写库、不清理资源。 */
export function createKyselyDashboardCounter<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres'): DashboardCountPort {
  return { async count(rawOwner, today, signal) {
    signal?.throwIfAborted()
    const normalized = dataContext(rawOwner).ownerId, owner = backend === 'sqlite' ? normalized.replaceAll('-', '') : normalized
    const archived = backend === 'sqlite' ? 0 : false
    try {
      const result = await sql<Record<keyof DashboardCounts, number | string>>`SELECT
        (SELECT count(*) FROM projects WHERE user_id=${owner} AND deleted_at IS NULL AND archived=${archived} AND status='pending') AS pending,
        (SELECT count(*) FROM projects WHERE user_id=${owner} AND deleted_at IS NULL AND archived=${archived} AND status='active') AS active,
        (SELECT count(*) FROM projects WHERE user_id=${owner} AND deleted_at IS NULL AND archived=${archived} AND status='done') AS done,
        (SELECT count(*) FROM calendar_events WHERE user_id=${owner} AND deleted_at IS NULL AND date>=${today}) AS upcoming_events,
        (SELECT count(*) FROM files WHERE user_id=${owner} AND deleted_at IS NULL) AS files,
        (SELECT count(*) FROM clients WHERE user_id=${owner}) AS clients`.execute(db)
      const row = result.rows[0]
      if (!row) throw new Error('统计查询没有返回记录')
      return { pending: integer(row.pending), active: integer(row.active), done: integer(row.done),
        upcoming_events: integer(row.upcoming_events), files: integer(row.files), clients: integer(row.clients) }
    } finally { signal?.throwIfAborted() }
  } }
}
