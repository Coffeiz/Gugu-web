import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createCsrfToken, createUserToken, type PublicUserRecord } from '../../src/domains/auth/auth.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-profile-vite-secret'

test('Vite forwards cookie-authenticated profile edits and password rotation through Node Host to isolated PostgreSQL', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated profile HTTP integration',
}, async () => {
  const schema = `gugu_profile_vite_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const ownerId = randomUUID()
  const originalPassword = 'synthetic-current-password'
  const published: string[] = []
  const lookupUser = async (userId: string): Promise<PublicUserRecord | null> => {
    const result = await pool.query<{
      id: string; username: string; display_name: string | null; email: string; is_active: boolean
      account_status: string; security_version: number | null; avatar: string | null; created_at: Date
      timezone: string | null; email_subscribed: boolean | null
    }>(`SELECT id::text, username, display_name, email, is_active, account_status, security_version,
               avatar, created_at, timezone, email_subscribed FROM users WHERE id=$1`, [userId])
    const row = result.rows[0]
    return row ? {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      isActive: row.is_active,
      accountStatus: row.account_status,
      securityVersion: row.security_version ?? 1,
      avatarUrl: row.avatar ? `/api/v1/auth/avatar/${row.id}` : null,
      createdAt: row.created_at,
      timezone: row.timezone,
      emailSubscribed: row.email_subscribed ?? false,
      imChannels: [],
    } : null
  }
  const app = createApp({
    appName: 'auth-profile-vite-integration',
    async isReady() { return true },
    userAuth: { secret, lookupUser },
    profile: {
      pool,
      secret,
      lookupUser,
      async bumpContextRevision(userId, resource) {
        const persisted = await pool.query<{ timezone: string | null }>(
          'SELECT timezone FROM users WHERE id=$1', [userId],
        )
        assert.equal(resource, 'timezone')
        published.push(`revision:${userId}:${persisted.rows[0]?.timezone ?? '<null>'}`)
      },
      async publishAuthStateChanged(userId) {
        const persisted = await pool.query<{ security_version: number }>(
          'SELECT security_version FROM users WHERE id=$1', [userId],
        )
        published.push(`auth:${userId}:${persisted.rows[0]?.security_version}`)
      },
    },
  })
  let vite: {
    listen(): Promise<void>
    close(): Promise<void>
    httpServer?: { address(): string | { port: number } | null }
  } | undefined
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET

  try {
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY, username varchar(100) NOT NULL UNIQUE, display_name varchar(100),
        email varchar(300) NOT NULL UNIQUE, is_active boolean NOT NULL, account_status varchar(16) NOT NULL,
        security_version integer, avatar varchar(500), created_at timestamptz NOT NULL,
        timezone varchar(64), email_subscribed boolean NOT NULL, hashed_password varchar(200) NOT NULL
      )
    `)
    await pool.query(
      `INSERT INTO users (id, username, display_name, email, is_active, account_status, security_version,
                          created_at, timezone, email_subscribed, hashed_password)
       VALUES ($1, 'profile-vite-user', '旧名称', 'profile-vite@example.test', TRUE, 'active', 4,
               '2026-11-01T00:00:00Z', 'UTC', FALSE, $2)`,
      [ownerId, await bcrypt.hash(originalPassword, 4)],
    )

    const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.VITE_API_PROXY_TARGET = hostAddress
    const frontendRoot = resolve(process.cwd(), '../web')
    const requireFrontend = createRequire(resolve(frontendRoot, 'package.json'))
    const viteModule = requireFrontend('vite') as {
      createServer(options: Record<string, unknown>): Promise<{
        listen(): Promise<void>
        close(): Promise<void>
        httpServer?: { address(): string | { port: number } | null }
      }>
    }
    vite = await viteModule.createServer({
      configFile: resolve(frontendRoot, 'vite.config.js'),
      root: frontendRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api/v1`
    const access = createUserToken(ownerId, 4, secret)
    const csrf = createCsrfToken()
    const cookie = `gugu_user_access_token=${access}; gugu_user_csrf_token=${csrf}`
    const csrfHeaders = { cookie, 'x-csrf-token': csrf }

    const initial = await fetch(`${base}/auth/me`, { headers: { cookie } })
    assert.equal(initial.status, 200)

    const profile = await fetch(`${base}/auth/profile`, {
      method: 'PATCH',
      headers: { ...csrfHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '  小北  ', timezone: ' Asia/Tokyo ', emailSubscribed: true }),
    })
    assert.equal(profile.status, 200)
    const updatedProfile = await profile.json() as Record<string, unknown>
    assert.equal(updatedProfile.display_name, '小北')
    assert.equal(updatedProfile.timezone, 'Asia/Tokyo')
    assert.equal(updatedProfile.email_subscribed, true)
    assert.deepEqual(published, [`revision:${ownerId}:Asia/Tokyo`])

    const password = await fetch(`${base}/auth/profile`, {
      method: 'PATCH',
      headers: { ...csrfHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: originalPassword, newPassword: 'synthetic-next-password' }),
    })
    assert.equal(password.status, 200)
    assert.deepEqual(published, [`revision:${ownerId}:Asia/Tokyo`, `auth:${ownerId}:5`])
    const rotatedCookies = password.headers.getSetCookie()
    const nextAccess = rotatedCookies.find((value) => value.startsWith('gugu_user_access_token='))
    const nextCsrf = rotatedCookies.find((value) => value.startsWith('gugu_user_csrf_token='))
    assert.ok(nextAccess)
    assert.ok(nextCsrf)
    const nextCookie = [nextAccess, nextCsrf].map((value) => value.split(';', 1)[0]).join('; ')

    const oldSession = await fetch(`${base}/auth/me`, { headers: { cookie } })
    assert.equal(oldSession.status, 401)
    const renewedSession = await fetch(`${base}/auth/me`, { headers: { cookie: nextCookie } })
    assert.equal(renewedSession.status, 200)
    assert.equal((await renewedSession.json() as Record<string, unknown>).display_name, '小北')

    const persisted = await pool.query<{
      display_name: string | null; timezone: string | null; email_subscribed: boolean
      security_version: number; hashed_password: string
    }>(`SELECT display_name, timezone, email_subscribed, security_version, hashed_password
        FROM users WHERE id=$1`, [ownerId])
    assert.equal(persisted.rows[0]?.display_name, '小北')
    assert.equal(persisted.rows[0]?.timezone, 'Asia/Tokyo')
    assert.equal(persisted.rows[0]?.email_subscribed, true)
    assert.equal(persisted.rows[0]?.security_version, 5)
    assert.equal(await bcrypt.compare('synthetic-next-password', persisted.rows[0]!.hashed_password), true)
  } finally {
    if (vite) await vite.close()
    await app.close().catch(() => undefined)
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
