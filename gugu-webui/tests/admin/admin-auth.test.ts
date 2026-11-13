import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { AdminAuthError, createAdminAuthAdapter } from '../../src/domains/admin/admin-auth.js'

const secret = 'synthetic-admin-auth-secret-with-enough-entropy'
const fixedNow = 1_800_000_000_000

function signToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const content = `${header}.${claims}`
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`
}

function responseCookies(response: { headers: { 'set-cookie'?: string | string[] } }): string[] {
  const value = response.headers['set-cookie']
  return Array.isArray(value) ? value : value ? [value] : []
}

function cookiePair(cookie: string): string {
  return cookie.split(';', 1)[0]!
}

function createFixture() {
  let version = 0
  let failRead = false
  let failIncrement = false
  let limited = false
  let denyHost = false
  const limits: Array<[string, number, number]> = []
  const audits: Array<[string, string]> = []
  const app = Fastify({ logger: false })
  const adapter = createAdminAuthAdapter({
    username: 'admin-example',
    password: 'synthetic-admin-password',
    secret,
    tokenExpiresMinutes: 60,
    now: () => fixedNow,
    async getAuthVersion() {
      if (failRead) throw new Error('synthetic Redis GET failure')
      return version
    },
    async incrementAuthVersion() {
      if (failIncrement) throw new Error('synthetic Redis INCR failure')
      version += 1
      return version
    },
    async rateLimit(_request, bucket, limit, windowSeconds) {
      limits.push([bucket, limit, windowSeconds])
      if (limited) throw new AdminAuthError('操作过于频繁，请稍后再试', 429)
    },
    async hostGuard(_request: FastifyRequest, reply: FastifyReply) {
      if (denyHost) reply.code(404).send({ detail: 'Not Found' })
    },
    async audit(username, _action, detail) {
      audits.push([username, detail])
    },
  })
  adapter.registerRoutes(app)
  app.get('/api/v1/admin/protected', { preHandler: adapter.requireAdmin }, async (request) => ({
    username: request.adminIdentity?.username,
  }))
  return {
    app,
    adapter,
    limits,
    audits,
    get version() { return version },
    set failRead(value: boolean) { failRead = value },
    set failIncrement(value: boolean) { failIncrement = value },
    set limited(value: boolean) { limited = value },
    set denyHost(value: boolean) { denyHost = value },
  }
}

test('admin login issues av token and independent cookies; logout invalidates all prior tokens', async () => {
  const fixture = createFixture()
  try {
    const login = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    assert.equal(login.statusCode, 200)
    assert.deepEqual(login.json().user, { username: 'admin-example', role: 'superadmin' })
    assert.equal(login.json().token_type, 'bearer')
    assert.deepEqual(fixture.limits, [['adminlogin', 10, 300]])
    assert.deepEqual(fixture.audits, [['admin-example', '登录成功']])
    const token = login.json().access_token as string
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))
    assert.equal(claims.role, 'superadmin')
    assert.equal(claims.av, 0)

    const cookies = responseCookies(login)
    assert.equal(cookies.length, 2)
    assert.match(cookies[0]!, /^gugu_admin_access_token=.*HttpOnly/)
    assert.match(cookies[1]!, /^gugu_admin_csrf_token=/)
    assert.doesNotMatch(cookies[1]!, /HttpOnly/)

    const me = await fixture.app.inject({
      method: 'GET', url: '/api/v1/admin/auth/me', headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(me.statusCode, 200)
    assert.deepEqual(me.json(), { username: 'admin-example', role: 'superadmin' })

    const logout = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/logout', headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(logout.statusCode, 200)
    assert.deepEqual(logout.json(), { ok: true })
    assert.equal(fixture.version, 1)
    assert.ok(responseCookies(logout).every((cookie) => /Max-Age=0/.test(cookie)))

    const revoked = await fixture.app.inject({
      method: 'GET', url: '/api/v1/admin/auth/me', headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(revoked.statusCode, 401)
    assert.deepEqual(revoked.json(), { detail: 'Token 无效或已撤销' })
  } finally {
    await fixture.app.close()
  }
})

test('cookie admin sessions require CSRF on logout and cookie transport omits the token body', async () => {
  const fixture = createFixture()
  try {
    const login = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login',
      headers: { 'x-auth-transport': 'cookie' },
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    assert.equal(login.statusCode, 200)
    assert.deepEqual(login.json(), { user: { username: 'admin-example', role: 'superadmin' } })
    const setCookies = responseCookies(login)
    const cookieHeader = setCookies.map(cookiePair).join('; ')
    const csrf = cookieHeader.match(/gugu_admin_csrf_token=([^;]+)/)?.[1]
    assert.ok(csrf)

    const me = await fixture.app.inject({
      method: 'GET', url: '/api/v1/admin/auth/me', headers: { cookie: cookieHeader },
    })
    assert.equal(me.statusCode, 200)

    const denied = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/logout', headers: { cookie: cookieHeader },
    })
    assert.equal(denied.statusCode, 403)
    assert.deepEqual(denied.json(), { detail: 'CSRF 校验失败' })
    assert.equal(fixture.version, 0)

    const allowed = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/logout',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrf },
    })
    assert.equal(allowed.statusCode, 200)
    assert.equal(fixture.version, 1)
  } finally {
    await fixture.app.close()
  }
})

test('admin login rejects missing configuration, invalid credentials, rate limits, and version-store outages', async () => {
  const fixture = createFixture()
  try {
    fixture.limited = true
    const rateLimited = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'admin-example', password: 'wrong' },
    })
    assert.equal(rateLimited.statusCode, 429)
    fixture.limited = false

    const wrongPassword = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'admin-example', password: 'wrong' },
    })
    assert.equal(wrongPassword.statusCode, 401)
    assert.deepEqual(fixture.audits, [['admin-example', '登录失败：用户名或密码错误']])

    const validLogin = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    assert.equal(validLogin.statusCode, 200)
    const validToken = validLogin.json().access_token as string
    fixture.failRead = true
    const versionReadFailed = await fixture.app.inject({
      method: 'GET', url: '/api/v1/admin/auth/me', headers: { authorization: `Bearer ${validToken}` },
    })
    assert.equal(versionReadFailed.statusCode, 503)
    assert.deepEqual(versionReadFailed.json(), { detail: '管理员认证服务暂不可用' })
    const loginReadFailed = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    assert.equal(loginReadFailed.statusCode, 503)
    assert.deepEqual(loginReadFailed.json(), { detail: '管理员认证服务暂不可用' })
  } finally {
    await fixture.app.close()
  }

  const unconfigured = createAdminAuthAdapter({
    password: '', secret, tokenExpiresMinutes: 60,
    getAuthVersion: async () => 0, incrementAuthVersion: async () => 1,
    rateLimit: async () => {},
    hostGuard: async () => {},
  })
  const app = Fastify({ logger: false })
  unconfigured.registerRoutes(app)
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'admin', password: 'anything' },
    })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { detail: '管理员密码未配置，请先设置 ADMIN_PASSWORD' })
  } finally {
    await app.close()
  }
})

test('admin and superadmin roles are accepted, user tokens are denied, and Redis failures return 503', async () => {
  const fixture = createFixture()
  try {
    const adminToken = signToken({
      sub: 'legacy-admin', role: 'admin', av: 0, exp: fixedNow / 1000 + 60, iat: fixedNow / 1000,
    })
    const legacyAdmin = await fixture.app.inject({
      method: 'GET', url: '/api/v1/admin/auth/me', headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(legacyAdmin.statusCode, 200)
    assert.deepEqual(legacyAdmin.json(), { username: 'legacy-admin', role: 'admin' })
    const protectedRoute = await fixture.app.inject({
      method: 'GET', url: '/api/v1/admin/protected', headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(protectedRoute.statusCode, 200)
    assert.deepEqual(protectedRoute.json(), { username: 'legacy-admin' })

    const userToken = signToken({
      sub: 'someone', role: 'user', av: 0, exp: fixedNow / 1000 + 60, iat: fixedNow / 1000,
    })
    const deniedRole = await fixture.app.inject({
      method: 'GET', url: '/api/v1/admin/auth/me', headers: { authorization: `Bearer ${userToken}` },
    })
    assert.equal(deniedRole.statusCode, 403)
    assert.deepEqual(deniedRole.json(), { detail: '权限不足' })

    const expiredToken = signToken({
      sub: 'admin-example', role: 'admin', av: 0, exp: fixedNow / 1000 - 1, iat: fixedNow / 1000 - 61,
    })
    const expired = await fixture.app.inject({
      method: 'GET', url: '/api/v1/admin/auth/me', headers: { authorization: `Bearer ${expiredToken}` },
    })
    assert.equal(expired.statusCode, 401)

    fixture.failIncrement = true
    const login = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    const token = login.json().access_token as string
    const unavailable = await fixture.app.inject({
      method: 'POST', url: '/api/v1/admin/auth/logout', headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(unavailable.statusCode, 503)
    assert.deepEqual(unavailable.json(), { detail: '管理员认证服务暂不可用' })
    assert.deepEqual(responseCookies(unavailable), [])

    fixture.denyHost = true
    const hidden = await fixture.app.inject({
      method: 'GET', url: '/api/v1/admin/auth/me', headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(hidden.statusCode, 404)
  } finally {
    await fixture.app.close()
  }
})
