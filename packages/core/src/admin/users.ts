import { utc } from '../shared/timestamps.js'
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
