import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { RateLimitError } from '../../src/domains/auth/rate-limit.js'
import { registerRegistrationCodeRoute } from '../../src/domains/auth/routes/auth-registration-code.js'

const code = '042731'

interface FixtureOptions {
  enabled?: boolean
  emailAvailable?: boolean
  occupied?: boolean
  cooldown?: boolean
  reserveFailure?: boolean
  sendResult?: boolean
  sendFailure?: boolean
  clearFailure?: boolean
  rateLimitFailure?: RateLimitError
  missingCodeStore?: boolean
  missingSender?: boolean
}

function makeFixture(options: FixtureOptions = {}) {
  const app: FastifyInstance = Fastify({ logger: false })
  const calls: string[] = []
  const limits: Array<Record<string, unknown>> = []
  const sentCodes: Array<[string, string]> = []
  const clearedEmails: string[] = []
  const codeStore = {
    createCode() {
      calls.push('createCode')
      return code
    },
    async reserve(email: string, value: string) {
      calls.push('reserve')
      assert.equal(email, 'person@example.test')
      assert.equal(value, code)
      if (options.reserveFailure) throw new Error('synthetic Redis failure')
      return !(options.cooldown ?? false)
    },
    async clear(email: string) {
      calls.push('clear')
      clearedEmails.push(email)
      if (options.clearFailure) throw new Error('synthetic Redis cleanup failure')
    },
  }
  const sendRegistrationVerification = async (email: string, value: string) => {
    calls.push('sendRegistrationVerification')
    sentCodes.push([email, value])
    if (options.sendFailure) throw new Error('synthetic SMTP failure')
    return options.sendResult ?? true
  }
  registerRegistrationCodeRoute(app, {
    registrationVerificationEnabled: options.enabled ?? true,
    systemEmailAvailable: options.emailAvailable ?? true,
    async rateLimit(request: FastifyRequest, value) {
      calls.push('rateLimit')
      limits.push({ ...value })
      assert.equal(request.method, 'POST')
      if (options.rateLimitFailure) throw options.rateLimitFailure
    },
    async emailIsOccupied(email) {
      calls.push('emailIsOccupied')
      assert.equal(email, 'person@example.test')
      return options.occupied ?? false
    },
    ...(options.missingCodeStore ? {} : { codeStore }),
    ...(options.missingSender ? {} : { sendRegistrationVerification }),
  })
  return { app, calls, limits, sentCodes, clearedEmails }
}

test('registration-code sends only after fail-closed limit, capability, email and Redis reservation checks', async () => {
  const fixture = makeFixture()
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/registration-code',
      headers: { 'x-device-id': 'synthetic-device-id-0001' },
      payload: { email: ' Person@Example.Test ' },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true })
    assert.deepEqual(fixture.calls, [
      'rateLimit', 'emailIsOccupied', 'createCode', 'reserve', 'sendRegistrationVerification',
    ])
    assert.deepEqual(fixture.limits, [{
      bucket: 'register-code', limit: 5, windowSeconds: 3600,
      deviceLimit: 3, deviceWindowSeconds: 3600, failClosed: true,
    }])
    assert.deepEqual(fixture.sentCodes, [['person@example.test', code]])
  } finally {
    await fixture.app.close()
  }
})

test('registration-code hides occupied emails and active cooldowns with the same success response', async () => {
  for (const options of [{ occupied: true }, { cooldown: true }]) {
    const fixture = makeFixture(options)
    try {
      const response = await fixture.app.inject({
        method: 'POST', url: '/api/v1/auth/registration-code',
        payload: { email: 'person@example.test' },
      })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), { ok: true })
      assert.deepEqual(fixture.sentCodes, [])
      assert.ok(!fixture.calls.includes('sendRegistrationVerification'))
      if (options.occupied) assert.ok(!fixture.calls.includes('createCode'))
      if (options.cooldown) assert.ok(!fixture.calls.includes('sendRegistrationVerification'))
    } finally {
      await fixture.app.close()
    }
  }
})

test('registration-code returns unavailable when verification or system SMTP is disabled', async () => {
  for (const options of [{ enabled: false }, { emailAvailable: false }]) {
    const fixture = makeFixture(options)
    try {
      const response = await fixture.app.inject({
        method: 'POST', url: '/api/v1/auth/registration-code',
        payload: { email: 'person@example.test' },
      })
      assert.equal(response.statusCode, 503)
      assert.deepEqual(response.json(), { detail: '邮箱验证码注册当前不可用' })
      assert.deepEqual(fixture.calls, ['rateLimit'])
    } finally {
      await fixture.app.close()
    }
  }
})

test('enabled registration-code capability fails closed when Redis store or SMTP sender is missing', async () => {
  const cases = [
    { options: { missingCodeStore: true }, detail: '验证码服务暂不可用，请稍后重试' },
    { options: { missingSender: true }, detail: '邮箱验证码注册当前不可用' },
    { options: { missingCodeStore: true, missingSender: true }, detail: '验证码服务暂不可用，请稍后重试' },
  ] as const

  for (const scenario of cases) {
    const fixture = makeFixture(scenario.options)
    try {
      const response = await fixture.app.inject({
        method: 'POST', url: '/api/v1/auth/registration-code',
        payload: { email: 'person@example.test' },
      })
      assert.equal(response.statusCode, 503)
      assert.deepEqual(response.json(), { detail: scenario.detail })
      assert.deepEqual(fixture.calls, ['rateLimit'])
      assert.deepEqual(fixture.sentCodes, [])
      assert.deepEqual(fixture.clearedEmails, [])
    } finally {
      await fixture.app.close()
    }
  }

  const disabledAndMissing = makeFixture({
    enabled: false,
    missingCodeStore: true,
    missingSender: true,
  })
  try {
    const response = await disabledAndMissing.app.inject({
      method: 'POST', url: '/api/v1/auth/registration-code',
      payload: { email: 'person@example.test' },
    })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { detail: '邮箱验证码注册当前不可用' })
    assert.deepEqual(disabledAndMissing.calls, ['rateLimit'])
  } finally {
    await disabledAndMissing.app.close()
  }
})

test('registration-code fails closed for Redis reservation or SMTP delivery and clears failed delivery state', async () => {
  const unavailableRedis = makeFixture({ reserveFailure: true })
  try {
    const response = await unavailableRedis.app.inject({
      method: 'POST', url: '/api/v1/auth/registration-code',
      payload: { email: 'person@example.test' },
    })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { detail: '验证码服务暂不可用，请稍后重试' })
    assert.deepEqual(unavailableRedis.calls, ['rateLimit', 'emailIsOccupied', 'createCode', 'reserve'])
  } finally {
    await unavailableRedis.app.close()
  }

  for (const options of [{ sendResult: false, clearFailure: true }, { sendFailure: true }]) {
    const failedSend = makeFixture(options)
    try {
      const response = await failedSend.app.inject({
        method: 'POST', url: '/api/v1/auth/registration-code',
        payload: { email: 'person@example.test' },
      })
      assert.equal(response.statusCode, 503)
      assert.deepEqual(response.json(), { detail: '验证码邮件发送失败，请稍后重试' })
      assert.deepEqual(failedSend.clearedEmails, ['person@example.test'])
    } finally {
      await failedSend.app.close()
    }
  }
})

test('registration-code preserves rate-limit status and rejects malformed email fields before effects', async () => {
  const limited = makeFixture({ rateLimitFailure: new RateLimitError('操作过于频繁，请稍后再试', 429) })
  try {
    const response = await limited.app.inject({
      method: 'POST', url: '/api/v1/auth/registration-code',
      payload: { email: 'person@example.test' },
    })
    assert.equal(response.statusCode, 429)
    assert.deepEqual(response.json(), { detail: '操作过于频繁，请稍后再试' })
    assert.deepEqual(limited.calls, ['rateLimit'])
  } finally {
    await limited.app.close()
  }

  const malformed = makeFixture()
  try {
    const response = await malformed.app.inject({
      method: 'POST', url: '/api/v1/auth/registration-code',
      payload: { email: 'x' },
    })
    assert.equal(response.statusCode, 422)
    assert.deepEqual(malformed.calls, [])
  } finally {
    await malformed.app.close()
  }
})
