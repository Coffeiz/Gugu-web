import { utc } from '@gugu/core/shared/timestamps'
import { sql, type Kysely } from 'kysely'

type TimeValue = Date | string | null
function isoTime(value: TimeValue): string | null {
  if (value === null) return null
  return utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')
}

function numeric(value: unknown): number {
  return Number(value ?? 0)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function mondayUtc(now: Date): Date {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date
}

function sixHourWindowUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(now.getUTCHours() / 6) * 6))
}

/** 管理员用户列表的查询与 Python 投影规则。 */
export function createAdminUserListReader(db: Kysely<any>, now: () => Date = () => new Date()) {
  return async (search?: string) => {
    const users = await db.selectFrom('users').select([
      'id', 'username', 'email', 'display_name', 'is_active', 'account_status', 'suspended_until',
      'is_developer', 'created_at', 'token_limit_6h', 'token_limit_weekly', 'storage_limit_bytes', 'search_limit_daily',
    ]).orderBy('created_at', 'desc').execute()
    const current = now()
    const [weekRows, sixHourRows, fileRows, libraryRows] = await Promise.all([
      db.selectFrom('agent_usage').select(['user_id', sql<number>`sum(tokens_in + tokens_out)`.as('tokens')])
        .where('created_at', '>=', mondayUtc(current).toISOString()).where(sql<boolean>`is_byok is false`).groupBy('user_id').execute(),
      db.selectFrom('agent_usage').select(['user_id', sql<number>`sum(tokens_in + tokens_out)`.as('tokens')])
        .where('created_at', '>=', sixHourWindowUtc(current).toISOString()).where(sql<boolean>`is_byok is false`).groupBy('user_id').execute(),
      db.selectFrom('files').select(['user_id', db.fn.sum<number>('size_bytes').as('storage_used')])
        .groupBy('user_id').execute(),
      db.selectFrom('storage_quota_ledgers').select(['user_id', 'used_bytes as storage_used'])
        .where('category', '=', 'file_library').execute(),
    ])
    const tokenMap = (rows: Array<{ user_id: string; tokens: unknown }>) => new Map(rows.map(row => [String(row.user_id), numeric(row.tokens)]))
    const week = tokenMap(weekRows)
    const sixHour = tokenMap(sixHourRows)
    const storage = new Map(fileRows.map(row => [String(row.user_id), numeric(row.storage_used)]))
    for (const row of libraryRows) storage.set(String(row.user_id), numeric(row.storage_used))
    const needle = search ? search.toLowerCase() : null
    const visible = needle
      ? users.filter(user => String(user.username ?? '').toLowerCase().includes(needle)
        || String(user.email ?? '').toLowerCase().includes(needle))
      : users
    const items = visible.map(user => {
      const id = String(user.id)
      return {
        id, username: user.username, email: user.email, display_name: user.display_name,
        is_active: Boolean(user.is_active), account_status: user.account_status ?? 'active',
        suspended_until: isoTime(user.suspended_until as TimeValue), is_developer: Boolean(user.is_developer ?? false),
        created_at: isoTime(user.created_at as TimeValue), tokens_week: week.get(id) ?? 0,
        tokens_6h: sixHour.get(id) ?? 0, storage_used: storage.get(id) ?? 0,
        token_limit_6h: nullableNumber(user.token_limit_6h), token_limit_weekly: nullableNumber(user.token_limit_weekly),
        storage_limit_bytes: nullableNumber(user.storage_limit_bytes), search_limit_daily: nullableNumber(user.search_limit_daily),
      }
    })
    return { items, total: items.length }
  }
}

/** 风险用户可见窗口与五分钟处置阈值分开计算；被冻结账号即使没有近期事件也保留。 */
export function createAdminUserRiskReader(db: Kysely<any>, now: () => Date = () => new Date()) {
  return async (windowMinutes = 1_440) => {
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 30 * 24 * 60)
      throw new RangeError('风险用户展示窗口无效')
    const current = now()
    const visibleCutoff = new Date(current.getTime() - windowMinutes * 60_000)
    const policyCutoff = new Date(current.getTime() - 5 * 60_000)
    const [visibleEvents, recentEvents] = await Promise.all([
      db.selectFrom('security_events').select([
        'user_id', sql<number>`count(id)`.as('event_count'), sql<TimeValue>`max(occurred_at)`.as('last_event_at'),
      ]).where('occurred_at', '>=', visibleCutoff.toISOString()).groupBy('user_id').execute(),
      db.selectFrom('security_events').select(['user_id', sql<number>`count(id)`.as('event_count')])
        .where('occurred_at', '>=', policyCutoff.toISOString()).groupBy('user_id').execute(),
    ])
    const visibleByUser = new Map(visibleEvents.map(row => [String(row.user_id), row]))
    const recentByUser = new Map(recentEvents.map(row => [String(row.user_id), numeric(row.event_count)]))
    const users = await db.selectFrom('users').select([
      'id', 'username', 'email', 'display_name', 'account_status', 'is_active', 'suspended_until',
      'suspended_reason', 'security_version', 'created_at', 'updated_at',
    ]).where(eb => eb.or([
      eb('account_status', '<>', 'active'),
      eb('id', 'in', [...visibleByUser.keys()]),
    ])).orderBy('updated_at', 'desc').execute()
    const items = users.map(user => {
      const id = String(user.id)
      const event = visibleByUser.get(id)
      const recentCount = recentByUser.get(id) ?? 0
      return {
        id, username: user.username, email: user.email, display_name: user.display_name,
        account_status: user.account_status ?? 'active', is_active: Boolean(user.is_active),
        suspended_until: isoTime(user.suspended_until as TimeValue), suspended_reason: user.suspended_reason,
        security_version: numeric(user.security_version), recent_event_count: recentCount,
        visible_event_count: numeric(event?.event_count), last_event_at: isoTime((event?.last_event_at ?? null) as TimeValue),
        risk_action: recentCount >= 10 ? 'suspended' as const : recentCount >= 5 ? 'throttled' as const : 'logged' as const,
      }
    })
    return { items, total: items.length, window_minutes: windowMinutes, policy_window_minutes: 5 }
  }
}

import { asciiDecimalDigits } from '@gugu/core/shared/unicode-decimal'

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

import {CoreError} from '@gugu/core/contracts'

export interface AdminBanAudit {operator:string;ip:string|null}
/** 兼容管理员封禁开关；账户提交与后续审计保持Python两次提交语义。 */
export function createAdminUserBanToggle<DB>(db:Kysely<DB>,publishAuthStateChanged:(userId:string)=>Promise<unknown>){
 return async(userId:string,audit:AdminBanAudit)=>{
  const changed=await db.transaction().execute(async tx=>{
   const user=(await sql<{id:string;username:string;is_active:boolean}>`SELECT id,username,is_active FROM users WHERE id=${userId} FOR UPDATE`.execute(tx)).rows[0]
   if(!user)throw new CoreError('not_found','用户不存在')
   const active=!user.is_active
   if(active)await sql`UPDATE users SET account_status='active',is_active=true,suspended_until=NULL,suspended_reason=NULL,security_version=COALESCE(security_version,0)+1 WHERE id=${user.id}`.execute(tx)
   else await sql`UPDATE users SET account_status='suspended',is_active=false,suspended_until=clock_timestamp()+interval '2592000 seconds',suspended_reason='admin_ban_compat',security_version=COALESCE(security_version,0)+1 WHERE id=${user.id}`.execute(tx)
   return {id:user.id,username:user.username,active}
  })
  try{await publishAuthStateChanged(changed.id)}catch{/* 与Python一致：撤销通知失败不回滚已生效账户状态。 */}
  const description=`${changed.active?'解封':'封禁'}用户 ${changed.username}`
  // 审计失败向上抛出；不能据此恢复已封禁账户或旧安全版本。
  await sql`INSERT INTO audit_logs(username,action,description,ip,created_at) VALUES(${audit.operator},'user',${description},${audit.ip},clock_timestamp())`.execute(db)
  return {id:userId,is_active:changed.active}
 }
}
