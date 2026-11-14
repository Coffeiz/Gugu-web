import type { FastifyInstance, FastifyRequest } from 'fastify'

export interface UserQuota {
  readonly used_6h: number
  readonly limit_6h: number | null
  readonly reset_6h_at: string | null
  readonly used_weekly: number
  readonly limit_weekly: number | null
  readonly usage_kind: 'platform' | 'byok'
  readonly is_byok: boolean
  readonly byok_tokens_today: number
  readonly byok_tokens_month: number
  readonly byok_cache_rate: number
}

export interface UserUsageTrends {
  readonly labels: string[]
  readonly tokens_in: number[]
  readonly cache_read: number[]
  readonly cache_write: number[]
  readonly tokens_out: number[]
  readonly total: number
  readonly daily_avg: number
  readonly today: number
  readonly cache_rate: number
}

export type UserQuotaReader = ((ownerId: string) => Promise<UserQuota>) & {
  getUsageTrends?: (ownerId: string, days: number) => Promise<UserUsageTrends>
}

export interface UserQuotaOptions {
  readonly requireUser: (request: FastifyRequest) => Promise<void>
  readonly ownerIdFromRequest: (request: FastifyRequest) => string
  readonly get: UserQuotaReader
}

export function registerUserQuotaRoute(app: FastifyInstance, options: UserQuotaOptions): void {
  app.get('/api/v1/auth/quota', { preHandler: options.requireUser }, async (request) =>
    options.get(options.ownerIdFromRequest(request)),
  )

  if (options.get.getUsageTrends) {
    app.get<{ Querystring: { days?: string } }>(
      '/api/v1/auth/usage/trends',
      { preHandler: options.requireUser },
      async (request, reply) => {
        const rawDays = request.query.days
        const normalizedDays = rawDays?.trim()
        const parsedDays = rawDays === undefined
          ? 30
          : normalizedDays && /^[+-]?\d+$/.test(normalizedDays) ? Number(normalizedDays) : Number.NaN
        if (!Number.isSafeInteger(parsedDays)) {
          return reply.code(422).send({ detail: 'days must be an integer' })
        }
        const days = Math.max(1, Math.min(parsedDays, 90))
        return options.get.getUsageTrends!(options.ownerIdFromRequest(request), days)
      },
    )
  }
}
