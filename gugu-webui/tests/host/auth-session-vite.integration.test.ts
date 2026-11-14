import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import bcrypt from 'bcryptjs'
import { createApp } from '../../src/app.js'
import { revokeUserSessions } from '../../src/domains/auth/persistence/auth-revocation.js'
import { createUserRepository } from '../../src/domains/auth/persistence/users.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('Vite forwards cookie login to Node Host and restores the authenticated session from isolated PostgreSQL', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL session integration',
}, async () => {
  const schema = `gugu_auth_session_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const publishedAuthChanges: string[] = []
  const app = createApp({
    appName: 'auth-session-vite-test',
    async isReady() { return true },
    userAuth: {
      secret: 'synthetic-auth-session-vite-secret',
      ...createUserRepository(pool),
      async revokeUserSessions(userId) { await revokeUserSessions(pool, userId) },
      async publishAuthStateChanged(userId) { publishedAuthChanges.push(userId) },
    },
  })
  let vite: {
    listen(): Promise<void>
    close(): Promise<void>
    httpServer?: { address(): string | { port: number } | null }
  } | undefined
  let hostAddress: string | undefined
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET

  try {
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        username varchar(100) NOT NULL UNIQUE,
        hashed_password varchar(200) NOT NULL,
        display_name varchar(100),
        email varchar(300) NOT NULL UNIQUE,
        is_active boolean NOT NULL,
        account_status varchar(16),
        security_version integer,
        avatar varchar(500),
        created_at timestamptz,
        timezone varchar(64),
        email_subscribed boolean,
        last_active_at timestamptz
      );
      CREATE TABLE user_bots (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id),
        platform varchar(20) NOT NULL,
        enabled boolean NOT NULL
      );
      CREATE TABLE frontend_events (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id),
        event varchar(64) NOT NULL,
        properties jsonb,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)

    const userId = randomUUID()
    await pool.query(
      `INSERT INTO users
        (id, username, hashed_password, display_name, email, is_active, account_status,
         security_version, created_at, timezone, email_subscribed)
       VALUES ($1, $2, $3, $4, $5, TRUE, 'active', 2, $6, $7, FALSE)`,
      [userId, 'vite-session-user', await bcrypt.hash('synthetic-session-password', 4),
        '会话测试用户', 'vite-session@example.test', '2026-11-01T12:30:00Z', 'Asia/Shanghai'],
    )
    await pool.query('INSERT INTO user_bots (user_id, platform, enabled) VALUES ($1, $2, TRUE)', [userId, 'qq'])

    hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
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
    const base = `http://127.0.0.1:${address.port}`

    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-transport': 'cookie' },
      body: JSON.stringify({ username: 'vite-session-user', password: 'synthetic-session-password' }),
    })
    assert.equal(login.status, 200)
    const loginBody = await login.json() as { access_token: string | null; user: { id: string; username: string } }
    assert.equal(loginBody.access_token, null)
    assert.equal(loginBody.user.id, userId)
    assert.equal(loginBody.user.username, 'vite-session-user')

    const cookies = login.headers.getSetCookie()
    const accessCookie = cookies.find((cookie) => cookie.startsWith('gugu_user_access_token='))
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('gugu_user_csrf_token='))
    assert.ok(accessCookie)
    assert.ok(csrfCookie)
    assert.match(accessCookie, /HttpOnly/)
    assert.doesNotMatch(csrfCookie, /HttpOnly/)
    assert.match(accessCookie, /SameSite=Lax/)
    assert.match(csrfCookie, /SameSite=Lax/)

    const cookieHeader = [accessCookie, csrfCookie].map((cookie) => cookie.split(';', 1)[0]).join('; ')
    const session = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: cookieHeader } })
    assert.equal(session.status, 200)
    assert.deepEqual(await session.json(), {
      id: userId,
      username: 'vite-session-user',
      display_name: '会话测试用户',
      email: 'vite-session@example.test',
      is_active: true,
      avatar_url: null,
      created_at: '2026-11-01',
      im_channels: ['qq'],
      timezone: 'Asia/Shanghai',
      email_subscribed: false,
    })

    const csrfToken = csrfCookie.split(';', 1)[0]!.split('=', 2)[1]!
    const logout = await fetch(`${base}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    })
    assert.equal(logout.status, 200)
    assert.deepEqual(await logout.json(), { ok: true })
    assert.deepEqual(publishedAuthChanges, [userId])
    const clearedCookies = logout.headers.getSetCookie().join('\n')
    assert.match(clearedCookies, /gugu_user_access_token=; Max-Age=0/)
    assert.match(clearedCookies, /gugu_user_csrf_token=; Max-Age=0/)
    const revokedSession = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: cookieHeader } })
    assert.equal(revokedSession.status, 401)

    const loginEvents = await pool.query<{ event: string }>(
      "SELECT event FROM frontend_events WHERE user_id=$1 AND event='web_login'",
      [userId],
    )
    assert.equal(loginEvents.rowCount, 1)
    const account = await pool.query<{ security_version: number }>(
      'SELECT security_version FROM users WHERE id=$1', [userId],
    )
    assert.equal(account.rows[0]?.security_version, 3)
  } finally {
    if (vite) await vite.close()
    if (hostAddress) await app.close()
    else await app.close().catch(() => undefined)
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await adminPool.end()
  }
})
