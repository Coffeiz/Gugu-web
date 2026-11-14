import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import Fastify from 'fastify'
import test from 'node:test'
import {
  PASSWORD_RESET_GENERIC,
  PASSWORD_RESET_TTL_SECONDS,
  maskResetEmail,
  registerPasswordResetRoutes,
  type PasswordResetRedisCommands,
  type PasswordResetStore,
} from '../../src/domains/auth/password-reset.js'
import { RateLimitError } from '../../src/domains/auth/rate-limit.js'

const ownerId = '5b850d82-3b90-4ec7-a1a1-8d8280b6c1ed'
const secretEmail = 'cedarz@example.test'
const resetToken = 'synthetic-password-reset-token-0123456789'

function createRedis(): PasswordResetRedisCommands & { readonly values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    async get(key) { return values.get(key) ?? null },
    async set(key, value, ...options) {
      if (options.includes('NX') && values.has(key)) return null
      values.set(key, value)
      return 'OK'
    },
    async del(...keys) {
      let deleted = 0
      for (const key of keys) if (values.delete(key)) deleted += 1
      return deleted
    },
    async claim(tokenKey, claimKey) {
      const userId = values.get(tokenKey)
      if (!userId || values.has(claimKey)) return null
      values.set(claimKey, userId)
      values.delete(tokenKey)
      return userId
    },
    async restore(tokenKey, claimKey, userId) {
      if (values.get(claimKey) !== userId || values.has(tokenKey)) return false
      values.set(tokenKey, userId)
      values.delete(claimKey)
      return true
    },
  }
}

function createFixture(overrides: {
  readonly available?: boolean
  readonly send?: (input: { to: string; username: string; link: string }) => Promise<boolean>
  readonly update?: (userId: string, passwordHash: string) => Promise<boolean>
  readonly rateLimit?: () => Promise<void>
} = {}) {
  const redis = createRedis()
  let passwordHash = ''
  let securityVersion = 4
  const published: string[] = []
  const sent: Array<{ to: string; username: string; link: string }> = []
  const store: PasswordResetStore = {
    async findByIdentifier(identifier) {
      return identifier === 'cedarz' || identifier === secretEmail
        ? { id: ownerId, email: secretEmail, username: 'cedarz', displayName: '小北' }
        : null
    },
    async setPassword(userId, hash) {
      if (overrides.update) return overrides.update(userId, hash)
      if (userId !== ownerId) return false
      passwordHash = hash
      securityVersion += 1
      return true
    },
  }
  const app = Fastify({ logger: false })
  registerPasswordResetRoutes(app, {
    store,
    redis,
    rateLimit: async () => overrides.rateLimit?.(),
    systemEmailAvailable: overrides.available ?? true,
    publicAppUrl: 'https://gugu.example.test',
    async sendResetEmail(input) {
      sent.push(input)
      return overrides.send ? overrides.send(input) : true
    },
    async publishAuthStateChanged(userId) {
      assert.equal(userId, ownerId)
      assert.equal(securityVersion, 5, '通知运行在凭据提交后')
      published.push(userId)
    },
    createToken: () => resetToken,
  })
  return {
    app,
    redis,
    sent,
    published,
    get passwordHash() { return passwordHash },
    get securityVersion() { return securityVersion },
  }
}

test('password recovery masks known email, preserves enumeration privacy, and respects cooldown', async () => {
  const fixture = createFixture()
  try {
    const known = await fixture.app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email: 'cedarz' } })
    assert.equal(known.statusCode, 200)
    assert.equal(known.json().maskedEmail, 'c***z@example.test')
    assert.equal(known.body.includes(secretEmail), false)
    assert.equal(fixture.sent.length, 1)
    assert.equal(fixture.sent[0]?.to, secretEmail)
    assert.equal(fixture.sent[0]?.username, '小北')
    assert.equal(fixture.sent[0]?.link, `https://gugu.example.test/reset-password?token=${resetToken}`)
    assert.equal(fixture.redis.values.get(`pwdreset:tok:${resetToken}`), ownerId)
    assert.equal(fixture.redis.values.get(`pwdreset:cd:${secretEmail}`), '1')

    const cooldown = await fixture.app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email: secretEmail } })
    assert.equal(cooldown.statusCode, 200)
    assert.equal(cooldown.json().maskedEmail, 'c***z@example.test')
    assert.equal(fixture.sent.length, 1)

    const unknown = await fixture.app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email: 'missing@example.test' } })
    assert.deepEqual(unknown.json(), PASSWORD_RESET_GENERIC)
    assert.equal(unknown.body.includes(secretEmail), false)
  } finally {
    await fixture.app.close()
  }
})

test('failed delivery removes token and cooldown without exposing mail failure', async () => {
  const fixture = createFixture({ send: async () => false })
  try {
    const response = await fixture.app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email: secretEmail } })
    assert.deepEqual(response.json(), PASSWORD_RESET_GENERIC)
    assert.equal(fixture.redis.values.has(`pwdreset:tok:${resetToken}`), false)
    assert.equal(fixture.redis.values.has(`pwdreset:cd:${secretEmail}`), false)
  } finally {
    await fixture.app.close()
  }
})

test('failed token persistence releases the reserved cooldown so a later request can retry', async () => {
  const fixture = createFixture()
  const set = fixture.redis.set.bind(fixture.redis)
  fixture.redis.set = async (key, value, ...options) => {
    if (key.startsWith('pwdreset:tok:')) throw new Error('synthetic redis write failure')
    return set(key, value, ...options)
  }
  try {
    const failed = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email: secretEmail },
    })
    assert.equal(failed.statusCode, 500)
    assert.equal(fixture.redis.values.has(`pwdreset:cd:${secretEmail}`), false)

    fixture.redis.set = set
    const retried = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email: secretEmail },
    })
    assert.equal(retried.statusCode, 200)
    assert.equal(fixture.sent.length, 1)
  } finally {
    await fixture.app.close()
  }
})

test('reset consumes one token, increments security version, notifies after commit, and clears cookies', async () => {
  const fixture = createFixture()
  fixture.redis.values.set(`pwdreset:tok:${resetToken}`, ownerId)
  const claimKey = `pwdreset:claim:${(await import('node:crypto')).createHash('sha256').update(resetToken).digest('hex')}`
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/reset-password',
      payload: { token: resetToken, newPassword: 'synthetic-next-password' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true })
    assert.equal(await bcrypt.compare('synthetic-next-password', fixture.passwordHash), true)
    assert.equal(fixture.securityVersion, 5)
    assert.deepEqual(fixture.published, [ownerId])
    assert.equal(fixture.redis.values.has(`pwdreset:tok:${resetToken}`), false)
    assert.equal(fixture.redis.values.has(claimKey), false)
    assert.match(response.headers['set-cookie']?.toString() ?? '', /Max-Age=0/)

    const replay = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/reset-password',
      payload: { token: resetToken, newPassword: 'synthetic-third-password' },
    })
    assert.equal(replay.statusCode, 400)
    assert.equal(fixture.securityVersion, 5)
  } finally {
    await fixture.app.close()
  }
})

test('failed credential persistence restores the still-valid one-time token', async () => {
  const fixture = createFixture({
    update: async () => { throw new Error('synthetic database failure') },
  })
  fixture.redis.values.set(`pwdreset:tok:${resetToken}`, ownerId)
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/reset-password',
      payload: { token: resetToken, newPassword: 'synthetic-next-password' },
    })
    assert.equal(response.statusCode, 500)
    assert.equal(fixture.redis.values.get(`pwdreset:tok:${resetToken}`), ownerId)
    assert.equal(fixture.published.length, 0)
  } finally {
    await fixture.app.close()
  }
})

test('reset validation and failed closed rate limiting preserve endpoint semantics', async () => {
  const fixture = createFixture({ rateLimit: async () => { throw new RateLimitError('操作过于频繁，请稍后再试', 429) } })
  try {
    const limit = await fixture.app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email: secretEmail } })
    assert.equal(limit.statusCode, 429)

    const shortPassword = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/reset-password', payload: { token: resetToken, newPassword: 'short' },
    })
    assert.equal(shortPassword.statusCode, 400)
    assert.equal(shortPassword.json().detail, '密码至少 8 位')
    assert.equal(maskResetEmail('a@example.test'), '*@example.test')
    assert.equal(maskResetEmail('ab@example.test'), 'a***@example.test')
    assert.equal(maskResetEmail('abc@example.test'), 'a***c@example.test')
    assert.equal(PASSWORD_RESET_TTL_SECONDS, 1800)
  } finally {
    await fixture.app.close()
  }
})
