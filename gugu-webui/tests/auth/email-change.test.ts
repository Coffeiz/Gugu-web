import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import Fastify from 'fastify'
import test from 'node:test'
import {
  EMAIL_CHANGE_TTL_SECONDS,
  hashEmailChangeToken,
  normalizeEmailChangeAddress,
  registerEmailChangeUserRoutes,
  registerEmailChangeVerifyRoute,
  type EmailChangeCompletion,
  type EmailChangeOptions,
  type EmailChangeStore,
  type EmailChangeUser,
} from '../../src/domains/auth/email-change.js'
import { RateLimitError } from '../../src/domains/auth/rate-limit.js'

const ownerId = '3c392b91-07b0-4c36-8f7f-1a2c611f7480'
const currentEmail = 'cedarz@example.test'
const newEmail = 'fresh@example.test'
const token = 'synthetic-email-change-token-0123456789'

function createFixture(overrides: {
  readonly emailAvailable?: boolean
  readonly rateLimit?: () => Promise<void>
  readonly sendVerification?: () => Promise<boolean>
} = {}) {
  const passwordHash = bcrypt.hashSync('synthetic-current-password', 4)
  let user: EmailChangeUser = {
    id: ownerId, email: currentEmail, username: 'reset-user', displayName: '小北', passwordHash,
  }
  const requests = new Map<string, { id: number; email: string; expiresAt: Date; used: boolean; revoked: boolean }>()
  const sent: Array<{ to: string; username: string; link: string }> = []
  const notices: Array<{ to: string; kind: 'requested' | 'completed' }> = []
  const published: string[] = []
  const occupied = new Set(['occupied@example.test'])
  const store: EmailChangeStore = {
    async findUser(userId) { return userId === ownerId ? user : null },
    async emailOccupied(email) { return occupied.has(email) || email === currentEmail },
    async createRequest(_userId, email, tokenHash, expiresAt) {
      for (const pending of requests.values()) if (!pending.used) pending.revoked = true
      requests.set(tokenHash, { id: requests.size + 1, email, expiresAt, used: false, revoked: false })
    },
    async activeRequest() {
      const pending = [...requests.values()].find((request) => !request.used && !request.revoked)
      return pending ? { id: pending.id, email: pending.email, expiresAt: pending.expiresAt } : null
    },
    async replaceActiveToken(_userId, tokenHash, expiresAt) {
      const entry = [...requests.entries()].find(([, request]) => !request.used && !request.revoked)
      if (!entry) return null
      const [oldHash, request] = entry
      requests.delete(oldHash)
      request.expiresAt = expiresAt
      requests.set(tokenHash, request)
      return { id: request.id, email: request.email, expiresAt }
    },
    async revokeActive() {
      for (const request of requests.values()) if (!request.used) request.revoked = true
    },
    async completeToken(tokenHash): Promise<EmailChangeCompletion> {
      const request = requests.get(tokenHash)
      if (!request || request.used || request.revoked || request.expiresAt.getTime() <= Date.now())
        return { kind: 'invalid' }
      if (occupied.has(request.email)) return { kind: 'occupied' }
      user = { ...user, email: request.email }
      request.used = true
      for (const other of requests.values()) if (other !== request && !other.used) other.revoked = true
      return { kind: 'completed', user }
    },
  }
  const options: EmailChangeOptions = {
    store,
    async rateLimit() { await overrides.rateLimit?.() },
    systemEmailAvailable: overrides.emailAvailable ?? true,
    publicAppUrl: 'https://gugu.example.test',
    mail: {
      async sendVerification(input) {
        sent.push(input)
        return overrides.sendVerification ? overrides.sendVerification() : true
      },
      async sendNotice({ to, kind }) { notices.push({ to, kind }); return true },
    },
    async publishAuthStateChanged(userId) { published.push(userId) },
    createToken: () => token,
  }
  const app = Fastify({ logger: false })
  registerEmailChangeUserRoutes(app, { ...options, ownerIdFromRequest: () => ownerId })
  registerEmailChangeVerifyRoute(app, options)
  return {
    app, store, requests, sent, notices, published,
    get user() { return user },
  }
}

test('email change requires the current password and preserves the current login email until verification', async () => {
  const fixture = createFixture()
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/email-change/request',
      payload: { newEmail: `  ${newEmail.toUpperCase()} `, currentPassword: 'synthetic-current-password' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, email: 'fr***@example.test' })
    assert.equal(fixture.user.email, currentEmail)
    assert.equal(fixture.sent[0]?.to, newEmail)
    assert.equal(fixture.sent[0]?.link, `https://gugu.example.test/verify-email-change?token=${token}`)
    assert.deepEqual(fixture.notices, [{ to: currentEmail, kind: 'requested' }])
    const tokenHash = hashEmailChangeToken(token)
    assert.ok(fixture.requests.has(tokenHash))
    assert.notEqual(tokenHash, token)
  } finally {
    await fixture.app.close()
  }
})

test('invalid password, occupied address and malformed address are rejected before creating a request', async () => {
  const fixture = createFixture()
  try {
    const wrongPassword = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/email-change/request',
      payload: { newEmail, currentPassword: 'wrong-password' },
    })
    assert.equal(wrongPassword.statusCode, 400)
    assert.equal(wrongPassword.json().detail, '当前密码错误')
    const occupied = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/email-change/request',
      payload: { newEmail: 'occupied@example.test', currentPassword: 'synthetic-current-password' },
    })
    assert.equal(occupied.statusCode, 409)
    const invalid = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/email-change/request',
      payload: { newEmail: '小北 <bad@example.test>', currentPassword: 'synthetic-current-password' },
    })
    assert.equal(invalid.statusCode, 400)
    assert.equal(fixture.requests.size, 0)
    assert.equal(fixture.sent.length, 0)
  } finally {
    await fixture.app.close()
  }
})

test('resend rotates the token, cancel revokes the request, and expired requests cannot be resent', async () => {
  const fixture = createFixture()
  const previousToken = 'synthetic-previous-email-change-token-0123456789'
  try {
    await fixture.store.createRequest(ownerId, newEmail, hashEmailChangeToken(previousToken), new Date(Date.now() + 60_000))
    const resent = await fixture.app.inject({ method: 'POST', url: '/api/v1/auth/email-change/resend' })
    assert.equal(resent.statusCode, 200)
    assert.equal(fixture.sent.length, 1)
    assert.equal(fixture.sent[0]?.link, `https://gugu.example.test/verify-email-change?token=${token}`)
    assert.equal(fixture.requests.has(hashEmailChangeToken(previousToken)), false)
    assert.equal(fixture.requests.has(hashEmailChangeToken(token)), true)

    const canceled = await fixture.app.inject({ method: 'POST', url: '/api/v1/auth/email-change/cancel' })
    assert.equal(canceled.statusCode, 200)
    const verify = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/email-change/verify', payload: { token: previousToken },
    })
    assert.equal(verify.statusCode, 400)
    assert.equal(fixture.user.email, currentEmail)

    await fixture.store.createRequest(ownerId, newEmail, hashEmailChangeToken(previousToken), new Date(Date.now() - 1_000))
    const expired = await fixture.app.inject({ method: 'POST', url: '/api/v1/auth/email-change/resend' })
    assert.equal(expired.statusCode, 400)
  } finally {
    await fixture.app.close()
  }
})

test('verification changes the email once, publishes auth invalidation, and sends a security notice', async () => {
  const fixture = createFixture()
  await fixture.store.createRequest(ownerId, newEmail, hashEmailChangeToken(token), new Date(Date.now() + 60_000))
  try {
    const verified = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/email-change/verify', payload: { token },
    })
    assert.equal(verified.statusCode, 200)
    assert.deepEqual(verified.json(), { ok: true, message: '邮箱已变更' })
    assert.equal(fixture.user.email, newEmail)
    assert.deepEqual(fixture.published, [ownerId])
    assert.deepEqual(fixture.notices, [{ to: newEmail, kind: 'completed' }])
    const replay = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/email-change/verify', payload: { token },
    })
    assert.equal(replay.statusCode, 400)
  } finally {
    await fixture.app.close()
  }
})

test('email-change capability and rate limits fail before side effects', async () => {
  const unavailable = createFixture({ emailAvailable: false })
  try {
    const response = await unavailable.app.inject({
      method: 'POST', url: '/api/v1/auth/email-change/request',
      payload: { newEmail, currentPassword: 'synthetic-current-password' },
    })
    assert.equal(response.statusCode, 503)
    assert.equal(unavailable.sent.length, 0)
  } finally {
    await unavailable.app.close()
  }

  const limited = createFixture({ rateLimit: async () => { throw new RateLimitError('操作过于频繁，请稍后再试', 429) } })
  try {
    const response = await limited.app.inject({
      method: 'POST', url: '/api/v1/auth/email-change/request',
      payload: { newEmail, currentPassword: 'synthetic-current-password' },
    })
    assert.equal(response.statusCode, 429)
    assert.equal(limited.sent.length, 0)
  } finally {
    await limited.app.close()
  }
})

test('email normalization and token hashing match the existing account-security contract', () => {
  assert.equal(normalizeEmailChangeAddress('  User@Example.com '), 'user@example.com')
  assert.equal(normalizeEmailChangeAddress('display <user@example.com>'), null)
  assert.equal(normalizeEmailChangeAddress('x'.repeat(300) + '@example.test'), null)
  assert.equal(hashEmailChangeToken(token).length, 64)
  assert.equal(EMAIL_CHANGE_TTL_SECONDS, 1800)
})
