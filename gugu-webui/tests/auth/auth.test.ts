import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { authenticateUser, extractUserToken, verifyUserToken } from '../../src/domains/auth/auth.js'

const secret = 'synthetic-test-secret-with-sufficient-length'
const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

function token(payload: Record<string, unknown>, signingSecret = secret): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const content = `${header}.${body}`
  const signature = createHmac('sha256', signingSecret).update(content).digest('base64url')
  return `${content}.${signature}`
}

test('accepts a signed user token and defaults legacy security version to one', () => {
  const now = 1_800_000_000_000
  assert.deepEqual(verifyUserToken(token({ sub: userId, role: 'user', exp: now / 1000 + 60 }), secret, now), {
    userId,
    securityVersion: 1,
  })
})

test('rejects expired, wrong-role, malformed, and tampered user tokens', () => {
  const now = 1_800_000_000_000
  const valid = token({ sub: userId, role: 'user', exp: now / 1000 + 60 })
  const [header, body, signature] = valid.split('.')
  const tampered = `${header}.${body}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
  const invalidTokens = [
    token({ sub: userId, role: 'user', exp: now / 1000 - 1 }),
    token({ sub: userId, role: 'admin', exp: now / 1000 + 60 }),
    token({ sub: 'not-a-uuid', role: 'user', exp: now / 1000 + 60 }),
    tampered,
    'not.a.jwt',
  ]
  for (const value of invalidTokens) assert.throws(() => verifyUserToken(value, secret, now), /Token 无效或已过期/)
})

test('rejects invalid or non-integral security versions', () => {
  const now = 1_800_000_000_000
  for (const securityVersion of [0, -1, '1.5', 'invalid']) {
    assert.throws(
      () => verifyUserToken(token({ sub: userId, role: 'user', sv: securityVersion, exp: now / 1000 + 60 }), secret, now),
      /Token 无效或已过期/,
    )
  }
})

test('prefers a Bearer token and does not require CSRF for bearer writes', () => {
  assert.equal(
    extractUserToken({
      method: 'POST',
      authorization: 'Bearer bearer-token',
      cookie: 'gugu_user_access_token=cookie-token',
    }),
    'bearer-token',
  )
})

test('requires a matching CSRF cookie and header for cookie-authenticated writes', () => {
  const request = {
    method: 'PATCH',
    cookie: 'gugu_user_access_token=abc; gugu_user_csrf_token=csrf-value',
    csrfHeader: 'csrf-value',
  }
  assert.equal(extractUserToken(request), 'abc')
  assert.throws(() => extractUserToken({ ...request, csrfHeader: 'different' }), /CSRF 校验失败/)
  assert.throws(() => extractUserToken({ ...request, csrfHeader: undefined }), /CSRF 校验失败/)
})

test('allows safe cookie requests without CSRF and rejects missing credentials', () => {
  assert.equal(
    extractUserToken({ method: 'GET', cookie: 'gugu_user_access_token=abc' }),
    'abc',
  )
  assert.throws(() => extractUserToken({ method: 'GET' }), /未提供认证凭据/)
})

test('requires a live account and matching security version after token verification', async () => {
  const signed = token({ sub: userId, role: 'user', sv: 3, exp: Date.now() / 1000 + 60 })
  const request = { method: 'GET', authorization: `Bearer ${signed}` }
  const active = await authenticateUser(request, secret, async (id) => ({
    id,
    isActive: true,
    accountStatus: 'active',
    securityVersion: 3,
  }))
  assert.equal(active.identity.userId, userId)
  assert.equal(active.user.id, userId)

  for (const user of [
    null,
    { id: userId, isActive: false, securityVersion: 3 },
    { id: userId, isActive: true, accountStatus: 'suspended', securityVersion: 3 },
    { id: userId, isActive: true, accountStatus: 'active', securityVersion: 4 },
  ]) {
    await assert.rejects(
      authenticateUser(request, secret, async () => user),
      /用户不存在或已停用/,
    )
  }
})
