import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export type OpsHash = Record<string, string | number | bigint | Buffer | null | undefined>
export interface AdminOpsSummaryOptions {
  requireAdmin: preHandlerHookHandler
  hgetall: (key: string) => Promise<OpsHash | null | undefined>
  now?: () => Date
}

const buckets = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000].map(String)
const securityEvents = [
  'ownership.denied',
  'confirm-gate.bypassed',
  'security_event.write_failed',
  'filesystem.authorization.denied',
]
const filesystemOutcomes = ['requested', 'granted', 'revoked', 'denied'] as const
type FilesystemOutcome = typeof filesystemOutcomes[number]

function integer(value: OpsHash[string]): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint') {
    const converted = Number(value)
    if (Number.isSafeInteger(converted)) return converted
  }
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
  if (!/^[+-]?\d+$/.test(text)) throw new Error('运维计数格式无效')
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed)) throw new Error('运维计数超出安全范围')
  return parsed
}

function dayKey(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('运维统计日期无效')
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

async function readHash(options: AdminOpsSummaryOptions, key: string): Promise<OpsHash> {
  return await options.hgetall(key) ?? {}
}

export function registerAdminOpsSummaryRoute(app: FastifyInstance, options: AdminOpsSummaryOptions): void {
  app.get<{ Querystring: { days?: number } }>(
    '/api/v1/admin/ops/summary',
    {
      preHandler: options.requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          properties: { days: { type: 'integer', minimum: 1, maximum: 14, default: 1 } },
        },
      },
    },
    async (request) => {
      const days = request.query.days ?? 1
      const today = options.now?.() ?? new Date()
      const dayKeys = Array.from({ length: days }, (_, offset) => {
        const day = new Date(today.getTime())
        day.setUTCDate(day.getUTCDate() - offset)
        return dayKey(day)
      })
      const tools: Record<string, { calls: number; fails: number; ms_sum: number }> = {}
      const latency: Record<string, number> = {}
      for (const day of dayKeys) {
        const toolHash = await readHash(options, `ops:tool:${day}`)
        for (const [key, raw] of Object.entries(toolHash)) {
          const separator = key.lastIndexOf(':')
          const tool = separator < 0 ? '' : key.slice(0, separator)
          const kind = separator < 0 ? key : key.slice(separator + 1)
          const aggregate = tools[tool] ??= { calls: 0, fails: 0, ms_sum: 0 }
          aggregate[kind as 'calls' | 'fails' | 'ms_sum'] = (aggregate as Record<string, number>)[kind]! + integer(raw)
        }
        const latencyHash = await readHash(options, `ops:lat:${day}`)
        for (const [bucket, raw] of Object.entries(latencyHash))
          latency[bucket] = (latency[bucket] ?? 0) + integer(raw)
      }

      const security: Record<string, number> = Object.fromEntries(securityEvents.map((event) => [event, 0]))
      for (const day of dayKeys) {
        const hash = await readHash(options, `ops:sec:${day}`)
        for (const [event, raw] of Object.entries(hash)) security[event] = (security[event] ?? 0) + integer(raw)
      }

      const email = { calls: 0, sent: 0, failed: 0, ms_sum: 0, errors: {} as Record<string, number> }
      for (const day of dayKeys) {
        const hash = await readHash(options, `ops:email:${day}`)
        for (const [key, raw] of Object.entries(hash)) {
          const value = integer(raw)
          if (key.startsWith('error:')) {
            const code = key.slice(6)
            email.errors[code] = (email.errors[code] ?? 0) + value
          } else if (key === 'calls' || key === 'sent' || key === 'failed' || key === 'ms_sum') {
            email[key] += value
          }
        }
      }
      const emailSummary = {
        ...email,
        avg_ms: email.calls ? Math.trunc(email.ms_sum / email.calls) : 0,
        fail_rate: email.calls ? Number((email.failed / email.calls).toFixed(4)) : 0,
      }

      const filesystem: Record<'session' | 'scheduled_task', Record<FilesystemOutcome, number>> = {
        session: { requested: 0, granted: 0, revoked: 0, denied: 0 },
        scheduled_task: { requested: 0, granted: 0, revoked: 0, denied: 0 },
      }
      for (const day of dayKeys) {
        const hash = await readHash(options, `ops:filesystem-auth:${day}`)
        for (const [key, raw] of Object.entries(hash)) {
          const [subject, outcome] = key.split(':', 2)
          if ((subject === 'session' || subject === 'scheduled_task') && filesystemOutcomes.includes(outcome as FilesystemOutcome))
            filesystem[subject][outcome as FilesystemOutcome] += integer(raw)
        }
      }

      const rows = Object.entries(tools).map(([tool, aggregate]) => {
        const calls = aggregate.calls || 0
        const fails = aggregate.fails || 0
        return {
          tool,
          calls,
          fails,
          fail_rate: calls ? Number((fails / calls).toFixed(4)) : 0,
          avg_ms: calls ? Math.trunc(aggregate.ms_sum / calls) : 0,
        }
      }).sort((left, right) => right.fails - left.fails || right.calls - left.calls)

      const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0)
      const totalFails = rows.reduce((sum, row) => sum + row.fails, 0)
      const totalLatency = Object.values(latency).reduce((sum, count) => sum + count, 0)
      let p99: number | null = null
      if (totalLatency) {
        let accumulated = 0
        for (const bucket of [...buckets, 'inf']) {
          accumulated += latency[bucket] ?? 0
          if (accumulated >= totalLatency * 0.99) {
            p99 = bucket === 'inf' ? null : Number(bucket)
            break
          }
        }
      }
      return {
        days,
        total_calls: totalCalls,
        total_fails: totalFails,
        fail_rate: totalCalls ? Number((totalFails / totalCalls).toFixed(4)) : 0,
        p99_ms: p99,
        latency_buckets: Object.fromEntries([...buckets, 'inf'].map((bucket) => [bucket, latency[bucket] ?? 0])),
        tools: rows,
        security,
        filesystem_authorization: filesystem,
        email_delivery: emailSummary,
      }
    },
  )
}
