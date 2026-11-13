import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { createUserToken, verifyUserToken } from '../../src/domains/auth/auth.js'
import { registerLogoutRoute } from '../../src/domains/auth/routes/auth-logout.js'

const secret = 'synthetic-logout-secret-with-enough-entropy'
const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

function createApp(options: { publish?: (id: string) => Promise<void> } = {}) {
  const versions = new Map([[userId, 4]])
  const oldToken = createUserToken(userId, 4, secret)
  let published = false
  const app = Fastify({ logger: false })

  registerLogoutRoute(app, {
    async authenticate(request: FastifyRequest, reply: FastifyReply) {
      const authorization = request.headers.authorization
      if (!authorization?.startsWith('Bearer ')) {
        reply.code(401).send({ detail: '未提供认证凭据' })
        return null
      }
      try {
        const identity = verifyUserToken(authorization.slice(7), secret)
        if (versions.get(identity.userId) !== identity.securityVersion) {
          reply.code(401).send({ detail: '用户不存在或已停用' })
          return null
        }
        return { id: identity.userId }
      } catch {
        reply.code(401).send({ detail: 'Token 无效或已过期' })
        return null
      }
    },
    async revokeUserSessions(id) {
      versions.set(id, (versions.get(id) ?? 0) + 1)
    },
    async publishAuthStateChanged(id) {
      published = true
      await options.publish?.(id)
    },
  })
  return { app, oldToken, versions, wasPublished: () => published }
}

test('logout revokes the submitted version, publishes only after revocation, and clears both auth cookies', async () => {
  let publishedVersion: number | undefined
  const fixture = createApp({
    async publish(id) {
      publishedVersion = fixture.versions.get(id)
    },
  })
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/logout',
      headers: {
        authorization: `Bearer ${fixture.oldToken}`,
        cookie: 'gugu_user_access_token=old; gugu_user_csrf_token=csrf',
      },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true })
    assert.equal(fixture.versions.get(userId), 5)
    assert.equal(publishedVersion, 5)
    assert.equal(fixture.wasPublished(), true)
    const revoked = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${fixture.oldToken}` },
    })
    assert.equal(revoked.statusCode, 401)
    assert.equal(fixture.versions.get(userId), 5)
    assert.equal(verifyUserToken(createUserToken(userId, 5, secret), secret).securityVersion, 5)
    const setCookie = response.headers['set-cookie']
    assert.ok(setCookie)
    const clearedCookies = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie
    assert.match(clearedCookies, /gugu_user_access_token=; Max-Age=0/)
    assert.match(clearedCookies, /gugu_user_csrf_token=; Max-Age=0/)
  } finally {
    await fixture.app.close()
  }
})

test('logout remains successful and revoked when the auth state notification fails', async () => {
  const fixture = createApp({ async publish() { throw new Error('synthetic Redis failure') } })
  try {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${fixture.oldToken}` },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true })
    assert.equal(fixture.versions.get(userId), 5)
  } finally {
    await fixture.app.close()
  }
})

test('logout requires an authenticated user before changing their token version', async () => {
  const fixture = createApp()
  try {
    const response = await fixture.app.inject({ method: 'POST', url: '/api/v1/auth/logout' })
    assert.equal(response.statusCode, 401)
    assert.equal(fixture.versions.get(userId), 4)
    assert.equal(fixture.wasPublished(), false)
  } finally {
    await fixture.app.close()
  }
})
