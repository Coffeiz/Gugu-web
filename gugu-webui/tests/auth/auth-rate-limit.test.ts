import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import {
  createInMemoryRateLimitCommands,
  createRedisRateLimiter,
  RateLimitError,
  type RedisRateLimitCommands,
} from '../../src/domains/auth/rate-limit.js'

function makeRequest(
  forwardedFor: string | undefined,
  peer = '192.0.2.10',
): FastifyRequest {
  return {
    headers: { 'x-forwarded-for': forwardedFor },
    raw: { socket: { remoteAddress: peer } },
  } as unknown as FastifyRequest
}

function memoryRedis() {
  const counts = new Map<string, number>()
  const expirations = new Map<string, number>()
  const commands: Array<[string, string | number]> = []
  const redis: RedisRateLimitCommands = {
    async incr(key) {
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      commands.push(['INCR', key])
      return count
    },
    async expire(key, seconds) {
      expirations.set(key, seconds)
      commands.push(['EXPIRE', seconds])
      return true
    },
  }
  return { redis, counts, expirations, commands }
}

const loginLimit = {
  bucket: 'login',
  limit: 10,
  windowSeconds: 300,
} as const

test('Redis login fixed window allows ten attempts then blocks the eleventh and sets TTL once', async () => {
  const memory = memoryRedis()
  const rateLimit = createRedisRateLimiter(memory.redis)
  const request = makeRequest('198.51.100.4, 203.0.113.7')

  for (let attempt = 0; attempt < 10; attempt += 1)
    await rateLimit(request, { ...loginLimit, extra: 'synthetic-user' })

  await assert.rejects(
    rateLimit(request, { ...loginLimit, extra: 'synthetic-user' }),
    (error: unknown) => error instanceof RateLimitError && error.statusCode === 429,
  )
  assert.equal(memory.counts.size, 1)
  assert.deepEqual([...memory.expirations.values()], [300])
  assert.equal(memory.commands.filter(([command]) => command === 'EXPIRE').length, 1)
})

test('login fixed-window buckets isolate peer IP and username without storing raw identifiers', async () => {
  const memory = memoryRedis()
  const rateLimit = createRedisRateLimiter(memory.redis)
  const samePeer = makeRequest('198.51.100.2, 203.0.113.7')
  const otherPeer = makeRequest('203.0.113.8')

  await rateLimit(samePeer, { ...loginLimit, extra: 'first-user' })
  await rateLimit(samePeer, { ...loginLimit, extra: 'second-user' })
  await rateLimit(otherPeer, { ...loginLimit, extra: 'first-user' })

  assert.equal(memory.counts.size, 3)
  const storedKeys = [...memory.counts.keys()].join('\n')
  assert.ok(!storedKeys.includes('first-user'))
  assert.ok(!storedKeys.includes('203.0.113.7'))
  assert.match(storedKeys, new RegExp(createHash('sha256').update('203.0.113.7').digest('hex')))
})

test('Redis failures fail open for login while explicit fail-closed buckets return service unavailable', async () => {
  const failedRedis: RedisRateLimitCommands = {
    async incr() { throw new Error('synthetic redis outage') },
    async expire() { throw new Error('synthetic redis outage') },
  }
  const rateLimit = createRedisRateLimiter(failedRedis)
  const request = makeRequest(undefined)

  await assert.doesNotReject(rateLimit(request, { ...loginLimit, extra: 'synthetic-user' }))
  await assert.rejects(
    rateLimit(request, { ...loginLimit, extra: 'synthetic-user', failClosed: true }),
    (error: unknown) => error instanceof RateLimitError && error.statusCode === 503,
  )
})

test('missing Redis commands fail open by default and fail closed only when requested', async () => {
  const rateLimit = createRedisRateLimiter(null)
  const request = makeRequest(undefined)

  await assert.doesNotReject(rateLimit(request, loginLimit))
  await assert.rejects(
    rateLimit(request, { ...loginLimit, failClosed: true }),
    (error: unknown) => error instanceof RateLimitError && error.statusCode === 503,
  )
})

test('in-memory Admin rate-limit counters retain the fixed-window limit without Redis', async () => {
  let now = 1_000
  const rateLimit = createRedisRateLimiter(createInMemoryRateLimitCommands(() => now))
  const request = makeRequest('198.51.100.20')
  const options = { bucket: 'adminlogin', limit: 2, windowSeconds: 300 }

  await rateLimit(request, options)
  await rateLimit(request, options)
  await assert.rejects(
    rateLimit(request, options),
    (error: unknown) => error instanceof RateLimitError && error.statusCode === 429,
  )

  now += 300_000
  await assert.doesNotReject(rateLimit(request, options))
})
