import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

type Row = Record<string, unknown>
export interface AgentUsageQueryAdapter {
  (sql: string, params?: unknown[]): Promise<{ rows: Row[] }>
}
export interface AgentUsageOptions {
  requireAdmin: preHandlerHookHandler
  query: AgentUsageQueryAdapter
  now?: () => Date
}
const cutoff = '2026-09-03 11:15:00+00'
const fullInput = `CASE WHEN LOWER(provider) IN ('anthropic','minimax') OR created_at >= '${cutoff}'::timestamptz THEN tokens_in + cache_read + cache_write ELSE tokens_in END`
const numeric = (value: unknown) => Number(value ?? 0)
const summary = (row: Row = {}) => {
  const tokensIn = numeric(row.tokens_in), cacheRead = numeric(row.cache_read)
  return { calls: numeric(row.calls), tokens_in: tokensIn, tokens_out: numeric(row.tokens_out), cache_read: cacheRead, cache_write: numeric(row.cache_write), cache_ratio: tokensIn ? Number((cacheRead / tokensIn).toFixed(6)) : 0 }
}
function zone(name: unknown): string {
  if (typeof name === 'string' && name) {
    try { new Intl.DateTimeFormat('en', { timeZone: name }); return name }
    catch { /* 无效时区按服务端时区回退 */ }
  }
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone
  return fallback || 'UTC'
}
function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  return Object.fromEntries(parts.map(({ type, value }) => [type, value])) as { year: string; month: string; day: string }
}
function dateString(year: number, month: number, day: number) {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}
function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return date.toISOString().slice(0, 10) === value ? value : null
}
function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
function localBoundary(value: string, timeZone: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  const target = Date.UTC(year, month - 1, day)
  let guess = target
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess))
    const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]))
    const represented = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second)
    guess += target - represented
  }
  return new Date(guess)
}
function nextMonth(month: string) {
  const [year, value] = month.split('-').map(Number)
  return value === 12 ? `${year + 1}-01` : `${year}-${String(value + 1).padStart(2, '0')}`
}
function firstDay(month: string) { return `${month}-01` }
function daysInMonth(month: string) {
  const [year, value] = month.split('-').map(Number)
  return new Date(Date.UTC(year, value, 0)).getUTCDate()
}
function filters(includeByok: boolean, excludeDev: boolean, alias = '') {
  const prefix = alias ? `${alias}.` : ''
  return `${includeByok ? '' : ` AND NOT ${prefix}is_byok`}${excludeDev ? ` AND ${prefix}user_id NOT IN (SELECT id FROM users WHERE is_developer)` : ''}`
}
async function usageSummary(query: AgentUsageQueryAdapter, from: Date, until: Date, where: string, params: unknown[] = []) {
  const result = await query(`SELECT COUNT(*) AS calls, COALESCE(SUM(${fullInput}),0) AS tokens_in,
    COALESCE(SUM(tokens_out),0) AS tokens_out, COALESCE(SUM(cache_read),0) AS cache_read,
    COALESCE(SUM(cache_write),0) AS cache_write FROM agent_usage WHERE created_at >= $1 AND created_at < $2 ${where}`, [from, until, ...params])
  return summary(result.rows[0])
}
async function scenarioUsage(query: AgentUsageQueryAdapter, from: Date, until: Date, where: string) {
  const result = await query(`SELECT COALESCE(scenario,'chat') AS scenario, COUNT(*) AS calls,
    COALESCE(SUM(${fullInput}),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out,
    COALESCE(SUM(cache_read),0) AS cache_read, COALESCE(SUM(cache_write),0) AS cache_write,
    COALESCE(SUM(CASE WHEN ${fullInput} > 0 AND COALESCE(cache_read,0) = 0 THEN 1 ELSE 0 END),0) AS cold_calls,
    COALESCE(SUM(CASE WHEN cache_read > 0 THEN ${fullInput} ELSE 0 END),0) AS warm_tokens_in
    FROM agent_usage WHERE created_at >= $1 AND created_at < $2 ${where} GROUP BY scenario ORDER BY COUNT(*) DESC`, [from, until])
  return result.rows.map((row) => {
    const total = summary(row), warm = numeric(row.warm_tokens_in)
    return { scenario: row.scenario, ...total, cold_calls: numeric(row.cold_calls), warm_tokens_in: warm, warm_cache_ratio: warm ? Number((total.cache_read / warm).toFixed(6)) : null }
  })
}

export function registerAdminAgentUsageRoute(app: FastifyInstance, options: AgentUsageOptions): void {
  const preHandler = options.requireAdmin
  app.get('/api/v1/admin/agent/usage', { preHandler }, async (request) => {
    const queryParams = request.query as Record<string, unknown>
    const now = options.now?.() ?? new Date(), timeZone = zone(queryParams.timezone)
    const todayParts = localParts(now, timeZone)
    const currentDate = `${todayParts.year}-${todayParts.month}-${todayParts.day}`
    const selectedDate = parseDate(queryParams.date) ?? currentDate
    const anchor = selectedDate > currentDate ? currentDate : selectedDate
    const todayStart = localBoundary(anchor, timeZone), nextDay = localBoundary(shiftDate(anchor, 1), timeZone)
    const todayEnd = anchor === currentDate && nextDay > now ? now : nextDay
    const includeByok = queryParams.include_byok === 'true', excludeDev = queryParams.exclude_dev === 'true', model = typeof queryParams.model === 'string' ? queryParams.model : null
    const where = filters(includeByok, excludeDev)
    const totalResult = await options.query(`SELECT COUNT(*) AS calls, COALESCE(SUM(${fullInput}),0) AS tokens_in,
      COALESCE(SUM(tokens_out),0) AS tokens_out, COALESCE(SUM(cache_read),0) AS cache_read,
      COALESCE(SUM(cache_write),0) AS cache_write FROM agent_usage WHERE TRUE ${where}`)
    const total = summary(totalResult.rows[0]), today = await usageSummary(options.query, todayStart, todayEnd, where)
    const modelResult = await options.query(`SELECT model,provider,COUNT(*) AS calls,COALESCE(SUM(${fullInput}),0) AS tokens_in,
      COALESCE(SUM(tokens_out),0) AS tokens_out,COALESCE(SUM(cache_read),0) AS cache_read,COALESCE(SUM(cache_write),0) AS cache_write
      FROM agent_usage WHERE TRUE ${where} GROUP BY model,provider ORDER BY COUNT(*) DESC`)
    const byModel = modelResult.rows.map((row) => ({ model: row.model, provider: row.provider, calls: numeric(row.calls), tokens_in: numeric(row.tokens_in), tokens_out: numeric(row.tokens_out), cache_read: numeric(row.cache_read), cache_write: numeric(row.cache_write) }))
    const monthResult = await options.query(`SELECT TO_CHAR(created_at AT TIME ZONE $1,'YYYY-MM') AS month FROM agent_usage WHERE TRUE ${where} GROUP BY month ORDER BY month DESC LIMIT 12`, [timeZone])
    const months = monthResult.rows.map((row) => String(row.month))
    const targetMonth = typeof queryParams.month === 'string' && months.includes(queryParams.month)
      ? queryParams.month
      : queryParams.date ? anchor.slice(0, 7) : months[0] ?? anchor.slice(0, 7)
    const monthStart = localBoundary(firstDay(targetMonth), timeZone), monthEnd = localBoundary(nextMonth(targetMonth) + '-01', timeZone)
    const monthFilter = `${where}${model ? ' AND model = $4' : ''}`
    const dailyResult = await options.query(`SELECT TO_CHAR(created_at AT TIME ZONE $3,'YYYY-MM-DD') AS day,COUNT(*) AS calls,
      COALESCE(SUM(${fullInput}),0) AS tokens_in,COALESCE(SUM(tokens_out),0) AS tokens_out,
      COALESCE(SUM(cache_read),0) AS cache_read,COALESCE(SUM(cache_write),0) AS cache_write FROM agent_usage
      WHERE created_at >= $1 AND created_at < $2 ${monthFilter} GROUP BY day ORDER BY day`, model ? [monthStart, monthEnd, timeZone, model] : [monthStart, monthEnd, timeZone])
    const dailyMap = new Map(dailyResult.rows.map((row) => [String(row.day), summary(row)]))
    const daily = Array.from({ length: daysInMonth(targetMonth) }, (_, i) => {
      const date = shiftDate(firstDay(targetMonth), i), totals = dailyMap.get(date) ?? summary()
      return { date, ...totals }
    })
    const weekStart = shiftDate(anchor, -((new Date(`${anchor}T00:00:00Z`).getUTCDay() + 6) % 7)), weekEnd = shiftDate(weekStart, 7)
    const weekResult = await options.query(`SELECT TO_CHAR(created_at AT TIME ZONE $3,'YYYY-MM-DD') AS day,COUNT(*) AS calls,
      COALESCE(SUM(${fullInput}),0) AS tokens_in,COALESCE(SUM(tokens_out),0) AS tokens_out,
      COALESCE(SUM(cache_read),0) AS cache_read,COALESCE(SUM(cache_write),0) AS cache_write FROM agent_usage
      WHERE created_at >= $1 AND created_at < $2 ${monthFilter} GROUP BY day ORDER BY day`, model ? [localBoundary(weekStart,timeZone),localBoundary(weekEnd,timeZone),timeZone,model] : [localBoundary(weekStart,timeZone),localBoundary(weekEnd,timeZone),timeZone])
    const weekMap = new Map(weekResult.rows.map((row) => [String(row.day), summary(row)]))
    const weekDaily = Array.from({ length: 7 }, (_, i) => { const date = shiftDate(weekStart,i); return { date, ...(weekMap.get(date) ?? summary()) } })
    const hourResult = await options.query(`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $3) AS hour,COUNT(*) AS calls,
      COALESCE(SUM(${fullInput}),0) AS tokens_in,COALESCE(SUM(tokens_out),0) AS tokens_out,
      COALESCE(SUM(cache_read),0) AS cache_read,COALESCE(SUM(cache_write),0) AS cache_write FROM agent_usage
      WHERE created_at >= $1 AND created_at < $2 ${where}${model ? ' AND model = $4' : ''} GROUP BY hour`, model ? [todayStart,todayEnd,timeZone,model] : [todayStart,todayEnd,timeZone])
    const hourMap = new Map(hourResult.rows.map((row) => [numeric(row.hour), summary(row)]))
    const todayHourly = Array.from({ length: 24 }, (_, hour) => ({ date: `${String(hour).padStart(2,'0')}:00`, ...(hourMap.get(hour) ?? summary()) }))
    const [scenarioDay, scenarioWeek, scenarioMonth, mcpSummary, mcpCalls] = await Promise.all([
      scenarioUsage(options.query,todayStart,todayEnd,where), scenarioUsage(options.query,localBoundary(weekStart,timeZone),localBoundary(weekEnd,timeZone),where), scenarioUsage(options.query,monthStart,monthEnd,where),
      options.query(`SELECT COUNT(*) AS servers,COUNT(DISTINCT user_id) AS users FROM user_mcp_servers WHERE scope='user' AND enabled IS TRUE${excludeDev ? ' AND user_id NOT IN (SELECT id FROM users WHERE is_developer)' : ''}`),
      options.query(`SELECT COUNT(*) AS calls FROM agent_usage WHERE scenario='mcp' ${where}`),
    ])
    return { total, today: { date: anchor, ...today }, current_date: currentDate, anchor_date: anchor, by_model: byModel,
      by_scenario: scenarioDay, by_scenario_week: scenarioWeek, by_scenario_month: scenarioMonth,
      mcp_summary: { enabled_users: numeric(mcpSummary.rows[0]?.users), enabled_servers: numeric(mcpSummary.rows[0]?.servers), calls_total: numeric(mcpCalls.rows[0]?.calls) },
      active_model: model, months, month: targetMonth, daily, today_hourly: todayHourly, week_daily: weekDaily, month_daily: daily,
      timezone: timeZone, usage_basis: `已落库的成功 LLM 调用（${includeByok ? '含 BYOK' : '不含 BYOK'}）；输入 token 按完整输入统计，缓存命中率按完整输入加权` }
  })
}
