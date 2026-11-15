import { asciiDecimalDigits } from '../shared/unicode-decimal.js'

const fields = ['token_limit_6h', 'token_limit_weekly', 'storage_limit_bytes', 'search_limit_daily'] as const
type QuotaField = typeof fields[number]
export type QuotaPatch = Partial<Record<QuotaField, number | null>>
function failure(statusCode: number, message: string): Error & {statusCode: number} {
  return Object.assign(new Error(message), {statusCode})
}
/** 保持Python int转换（含Unicode十进制和下划线），不接受JS空串/数组数值转换。 */
function quotaInteger(value: unknown): number {
  if (typeof value === 'boolean') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const normalized = asciiDecimalDigits(value.trim())
    if (/^[+-]?[0-9](?:_?[0-9])*$/.test(normalized)) return Number(normalized.replaceAll('_', ''))
  }
  throw failure(422, '配额必须是整数或 null')
}
export function parseQuotaPatch(body: Record<string, unknown>): QuotaPatch {
  const patch: QuotaPatch = {}
  for (const field of fields) {
    if (!Object.hasOwn(body, field)) continue
    if (body[field] === null) { patch[field] = null; continue }
    const value = quotaInteger(body[field])
    if (value < (field === 'search_limit_daily' ? 0 : -1)) throw failure(422, '配额值无效')
    patch[field] = value
  }
  return patch
}
export interface AdminSettingsQuery {
  (sql: string, values: unknown[]): Promise<{rows: Record<string, unknown>[]}>
}
export type AdminSettingsTransaction = <T>(work: (query: AdminSettingsQuery) => Promise<T>) => Promise<T>
/** 用户查找先于请求字段校验；整组更新失败时不遗留部分配额修改。 */
export async function updateAdminUserSettings(transaction: AdminSettingsTransaction, id: string, change: {kind:'quota'; body:Record<string,unknown>} | {kind:'developer'}) {
  return transaction(async query => {
    const current = (await query('SELECT id, username FROM users WHERE id = $1::uuid FOR UPDATE', [id])).rows[0]
    if (!current) throw failure(404, '用户不存在')
    if (change.kind === 'developer') {
      const row = (await query('UPDATE users SET is_developer = NOT is_developer WHERE id = $1::uuid RETURNING is_developer', [id])).rows[0]!
      return {response:{id, is_developer:Boolean(row.is_developer)}, description:`${row.is_developer ? '标记开发者' : '取消开发者标记'} ${current.username}`}
    }
    const patch = parseQuotaPatch(change.body), keys = Object.keys(patch) as QuotaField[]
    if (keys.length) await query(`UPDATE users SET ${keys.map((key,index)=>`${key} = $${index+2}`).join(', ')} WHERE id = $1::uuid`, [id, ...keys.map(key=>patch[key])])
    const row = (await query(`SELECT ${fields.join(', ')} FROM users WHERE id = $1::uuid`, [id])).rows[0]!
    const quotas = Object.fromEntries(fields.map(field => [field, row[field] === null ? null : Number(row[field])]))
    return {response:{id, ...quotas}, description:`更新用户 ${current.username} 配额`}
  })
}
