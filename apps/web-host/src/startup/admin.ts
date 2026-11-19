import { Pool } from 'pg'
import type { FastifyRequest } from 'fastify'
import { type WebUiConfig } from '../config.js'
import { webAgentPromptRoot } from '../modules/agent/context/prompts.js'
import { createRedisAdminAuthVersionStore, createRedisRateLimitCommands } from '../adapters/cache/redis-events.js'
import { createInMemoryRateLimitCommands, createRedisRateLimiter, RateLimitError } from '../modules/auth/rate-limit.js'
import { AdminAuthError, createAdminAuthAdapter, createInMemoryAdminAuthVersionStore } from '../modules/admin/auth.js'
import { createAdminHostGuard } from '../http/admin-host-guard.js'

export function createAdminAuth(pool: Pool, config: WebUiConfig) {
  const versions = config.redisUrl
    ? createRedisAdminAuthVersionStore(config.redisUrl)
    : createInMemoryAdminAuthVersionStore()
  const limiter = createRedisRateLimiter(config.redisUrl
    ? createRedisRateLimitCommands(config.redisUrl)
    : createInMemoryRateLimitCommands())
  return createAdminAuthAdapter({
    username: config.adminUsername,
    password: config.adminPassword,
    secret: config.secretKey,
    tokenExpiresMinutes: config.accessTokenExpiresMinutes,
    getAuthVersion: versions.getAuthVersion,
    incrementAuthVersion: versions.incrementAuthVersion,
    async rateLimit(request, bucket, limit, windowSeconds) {
      try {
        await limiter(request, { bucket, limit, windowSeconds })
      } catch (error) {
        if (error instanceof RateLimitError)
          throw new AdminAuthError(error.message, error.statusCode)
        throw error
      }
    },
    hostGuard: createAdminHostGuard(config.adminAllowedHosts),
    async audit(username, action, detail, request) {
      const forwarded = request.headers['x-forwarded-for']
      const ip = typeof forwarded === 'string'
        ? forwarded.split(',', 1)[0]?.trim().slice(0, 60) || null
        : request.ip.slice(0, 60) || null
      await pool.query(
        'INSERT INTO audit_logs (username, action, description, ip, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
        [username, action, detail, ip],
      )
    },
  })
}

export function createAdminPromptOptions(pool: Pool) {
  return {
    root: webAgentPromptRoot,
    adminUsername: (request: FastifyRequest) => request.adminIdentity?.username ?? 'admin',
    async writeAuditLog(username: string, action: 'prompt', description: string, request: FastifyRequest) {
      const forwarded = request.headers['x-forwarded-for']
      const ip = typeof forwarded === 'string' ? forwarded.split(',', 1)[0]?.trim().slice(0, 60) || null : request.ip.slice(0, 60) || null
      await pool.query('INSERT INTO audit_logs (username, action, description, ip, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)', [username, action, description, ip])
    },
  }
}
