import { utc } from '../data/codec.js'

export interface SystemLogRow {
  id: number
  level: string
  module: string
  message: string
  traceback: string | null
  created_at: string
}
export type SystemLogQuery = (text: string, params: unknown[]) => Promise<{ rows: SystemLogRow[] }>

/** 服务端运维日志查询；只有 Host 可信管理员入口可以装配。 */
export function createSystemLogReader(query: SystemLogQuery) {
  return {
    async list(limit = 200, level: string | null = null): Promise<{ items: SystemLogRow[] }> {
      const filter = level ? ' WHERE level=$2' : ''
      const result = await query(`SELECT id,level,module,message,traceback,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00:00' AS created_at
        FROM system_logs${filter} ORDER BY created_at DESC LIMIT $1`, level ? [limit, level.toUpperCase()] : [limit])
      return { items: result.rows.map(row => ({ ...row, id: Number(row.id), created_at: utc(row.created_at).replace(' ', 'T') })) }
    },
  }
}
