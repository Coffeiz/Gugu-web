import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import test from 'node:test'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type { PublicUserRecord } from '../../src/domains/auth/auth.js'
import { verifyUserToken } from '../../src/domains/auth/auth.js'
import { RegistrationRequestError, registerUserRoute } from '../../src/domains/auth/routes/auth-register.js'

const secret = 'synthetic-register-test-secret-with-enough-entropy'
const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

function createdUser(overrides: Partial<PublicUserRecord> = {}): PublicUserRecord {
  return {
    id: userId,
    username: 'moon_小北',
    displayName: 'moon_小北',
    email: 'new@example.test',
    isActive: true,
    accountStatus: 'active',
    securityVersion: 1,
    avatarUrl: null,
    createdAt: '2026-11-13T12:30:00+00:00',
    timezone: null,
    emailSubscribed: true,
    imChannels: [],
    ...overrides,
  }
}

interface FixtureOptions {
  verificationRequired?: boolean
  duplicate?: boolean
  invalidCode?: boolean
  failCodeCheck?: boolean
  failRateLimit?: boolean
  failRegistration?: boolean
  failSeed?: boolean
}

function createFixture(options: FixtureOptions = {}) {
  const calls: string[] = []
  const rateLimits: Array<Record<string, unknown>> = []
  let savedInput: Record<string, unknown> | undefined
  let savedVerification: Record<string, unknown> | null | undefined
  let savedPasswordHash: string | undefined
  const app: FastifyInstance = Fastify({ logger: false })

  registerUserRoute(app, {
    secret,
    verificationRequired: options.verificationRequired ?? true,
    async rateLimit(request: FastifyRequest, limits) {
      calls.push('rateLimit')
      rateLimits.push({ ...limits })
      assert.equal(request.method, 'POST')
      if (options.failRateLimit) throw new RegistrationRequestError('注册服务暂不可用，请稍后重试', 503)
    },
    async userExists(username, email) {
      calls.push('userExists')
      assert.equal(username, 'moon_小北')
      assert.equal(email, 'new@example.test')
      return options.duplicate ?? false
    },
    async verifyRegistrationCode(email, code) {
      calls.push('verifyCode')
      assert.equal(email, 'new@example.test')
      assert.equal(code, '123456')
      if (options.failCodeCheck) throw new Error('synthetic Redis failure')
      return !(options.invalidCode ?? false)
    },
    async registerUser(input, verification) {
      calls.push('registerUser')
      savedInput = input as unknown as Record<string, unknown>
      savedVerification = verification as unknown as Record<string, unknown> | null
      savedPasswordHash = input.hashedPassword
      if (options.failRegistration) throw new Error('synthetic persistence failure')
      return createdUser()
    },
    async seedUser(user, locale) {
      calls.push('seedUser')
      assert.equal(user.id, userId)
      assert.equal(locale, 'zh-CN')
      if (options.failSeed) throw new Error('synthetic onboarding seed failure')
    },
  })

  return {
    app,
    calls,
    rateLimits,
    get savedInput() { return savedInput },
    get savedVerification() { return savedVerification },
    get savedPasswordHash() { return savedPasswordHash },
  }
}

const verifiedRegistration = {
  username: 'moon_小北',
  email: '  NEW@Example.Test ',
  password: 'Synthetic-password-123',
  locale: 'zh-CN',
  emailSubscribed: true,
  verificationCode: '123456',
}

test('verified registration normalizes the email, commits with the code, then issues the user token and cookies', async () => {
  const fixture = createFixture()
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/register', payload: verifiedRegistration,
    })
    assert.equal(response.statusCode, 201)
    assert.equal(response.json().access_token && typeof response.json().access_token, 'string')
    assert.equal(response.json().token_type, 'bearer')
    assert.deepEqual(response.json().user, {
      id: userId,
      username: 'moon_小北',
      display_name: 'moon_小北',
      email: 'new@example.test',
      is_active: true,
      avatar_url: null,
      created_at: '2026-11-13',
      im_channels: [],
      timezone: null,
      email_subscribed: true,
    })
    assert.deepEqual(fixture.calls, ['rateLimit', 'userExists', 'verifyCode', 'registerUser', 'seedUser'])
    assert.deepEqual(fixture.rateLimits, [{
      bucket: 'register', limit: 10, windowSeconds: 3600,
      deviceLimit: 5, deviceWindowSeconds: 86400, failClosed: true,
    }])
    assert.equal(fixture.savedInput?.email, 'new@example.test')
    assert.equal(fixture.savedInput?.username, 'moon_小北')
    assert.equal(fixture.savedInput?.displayName, 'moon_小北')
    assert.equal(fixture.savedInput?.emailSubscribed, true)
    assert.equal(await bcrypt.compare('Synthetic-password-123', fixture.savedPasswordHash!), true)
    assert.deepEqual(fixture.savedVerification, { email: 'new@example.test', code: '123456' })

    const token = response.json().access_token as string
    assert.deepEqual(verifyUserToken(token, secret).userId, userId)
    const setCookie = response.headers['set-cookie']
    assert.ok(setCookie)
    const cookies = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie
    assert.match(cookies, /gugu_user_access_token=.*HttpOnly/)
    assert.match(cookies, /gugu_user_csrf_token=/)
  } finally {
    await fixture.app.close()
  }
})

test('duplicate username or email is rejected before code verification and registration persistence', async () => {
  const fixture = createFixture({ duplicate: true })
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/register', payload: verifiedRegistration,
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { detail: '用户名或邮箱已被注册' })
    assert.deepEqual(fixture.calls, ['rateLimit', 'userExists'])
  } finally {
    await fixture.app.close()
  }
})

test('required registration code must be present, valid, and checked through the Redis port', async () => {
  const missing = createFixture()
  try {
    const response = await missing.app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { ...verifiedRegistration, verificationCode: undefined },
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { detail: '请先完成邮箱验证码验证' })
    assert.deepEqual(missing.calls, ['rateLimit', 'userExists'])
  } finally {
    await missing.app.close()
  }

  const invalid = createFixture({ invalidCode: true })
  try {
    const response = await invalid.app.inject({
      method: 'POST', url: '/api/v1/auth/register', payload: verifiedRegistration,
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { detail: '验证码错误或已过期' })
    assert.deepEqual(invalid.calls, ['rateLimit', 'userExists', 'verifyCode'])
  } finally {
    await invalid.app.close()
  }

  const unavailable = createFixture({ failCodeCheck: true })
  try {
    const response = await unavailable.app.inject({
      method: 'POST', url: '/api/v1/auth/register', payload: verifiedRegistration,
    })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { detail: '验证码服务暂不可用，请稍后重试' })
    assert.deepEqual(unavailable.calls, ['rateLimit', 'userExists', 'verifyCode'])
  } finally {
    await unavailable.app.close()
  }
})

test('disabled verification skips code checking but still persists a hashed password and seeds after commit', async () => {
  const fixture = createFixture({ verificationRequired: false })
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: {
        username: 'moon_小北', email: 'new@example.test', password: 'Synthetic-password-123',
        locale: 'zh-CN', emailSubscribed: false,
      },
    })
    assert.equal(response.statusCode, 201)
    assert.deepEqual(fixture.calls, ['rateLimit', 'userExists', 'registerUser', 'seedUser'])
    assert.equal(fixture.savedVerification, null)
    assert.equal(fixture.savedInput?.emailSubscribed, false)
    assert.equal(await bcrypt.compare('Synthetic-password-123', fixture.savedPasswordHash!), true)
  } finally {
    await fixture.app.close()
  }
})

test('invalid registration fields and rate limits fail before creating an account', async () => {
  const invalidEmail = createFixture({ verificationRequired: false })
  try {
    const response = await invalidEmail.app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { ...verifiedRegistration, email: 'not-an-email' },
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { detail: '请输入有效的邮箱地址' })
    assert.deepEqual(invalidEmail.calls, ['rateLimit'])
  } finally {
    await invalidEmail.app.close()
  }

  const invalidDto = createFixture()
  try {
    const response = await invalidDto.app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { ...verifiedRegistration, verificationCode: 'wrong' },
    })
    assert.equal(response.statusCode, 422)
    assert.deepEqual(invalidDto.calls, [])
  } finally {
    await invalidDto.app.close()
  }

  const limited = createFixture({ failRateLimit: true })
  try {
    const response = await limited.app.inject({
      method: 'POST', url: '/api/v1/auth/register', payload: verifiedRegistration,
    })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { detail: '注册服务暂不可用，请稍后重试' })
    assert.deepEqual(limited.calls, ['rateLimit'])
  } finally {
    await limited.app.close()
  }
})

test('registration persistence errors do not issue a success token', async () => {
  const fixture = createFixture({ verificationRequired: false, failRegistration: true })
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: {
        username: 'moon_小北', email: 'new@example.test', password: 'Synthetic-password-123',
        locale: 'zh-CN',
      },
    })
    assert.equal(response.statusCode, 500)
    assert.equal(response.json().access_token, undefined)
    assert.deepEqual(fixture.calls, ['rateLimit', 'userExists', 'registerUser'])
  } finally {
    await fixture.app.close()
  }
})

test('best-effort onboarding failure does not undo registration or suppress the authenticated session', async () => {
  const fixture = createFixture({ verificationRequired: false, failSeed: true })
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'x-auth-transport': 'cookie', 'x-forwarded-proto': 'https' },
      payload: {
        username: 'moon_小北', email: 'new@example.test', password: 'Synthetic-password-123',
        locale: 'zh-CN',
      },
    })
    assert.equal(response.statusCode, 201)
    assert.equal(response.json().access_token, null)
    assert.deepEqual(verifyUserToken(response.headers['set-cookie']?.toString().match(/gugu_user_access_token=([^;]+)/)?.[1] ?? '', secret), {
      userId,
      securityVersion: 1,
    })
    assert.deepEqual(fixture.calls, ['rateLimit', 'userExists', 'registerUser', 'seedUser'])
  } finally {
    await fixture.app.close()
  }
})
