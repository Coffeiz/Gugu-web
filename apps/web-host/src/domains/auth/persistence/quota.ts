import type { Pool, QueryResultRow } from 'pg'
import type { UserQuota, UserQuotaReader, UserUsageTrends } from '../quota.js'
import { addUtcDaysToDateKey, dateKeyInTimeZone, startOfDateKeyInTimeZone } from '../../../shared/date-time.js'

interface UserRow extends QueryResultRow {
  id: string
  quota_window_started_at: Date | string | null
  token_limit_6h: number | null
  token_limit_weekly: number | null
  timezone: string | null
  has_active_byok: boolean
}

interface UsageRow extends QueryResultRow {
  used_6h: number | string | null
  used_weekly: number | string | null
}

interface ByokUsageRow extends QueryResultRow {
  today_tokens: number | string | null
  month_tokens: number | string | null
  month_tokens_in: number | string | null
  month_cache_read: number | string | null
  month_cache_write: number | string | null
}

interface UsageTrendRow extends QueryResultRow {
  created_at: Date | string
  tokens_in: number | string | null
  cache_read: number | string | null
  cache_write: number | string | null
  tokens_out: number | string | null
}

export interface UserQuotaSettings {
  readonly defaultLimit6h: number | null
  readonly defaultLimitWeekly: number | null
  readonly byokEnabled: boolean
  readonly localDeployment: boolean
  readonly serverTimezone: string
}

function numeric(value: number | string | null): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function validTimezone(value: string | null, fallback: string): string {
  const candidate = value || fallback
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate }).format(0)
    return candidate
  } catch {
    return fallback
  }
}

function resolveLimit(userLimit: number | null, defaultLimit: number | null): number | null {
  if (userLimit === -1) return null
  return userLimit ?? defaultLimit
}

function timestamp(value: Date | string | null): Date | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function createPostgresUserQuotaReader(
  pool: Pool,
  settings: UserQuotaSettings,
  now: () => Date = () => new Date(),
): UserQuotaReader {
  const reader: UserQuotaReader = async (ownerId) => {
    const users = await pool.query<UserRow>(
      `SELECT u.id::text, u.quota_window_started_at, u.token_limit_6h, u.token_limit_weekly,
              u.timezone,
              ($2::boolean OR $3::boolean) AND EXISTS (
                SELECT 1 FROM user_provider_credentials c
                WHERE c.user_id = u.id AND c.capability = 'llm' AND c.enabled IS TRUE
              ) AS has_active_byok
       FROM users u WHERE u.id = $1`,
      [ownerId, settings.byokEnabled, settings.localDeployment],
    )
    const user = users.rows[0]
    if (!user) throw new Error('用户不存在')

    const instant = now()
    const windowStarted = timestamp(user.quota_window_started_at)
    const activeWindow = windowStarted !== null
      && instant.getTime() < windowStarted.getTime() + 6 * 60 * 60 * 1000
    const resetAt = activeWindow ? new Date(windowStarted!.getTime() + 6 * 60 * 60 * 1000) : null
    const serverTimezone = validTimezone(settings.serverTimezone, 'UTC')
    const serverTodayKey = dateKeyInTimeZone(instant, serverTimezone)
    const serverMondayKey = addUtcDaysToDateKey(
      serverTodayKey,
      -((new Date(`${serverTodayKey}T00:00:00Z`).getUTCDay() + 6) % 7),
    )
    const weekStart = startOfDateKeyInTimeZone(serverMondayKey, serverTimezone)
    const hasByok = Boolean(user.has_active_byok)
    const usage = await pool.query<UsageRow>(
      `SELECT COALESCE(SUM(tokens_in + tokens_out) FILTER (WHERE created_at >= $2), 0) AS used_6h,
              COALESCE(SUM(tokens_in + tokens_out) FILTER (WHERE created_at >= $3), 0) AS used_weekly
       FROM agent_usage WHERE user_id = $1 AND is_byok = $4`,
      [ownerId, activeWindow ? windowStarted : null, weekStart, hasByok],
    )

    let todayTokens = 0
    let monthTokens = 0
    let monthTokensIn = 0
    let monthCacheRead = 0
    let monthCacheWrite = 0
    if (hasByok) {
      const userTimezone = validTimezone(user.timezone, serverTimezone)
      const todayKey = dateKeyInTimeZone(instant, userTimezone)
      const todayStart = startOfDateKeyInTimeZone(todayKey, userTimezone)
      const monthStart = startOfDateKeyInTimeZone(`${todayKey.slice(0, 7)}-01`, userTimezone)
      const byokUsage = await pool.query<ByokUsageRow>(
        `SELECT COALESCE(SUM(tokens_in + tokens_out + cache_read + cache_write)
                 FILTER (WHERE created_at >= $2), 0) AS today_tokens,
                COALESCE(SUM(tokens_in + tokens_out + cache_read + cache_write), 0) AS month_tokens,
                COALESCE(SUM(tokens_in), 0) AS month_tokens_in,
                COALESCE(SUM(cache_read), 0) AS month_cache_read,
                COALESCE(SUM(cache_write), 0) AS month_cache_write
         FROM agent_usage WHERE user_id = $1 AND is_byok IS TRUE AND created_at >= $3`,
        [ownerId, todayStart, monthStart],
      )
      const row = byokUsage.rows[0]
      todayTokens = numeric(row?.today_tokens ?? 0)
      monthTokens = numeric(row?.month_tokens ?? 0)
      monthTokensIn = numeric(row?.month_tokens_in ?? 0)
      monthCacheRead = numeric(row?.month_cache_read ?? 0)
      monthCacheWrite = numeric(row?.month_cache_write ?? 0)
    }

    const effectiveInput = monthTokensIn + monthCacheRead + monthCacheWrite
    return {
      used_6h: activeWindow ? numeric(usage.rows[0]?.used_6h ?? 0) : 0,
      limit_6h: hasByok ? null : resolveLimit(user.token_limit_6h, settings.defaultLimit6h),
      reset_6h_at: resetAt?.toISOString() ?? null,
      used_weekly: numeric(usage.rows[0]?.used_weekly ?? 0),
      limit_weekly: hasByok ? null : resolveLimit(user.token_limit_weekly, settings.defaultLimitWeekly),
      usage_kind: hasByok ? 'byok' : 'platform',
      is_byok: hasByok,
      byok_tokens_today: todayTokens,
      byok_tokens_month: monthTokens,
      byok_cache_rate: effectiveInput ? Number((monthCacheRead / effectiveInput).toFixed(6)) : 0,
    }
  }
  reader.getUsageTrends = createPostgresUserUsageTrendsReader(pool, settings, now)
  return reader
}

export function createPostgresUserUsageTrendsReader(
  pool: Pool,
  settings: UserQuotaSettings,
  now: () => Date = () => new Date(),
): (ownerId: string, days: number) => Promise<UserUsageTrends> {
  return async (ownerId, requestedDays) => {
    const days = Math.max(1, Math.min(Number.isSafeInteger(requestedDays) ? requestedDays : 30, 90))
    const users = await pool.query<{ timezone: string | null } & QueryResultRow>(
      'SELECT timezone FROM users WHERE id = $1',
      [ownerId],
    )
    const user = users.rows[0]
    if (!user) throw new Error('用户不存在')

    const timezone = validTimezone(user.timezone, settings.serverTimezone)
    const today = dateKeyInTimeZone(now(), timezone)
    const startDate = addUtcDaysToDateKey(today, -(days - 1))
    const dateKeys = Array.from({ length: days }, (_, index) => addUtcDaysToDateKey(startDate, index))
    const byDay = new Map<string, number[]>(dateKeys.map((date) => [date, [0, 0, 0, 0]]))
    const rows = await pool.query<UsageTrendRow>(
      `SELECT created_at, tokens_in, cache_read, cache_write, tokens_out
       FROM agent_usage
       WHERE user_id = $1 AND is_byok IS TRUE AND created_at >= $2
       ORDER BY created_at ASC`,
      [ownerId, startOfDateKeyInTimeZone(startDate, timezone)],
    )
    for (const row of rows.rows) {
      const createdAt = timestamp(row.created_at)
      if (!createdAt) continue
      const key = dateKeyInTimeZone(createdAt, timezone)
      const totals = byDay.get(key)
      if (!totals) continue
      totals[0] += numeric(row.tokens_in)
      totals[1] += numeric(row.cache_read)
      totals[2] += numeric(row.cache_write)
      totals[3] += numeric(row.tokens_out)
    }

    const totalsByDay = dateKeys.map((date) => byDay.get(date)!)
    const tokens_in = totalsByDay.map(([value]) => value)
    const cache_read = totalsByDay.map(([, value]) => value)
    const cache_write = totalsByDay.map(([, , value]) => value)
    const tokens_out = totalsByDay.map(([, , , value]) => value)
    const totalInput = tokens_in.reduce((sum, value) => sum + value, 0)
    const totalCache = cache_read.reduce((sum, value) => sum + value, 0)
    const totalCacheWrite = cache_write.reduce((sum, value) => sum + value, 0)
    const totalOutput = tokens_out.reduce((sum, value) => sum + value, 0)
    const total = totalInput + totalCache + totalCacheWrite + totalOutput
    const average = total / days
    const floorAverage = Math.floor(average)
    const remainder = average - floorAverage
    const daily_avg = remainder > 0.5 || (remainder === 0.5 && floorAverage % 2 === 1)
      ? floorAverage + 1
      : floorAverage

    return {
      labels: dateKeys.map((date) => date.slice(5).replace('-', '/')),
      tokens_in,
      cache_read,
      cache_write,
      tokens_out,
      total,
      daily_avg,
      today: tokens_in.at(-1)! + cache_read.at(-1)! + cache_write.at(-1)! + tokens_out.at(-1)!,
      cache_rate: totalInput + totalCache + totalCacheWrite
        ? totalCache / (totalInput + totalCache + totalCacheWrite)
        : 0,
    }
  }
}
