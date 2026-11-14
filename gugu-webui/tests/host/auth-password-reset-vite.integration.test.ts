import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createCsrfToken, createUserToken, type PublicUserRecord } from '../../src/domains/auth/auth.js'
import { createPostgresPasswordResetStore, type PasswordResetRedisCommands } from '../../src/domains/auth/password-reset.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-password-reset-vite-secret'
const memoryResetToken = 'synthetic-memory-reset-token-0123456789'

function createRedis(): PasswordResetRedisCommands {
  const values = new Map<string, string>()
  return {
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
      const value = values.get(tokenKey)
      if (!value || values.has(claimKey)) return null
      values.set(claimKey, value)
      values.delete(tokenKey)
      return value
    },
    async restore(tokenKey, claimKey, userId) {
      if (values.get(claimKey) !== userId || values.has(tokenKey)) return false
      values.set(tokenKey, userId)
      values.delete(claimKey)
      return true
    },
  }
}

test('Vite forwards password recovery and reset requests to the Node Host without a database dependency', async () => {
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET
  const sentLinks: string[] = []
  const persistedHashes: string[] = []
  const published: string[] = []
  const app = createApp({
    appName: 'auth-password-reset-vite-host',
    async isReady() { return true },
    passwordReset: {
      store: {
        async findByIdentifier(identifier) {
          return identifier === 'cedarz@example.test'
            ? { id: randomUUID(), username: 'reset-user', email: 'cedarz@example.test', displayName: '小北' }
            : null
        },
        async setPassword(_userId, passwordHash) {
          persistedHashes.push(passwordHash)
          return true
        },
      },
      redis: createRedis(),
      async rateLimit() {},
      systemEmailAvailable: true,
      publicAppUrl: 'https://gugu.example.test',
      async sendResetEmail({ link }) {
        sentLinks.push(link)
        return true
      },
      async publishAuthStateChanged(userId) { published.push(userId) },
      createToken: () => memoryResetToken,
    },
  })
  let vite: { listen(): Promise<void>; close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } } | undefined

  try {
    const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.VITE_API_PROXY_TARGET = hostAddress
    const frontendRoot = resolve(process.cwd(), '../frontend')
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
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/auth`

    const forgot = await fetch(`${endpoint}/forgot-password`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cedarz@example.test' }),
    })
    assert.equal(forgot.status, 200)
    assert.equal((await forgot.json() as Record<string, unknown>).maskedEmail, 'c***z@example.test')
    assert.deepEqual(sentLinks, [`https://gugu.example.test/reset-password?token=${memoryResetToken}`])

    const reset = await fetch(`${endpoint}/reset-password`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: memoryResetToken, newPassword: 'synthetic-next-password' }),
    })
    assert.equal(reset.status, 200)
    assert.deepEqual(await reset.json(), { ok: true })
    assert.equal(persistedHashes.length, 1)
    assert.equal(published.length, 1)
    assert.ok(reset.headers.getSetCookie().some((value) => value.startsWith('gugu_user_access_token=; Max-Age=0')))
  } finally {
    if (vite) await vite.close()
    await app.close().catch(() => undefined)
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
  }
})

test('Vite routes password recovery and reset through Node Host to isolated PostgreSQL', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated recovery HTTP integration',
}, async () => {
  const schema = `gugu_reset_vite_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const ownerId = randomUUID()
  const oldPassword = 'synthetic-before-reset-password'
  const newPassword = 'synthetic-after-reset-password'
  const resetToken = 'synthetic-vite-reset-token-0123456789'
  const sent: string[] = []
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
    appName: 'auth-password-reset-vite-integration',
    async isReady() { return true },
    userAuth: {
      secret,
      lookupUser,
      async authenticateCredentials(username, password) {
        const result = await pool.query<{ id: string }>(
          `SELECT id::text FROM users WHERE username=$1 AND hashed_password IS NOT NULL`, [username],
        )
        const row = result.rows[0]
        if (!row) return null
        const record = await pool.query<{ hashed_password: string }>(
          'SELECT hashed_password FROM users WHERE id=$1', [row.id],
        )
        if (!await bcrypt.compare(password, record.rows[0]?.hashed_password ?? '')) return null
        return lookupUser(row.id)
      },
      async recordLogin() {},
    },
    passwordReset: {
      store: createPostgresPasswordResetStore(pool),
      redis: createRedis(),
      async rateLimit() {},
      systemEmailAvailable: true,
      publicAppUrl: 'https://gugu.example.test',
      async sendResetEmail(input) {
        sent.push(input.link)
        return true
      },
      async publishAuthStateChanged(userId) {
        const result = await pool.query<{ security_version: number }>(
          'SELECT security_version FROM users WHERE id=$1', [userId],
        )
        assert.equal(result.rows[0]?.security_version, 5)
        published.push(userId)
      },
      createToken: () => resetToken,
    },
  })
  let vite: { listen(): Promise<void>; close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } } | undefined
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
       VALUES ($1, 'reset-vite-user', '小北', 'cedarz@example.test', TRUE, 'active', 4,
               '2026-11-01T00:00:00Z', 'UTC', FALSE, $2)`,
      [ownerId, await bcrypt.hash(oldPassword, 4)],
    )

    const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.VITE_API_PROXY_TARGET = hostAddress
    const frontendRoot = resolve(process.cwd(), '../frontend')
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

    const requestLink = await fetch(`${base}/auth/forgot-password`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cedarz@example.test' }),
    })
    assert.equal(requestLink.status, 200)
    assert.equal((await requestLink.json() as Record<string, unknown>).maskedEmail, 'c***z@example.test')
    assert.deepEqual(sent, [`https://gugu.example.test/reset-password?token=${resetToken}`])

    const reset = await fetch(`${base}/auth/reset-password`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword }),
    })
    assert.equal(reset.status, 200)
    assert.equal((await reset.json() as Record<string, unknown>).ok, true)
    assert.ok(reset.headers.getSetCookie().some((value) => value.startsWith('gugu_user_access_token=; Max-Age=0')))
    assert.deepEqual(published, [ownerId])

    const persisted = await pool.query<{ security_version: number; hashed_password: string }>(
      'SELECT security_version, hashed_password FROM users WHERE id=$1', [ownerId],
    )
    assert.equal(persisted.rows[0]?.security_version, 5)
    assert.equal(await bcrypt.compare(newPassword, persisted.rows[0]!.hashed_password), true)

    const oldSession = await fetch(`${base}/auth/me`, { headers: { cookie } })
    assert.equal(oldSession.status, 401)
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-transport': 'cookie' },
      body: JSON.stringify({ username: 'reset-vite-user', password: newPassword }),
    })
    assert.equal(login.status, 200)
    const newCookies = login.headers.getSetCookie()
    const nextCookie = newCookies.map((value) => value.split(';', 1)[0]).join('; ')
    assert.equal((await fetch(`${base}/auth/me`, { headers: { cookie: nextCookie } })).status, 200)
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
