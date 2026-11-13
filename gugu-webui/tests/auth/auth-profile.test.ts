import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { Pool } from 'pg'
import test from 'node:test'
import { createUserToken, verifyUserToken } from '../../src/domains/auth/auth.js'
import { registerProfileRoute, type ProfileUser } from '../../src/domains/auth/routes/auth-profile.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-profile-secret-with-enough-entropy'

async function createFixture(options: { failAuthNotification?: boolean } = {}) {
  const schema = `gugu_auth_profile_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1 })
  const ownerId = randomUUID()
  const otherId = randomUUID()
  const passwordHash = await bcrypt.hash('synthetic-current-password', 4)
  await pool.query(`CREATE TABLE users (
    id uuid PRIMARY KEY, username text NOT NULL, display_name text, email text NOT NULL,
    is_active boolean NOT NULL DEFAULT true, avatar text, created_at timestamptz NOT NULL DEFAULT now(),
    timezone text, email_subscribed boolean, hashed_password text NOT NULL, security_version integer
  )`)
  await pool.query(`INSERT INTO users
    (id, username, display_name, email, timezone, email_subscribed, hashed_password, security_version)
    VALUES ($1, 'owner', '旧名称', 'owner@example.test', 'UTC', false, $3, 4),
           ($2, 'other', '他人名称', 'other@example.test', 'UTC', false, $3, 2)`,
  [ownerId, otherId, passwordHash])

  const notifications: string[] = []
  const app = Fastify({ logger: false })
  const userById = async (userId: string): Promise<ProfileUser | null> => {
    const { rows } = await pool.query<{
      id: string; username: string; display_name: string | null; email: string; is_active: boolean
      avatar: string | null; created_at: Date; timezone: string | null; email_subscribed: boolean | null
      security_version: number | null
    }>(`SELECT id::text, username, display_name, email, is_active, avatar, created_at,
              timezone, email_subscribed, security_version FROM users WHERE id = $1`, [userId])
    const row = rows[0]
    return row ? {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      isActive: row.is_active,
      avatarUrl: row.avatar ? `/api/v1/auth/avatar/${row.id}` : null,
      createdAt: row.created_at,
      timezone: row.timezone,
      emailSubscribed: row.email_subscribed ?? false,
      imChannels: [],
      securityVersion: row.security_version,
    } : null
  }

  registerProfileRoute(app, {
    pool,
    secret,
    async authenticate(request: FastifyRequest, reply: FastifyReply) {
      const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
      if (!token) {
        reply.code(401).send({ detail: '未提供认证凭据' })
        return null
      }
      try {
        const identity = verifyUserToken(token, secret)
        const user = await userById(identity.userId)
        if (!user || !user.isActive || (user.securityVersion || 1) !== identity.securityVersion) {
          reply.code(401).send({ detail: '用户不存在或已停用' })
          return null
        }
        return { id: user.id }
      } catch {
        reply.code(401).send({ detail: 'Token 无效或已过期' })
        return null
      }
    },
    lookupUser: userById,
    async bumpContextRevision(userId, resource) {
      assert.equal(resource, 'timezone')
      const current = await userById(userId)
      notifications.push(`revision:${userId}:${resource}:${current?.timezone ?? '<null>'}`)
    },
    async publishAuthStateChanged(userId) {
      const current = await userById(userId)
      assert.equal(current?.securityVersion, 5, 'auth-state notification runs after the password commit')
      notifications.push(`auth:${userId}`)
      if (options.failAuthNotification) throw new Error('synthetic Redis failure')
    },
  })

  return {
    app,
    pool,
    adminPool,
    schema,
    ownerId,
    otherId,
    notifications,
    tokenFor(userId: string, version: number) { return createUserToken(userId, version, secret) },
    async close() {
      await app.close()
      await pool.end()
      await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
      await adminPool.end()
    },
  }
}

test('profile update validates timezone and changes only the authenticated user fields', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const fixture = await createFixture()
  try {
    const badTimezone = await fixture.app.inject({
      method: 'PATCH', url: '/api/v1/auth/profile',
      headers: { authorization: `Bearer ${fixture.tokenFor(fixture.ownerId, 4)}` },
      payload: { timezone: 'Not/A_Real_Zone' },
    })
    assert.equal(badTimezone.statusCode, 400)
    assert.deepEqual(badTimezone.json(), { detail: '无效的时区' })
    assert.deepEqual(fixture.notifications, [])

    const response = await fixture.app.inject({
      method: 'PATCH', url: '/api/v1/auth/profile',
      headers: { authorization: `Bearer ${fixture.tokenFor(fixture.ownerId, 4)}` },
      payload: {
        displayName: '  小北  ', timezone: ' Asia/Tokyo ', emailSubscribed: true,
        userId: fixture.otherId,
      },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().display_name, '小北')
    assert.equal(response.json().timezone, 'Asia/Tokyo')
    assert.equal(response.json().email_subscribed, true)
    assert.deepEqual(fixture.notifications, [`revision:${fixture.ownerId}:timezone:Asia/Tokyo`])

    const cleared = await fixture.app.inject({
      method: 'PATCH', url: '/api/v1/auth/profile',
      headers: { authorization: `Bearer ${fixture.tokenFor(fixture.ownerId, 4)}` },
      payload: { displayName: '  ', timezone: '', emailSubscribed: false },
    })
    assert.equal(cleared.statusCode, 200)
    assert.equal(cleared.json().display_name, null)
    assert.equal(cleared.json().timezone, null)
    assert.equal(cleared.json().email_subscribed, false)
    assert.deepEqual(fixture.notifications, [
      `revision:${fixture.ownerId}:timezone:Asia/Tokyo`,
      `revision:${fixture.ownerId}:timezone:<null>`,
    ])

    const records = await fixture.pool.query<{ id: string; display_name: string | null; timezone: string | null }>(
      'SELECT id::text, display_name, timezone FROM users ORDER BY username',
    )
    assert.deepEqual(records.rows, [
      { id: fixture.otherId, display_name: '他人名称', timezone: 'UTC' },
      { id: fixture.ownerId, display_name: null, timezone: null },
    ])
  } finally {
    await fixture.close()
  }
})

test('password update checks the current password, advances the token version, and keeps the session after notification failure', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const fixture = await createFixture({ failAuthNotification: true })
  try {
    const missingCurrentPassword = await fixture.app.inject({
      method: 'PATCH', url: '/api/v1/auth/profile',
      headers: { authorization: `Bearer ${fixture.tokenFor(fixture.ownerId, 4)}` },
      payload: { newPassword: 'synthetic-new-password' },
    })
    assert.equal(missingCurrentPassword.statusCode, 400)
    assert.deepEqual(missingCurrentPassword.json(), { detail: '请输入当前密码' })

    const wrongCurrentPassword = await fixture.app.inject({
      method: 'PATCH', url: '/api/v1/auth/profile',
      headers: { authorization: `Bearer ${fixture.tokenFor(fixture.ownerId, 4)}` },
      payload: { currentPassword: 'wrong-password', newPassword: 'synthetic-new-password' },
    })
    assert.equal(wrongCurrentPassword.statusCode, 400)
    assert.deepEqual(wrongCurrentPassword.json(), { detail: '当前密码错误' })

    const response = await fixture.app.inject({
      method: 'PATCH', url: '/api/v1/auth/profile',
      headers: { authorization: `Bearer ${fixture.tokenFor(fixture.ownerId, 4)}` },
      payload: {
        currentPassword: 'synthetic-current-password',
        newPassword: 'synthetic-new-password',
      },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(fixture.notifications, [`auth:${fixture.ownerId}`])
    assert.equal((await fixture.pool.query<{ security_version: number }>(
      'SELECT security_version FROM users WHERE id = $1', [fixture.ownerId],
    )).rows[0]?.security_version, 5)

    const setCookie = response.headers['set-cookie']
    const cookies = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '')
    const refreshedToken = cookies.match(/gugu_user_access_token=([^;]+)/)?.[1]
    assert.ok(refreshedToken)
    assert.equal(verifyUserToken(refreshedToken, secret).securityVersion, 5)

    const oldSession = await fixture.app.inject({
      method: 'PATCH', url: '/api/v1/auth/profile',
      headers: { authorization: `Bearer ${fixture.tokenFor(fixture.ownerId, 4)}` },
      payload: { displayName: '不应写入' },
    })
    assert.equal(oldSession.statusCode, 401)
  } finally {
    await fixture.close()
  }
})
