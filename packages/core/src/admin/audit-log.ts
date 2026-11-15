import { utc } from '../shared/timestamps.js'

export type AdminAuditLogQuery = (sql: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

/** Web 管理员审计读取。调用方须先验证管理员身份；不向 DTO 透传存储扩展字段。 */
export function createAdminAuditLogReader(query: AdminAuditLogQuery) {
  return async (limit = 200) => {
    const { rows } = await query(
      'SELECT id, username, action, description, ip, created_at::text AS created_at FROM audit_logs ORDER BY created_at DESC LIMIT $1',
      [limit],
    )
    return { items: rows.map(row => ({
      id: row.id, username: row.username, action: row.action,
      description: row.description, ip: row.ip,
      created_at: utc(row.created_at).replace(' ', 'T'),
    })) }
  }
}
