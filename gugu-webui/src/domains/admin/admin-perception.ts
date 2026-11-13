import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify'

type Event = Record<string, unknown> & { t?: string; u?: string; ts?: number }
type PerceptionQuery = Record<string, unknown>
export interface AdminPerceptionOptions {
  requireAdmin: preHandlerHookHandler
  events: () => Promise<Event[]>
  misreadCases: () => Promise<Event[]>
  developerPrefixes: () => Promise<Set<string>>
  readMisread: () => Promise<string>
  now?: () => number
}

function mean(values: unknown[], digits = 1): number | null {
  const nums = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return nums.length ? Number((nums.reduce((sum, value) => sum + value, 0) / nums.length).toFixed(digits)) : null
}
function countBy<T>(values: T[]): Array<{ value: T; count: number }> {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
}
function lastQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value.at(-1) : value
}
function parseQueryInteger(query: PerceptionQuery, key: string, fallback: number): number {
  const value = lastQueryValue(query[key])
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return Number(value.trim())
  throw { key, value, kind: 'int_parsing' }
}
function parseQueryFloat(query: PerceptionQuery, key: string, fallback: number): number {
  const value = lastQueryValue(query[key])
  if (value === undefined) return fallback
  if (typeof value === 'number') return value
  const numeric = typeof value === 'string' ? value.trim() : ''
  if (/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|inf(?:inity)?|nan)$/i.test(numeric)) return Number(numeric)
  throw { key, value, kind: 'float_parsing' }
}
function parseQueryBoolean(query: PerceptionQuery, key: string, fallback = false): boolean {
  const value = lastQueryValue(query[key])
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') throw { key, value, kind: 'bool_parsing' }
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'on', 'yes', 'y', 't'].includes(normalized)) return true
  if (['false', '0', 'off', 'no', 'n', 'f'].includes(normalized)) return false
  throw { key, value, kind: 'bool_parsing' }
}
function parseFailure(reply: FastifyReply, error: unknown) {
  if (!error || typeof error !== 'object' || !('key' in error)) return null
  const issue = error as { key: string; value: unknown; kind: string }
  const labels: Record<string, string> = {
    int_parsing: 'Input should be a valid integer',
    float_parsing: 'Input should be a valid number',
    bool_parsing: 'Input should be a valid boolean',
  }
  return reply.code(422).send({ detail: [{
    type: issue.kind,
    loc: ['query', issue.key],
    msg: labels[issue.kind] ?? 'Input should be valid',
    input: issue.value,
  }] })
}
function safeEvents(events: Event[]): Event[] {
  const allowed = ['t', 'u', 'ts', 'intent', 'model', 'ambiguity', 'emo', 'emotion', 'kind', 'v']
  return events.filter((event) => event && typeof event === 'object' && ['perc', 'misperc', 'fb'].includes(String(event.t)))
    .map((event) => Object.fromEntries(Object.entries(event).filter(([key]) => allowed.includes(key))))
}
function aggregate(events: Event[], minEvents: number, thresholds: { rate_hi: number; min_n: number; ambig_hi: number }) {
  const byUser = new Map<string, Event[]>()
  for (const event of events) if (typeof event.u === 'string') byUser.set(event.u, [...(byUser.get(event.u) ?? []), event])
  const active = new Set([...byUser].filter(([, rows]) => rows.filter((row) => row.t === 'perc').length >= minEvents).map(([user]) => user))
  const activeEvents = events.filter((event) => typeof event.u === 'string' && active.has(event.u))
  const perc = activeEvents.filter((event) => event.t === 'perc')
  const misperc = activeEvents.filter((event) => event.t === 'misperc')
  if (!active.size) return {
    active_users: 0, perc_total: 0, misperc_total: 0, overall_misperc_rate: null,
    perception_misperc_rate: null, misperc_by_kind: [], avg_ambiguity: null, avg_emo_strength: null,
    intent_distribution: [], by_model: [], emotion_distribution: [], feedback_distribution: [], feedback_total: 0,
    flags: [], flag_items: [], note: `暂无活跃用户（窗口内对话 ≥${minEvents} 轮的用户）—— 多聊几轮再看`,
  }
  const perUserRates: number[] = [], perUserPerceptionRates: number[] = [], ambiguities: number[] = [], emotions: number[] = []
  const intentCounts = new Map<string, number>(), intentMisreads = new Map<string, number>(), intentShares = new Map<string, number[]>(), modelCounts = new Map<string, number>(), modelMisreads = new Map<string, number>()
  const kindCounts = new Map<string, number>(), emotionCounts = new Map<string, number>(), feedbackCounts = new Map<string, number>()
  for (const user of active) {
    const rows = (byUser.get(user) ?? []).sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0))
    const userPerc = rows.filter((row) => row.t === 'perc')
    let userMisreads = 0, userPerceptionMisreads = 0, latest: Event | undefined
    for (const row of rows) {
      if (row.t === 'perc') latest = row
      if (row.t === 'misperc' && latest) {
        userMisreads++
        const kind = String(row.kind ?? '未判')
        kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1)
        if (kind === '感知误读') userPerceptionMisreads++
        const intent = String(latest.intent ?? 'null'), model = String(latest.model ?? '(未知)')
        intentMisreads.set(intent, (intentMisreads.get(intent) ?? 0) + 1)
        modelMisreads.set(model, (modelMisreads.get(model) ?? 0) + 1)
      }
    }
    perUserRates.push(userMisreads / userPerc.length)
    perUserPerceptionRates.push(userPerceptionMisreads / userPerc.length)
    ambiguities.push(mean(userPerc.map((row) => row.ambiguity)) ?? 0)
    emotions.push(mean(userPerc.map((row) => row.emo)) ?? 0)
    const userIntentCounts = new Map<string, number>()
    for (const row of userPerc) {
      const intent = String(row.intent ?? 'null'), model = String(row.model ?? '(未知)')
      userIntentCounts.set(intent, (userIntentCounts.get(intent) ?? 0) + 1)
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1)
      if (row.emotion && row.emotion !== '无') emotionCounts.set(String(row.emotion), (emotionCounts.get(String(row.emotion)) ?? 0) + 1)
    }
    for (const [intent, count] of userIntentCounts) intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + count)
    for (const intent of new Set([...intentCounts.keys(), ...userIntentCounts.keys()])) {
      const shares = intentShares.get(intent) ?? []
      shares.push((userIntentCounts.get(intent) ?? 0) / userPerc.length)
      intentShares.set(intent, shares)
    }
  }
  for (const row of activeEvents.filter((event) => event.t === 'fb')) {
    const key = String(row.v ?? 'null'); feedbackCounts.set(key, (feedbackCounts.get(key) ?? 0) + 1)
  }
  const overall = Number((perUserRates.reduce((a, b) => a + b, 0) / perUserRates.length).toFixed(3))
  const perceptionRate = Number((perUserPerceptionRates.reduce((a, b) => a + b, 0) / perUserPerceptionRates.length).toFixed(3))
  const intents = [...intentCounts].map(([intent, count]) => {
    const shares = intentShares.get(intent) ?? []
    return { intent, count, pct: Number((shares.reduce((a, b) => a + b, 0) / shares.length * 100).toFixed(1)), misperc: intentMisreads.get(intent) ?? 0, misperc_rate: count ? Number(((intentMisreads.get(intent) ?? 0) / count).toFixed(3)) : null }
  }).sort((a, b) => b.pct - a.pct)
  const models = [...modelCounts].map(([model, count]) => ({ model, count, misperc: modelMisreads.get(model) ?? 0, misperc_rate: count ? Number(((modelMisreads.get(model) ?? 0) / count).toFixed(3)) : null })).sort((a, b) => b.count - a.count)
  const flags: string[] = [], flagItems: Array<Record<string, unknown>> = []
  for (const row of intents) if (row.count >= thresholds.min_n && row.misperc_rate && row.misperc_rate > thresholds.rate_hi) {
    flags.push(`intent「${row.intent}」误判率偏高 ${Math.round(row.misperc_rate * 100)}%（n=${row.count}）`)
    flagItems.push({ kind: 'intent', intent: row.intent, rate: row.misperc_rate, count: row.count })
  }
  const avgAmbiguity = mean(ambiguities)
  if (avgAmbiguity !== null && avgAmbiguity > thresholds.ambig_hi) {
    flags.push(`平均歧义度偏高 ${avgAmbiguity}（模型普遍读不准 / 该多澄清）`)
    flagItems.push({ kind: 'ambiguity', value: avgAmbiguity })
  }
  if (perc.length >= 50 && !intents.some((row) => ['情绪', '陪伴'].includes(row.intent) && row.count)) {
    flags.push('情绪/陪伴型占比为 0 —— 情绪需求可能被系统性误归类')
    flagItems.push({ kind: 'emotion_zero' })
  }
  for (const row of models) if (row.count >= thresholds.min_n && row.misperc_rate && row.misperc_rate > overall + 0.1) {
    flags.push(`模型「${row.model}」误判率 ${Math.round(row.misperc_rate * 100)}% 明显高于整体 ${Math.round(overall * 100)}%`)
    flagItems.push({ kind: 'model', model: row.model, rate: row.misperc_rate, overall_rate: overall })
  }
  return {
    active_users: active.size, perc_total: perc.length, misperc_total: misperc.length,
    overall_misperc_rate: overall, perception_misperc_rate: perceptionRate,
    misperc_by_kind: [...kindCounts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    avg_ambiguity: avgAmbiguity, avg_emo_strength: mean(emotions), intent_distribution: intents, by_model: models,
    emotion_distribution: [...emotionCounts].map(([emotion, count]) => ({ emotion, count })).sort((a, b) => b.count - a.count),
    feedback_distribution: [...feedbackCounts].map(([feedback, count]) => ({ feedback, count })).sort((a, b) => b.count - a.count),
    feedback_total: [...feedbackCounts.values()].reduce((a, b) => a + b, 0), flags, flag_items: flagItems,
    note: `口径：活跃用户（窗口内 ≥${minEvents} 轮）${active.size} 人；头部指标按用户宏平均（重度用户不主导）`,
  }
}

export function registerAdminPerceptionRoutes(app: FastifyInstance, options: AdminPerceptionOptions): void {
  const preHandler = options.requireAdmin
  const now = options.now ?? Date.now
  app.get('/api/v1/admin/perception', { preHandler }, async (request, reply) => {
    const query = request.query as PerceptionQuery
    let hours: number, minEvents: number, limit: number, thresholds: { rate_hi: number; min_n: number; ambig_hi: number }, excludeDev: boolean
    try {
      hours = parseQueryInteger(query, 'hours', 168)
      minEvents = parseQueryInteger(query, 'min_events', 1)
      limit = parseQueryInteger(query, 'limit', 20000)
      thresholds = {
        rate_hi: parseQueryFloat(query, 'rate_hi', 0.25),
        min_n: parseQueryInteger(query, 'min_n', 10),
        ambig_hi: parseQueryFloat(query, 'ambig_hi', 60),
      }
      excludeDev = parseQueryBoolean(query, 'exclude_dev')
    } catch (error) {
      return parseFailure(reply, error) ?? reply.code(500).send({ detail: '服务器内部错误，请稍后重试' })
    }
    let events = safeEvents((await options.events()).slice(0, limit))
    if (hours) events = events.filter((event) => Number(event.ts ?? 0) >= now() / 1000 - hours * 3600)
    if (excludeDev) {
      const developers = await options.developerPrefixes()
      events = events.filter((event) => !developers.has(String(event.u)))
    }
    return { window_hours: hours, min_events: minEvents, thresholds, ...aggregate(events, minEvents, thresholds) }
  })
  app.get('/api/v1/admin/perception/export', { preHandler }, async (request, reply) => {
    let hours: number
    try { hours = parseQueryInteger(request.query as PerceptionQuery, 'hours', 0) }
    catch (error) { return parseFailure(reply, error) ?? reply.code(500).send({ detail: '服务器内部错误，请稍后重试' }) }
    let events = safeEvents(await options.events())
    if (hours) events = events.filter((event) => Number(event.ts ?? 0) >= now() / 1000 - hours * 3600)
    events.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0))
    return reply.type('application/json; charset=utf-8').header('content-disposition', `attachment; filename="perception_events_${hours || 'all'}h.json"`).send(JSON.stringify(events, null, 1))
  })
  app.get('/api/v1/admin/perception/misread/recent', { preHandler }, async (request, reply) => {
    const query = request.query as PerceptionQuery
    let requested: number, excludeDev: boolean
    try {
      requested = parseQueryInteger(query, 'n', 30)
      excludeDev = parseQueryBoolean(query, 'exclude_dev')
    } catch (error) { return parseFailure(reply, error) ?? reply.code(500).send({ detail: '服务器内部错误，请稍后重试' }) }
    const n = Math.max(1, Math.min(requested || 30, 200))
    let cases = (await options.misreadCases()).slice(0, excludeDev ? 200 : n)
    if (excludeDev) { const developers = await options.developerPrefixes(); cases = cases.filter((row) => !developers.has(String(row.u))).slice(0, n) }
    return { total: cases.length, cases }
  })
  app.get('/api/v1/admin/perception/misread/export', { preHandler }, async (_request, reply) => {
    const body = await options.readMisread() || '# 错读反思记录\n\n暂无——需发生一次「感知误读 + 用户纠正」才会记一条。\n'
    return reply.type('text/markdown; charset=utf-8').header('content-disposition', 'attachment; filename="misread_reflections.md"').send(body)
  })
}
