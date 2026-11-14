import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createCsrfToken, createUserToken, type PublicUserRecord } from '../../src/domains/auth/auth.js'
import { createPostgresPreferencesStore } from '../../src/domains/preferences/persistence/postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('Vite forwards cookie-authenticated preference reads and partial writes to Node Host and isolated PostgreSQL', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated preferences HTTP integration',
}, async () => {
  const schema = `gugu_preferences_vite_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const ownerId = randomUUID()
  const secret = 'synthetic-preferences-vite-secret'
  const user: PublicUserRecord = {
    id: ownerId,
    username: 'preferences-vite-user',
    displayName: '偏好测试用户',
    email: 'preferences-vite@example.test',
    isActive: true,
    accountStatus: 'active',
    securityVersion: 1,
    avatarUrl: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    emailSubscribed: false,
    imChannels: [],
  }
  const app = createApp({
    appName: 'preferences-vite-integration',
    async isReady() { return true },
    userAuth: { secret, async lookupUser(userId) { return userId === ownerId ? user : null } },
    preferences: createPostgresPreferencesStore(pool),
  })
  let vite: {
    listen(): Promise<void>
    close(): Promise<void>
    httpServer?: { address(): string | { port: number } | null }
  } | undefined
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET

  try {
    await pool.query(`
      CREATE TABLE user_preferences (
        id bigserial PRIMARY KEY,
        user_id uuid NOT NULL UNIQUE,
        data_json text NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await pool.query(
      'INSERT INTO user_preferences (user_id, data_json) VALUES ($1, $2)',
      [ownerId, JSON.stringify({ locale: 'en-US', theme: 'light', custom_blob: { keep: true }, shell_autopilot_enabled: true })],
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
    const base = `http://127.0.0.1:${address.port}/api/v1/preferences`
    const access = createUserToken(ownerId, 1, secret)
    const csrf = createCsrfToken()
    const headers = {
      cookie: `gugu_user_access_token=${access}; gugu_user_csrf_token=${csrf}`,
      'x-csrf-token': csrf,
    }

    const initial = await fetch(base, { headers })
    assert.equal(initial.status, 200)
    const initialPreferences = await initial.json() as { locale: string; theme: string }
    assert.equal(initialPreferences.locale, 'en-US')
    assert.equal(initialPreferences.theme, 'light')

    const update = await fetch(base, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'ja-JP', theme: 'dark', palette: 'blue', automaticModeEnabled: true }),
    })
    assert.equal(update.status, 200)
    const updatedPreferences = await update.json() as Record<string, unknown>
    assert.equal(updatedPreferences.locale, 'ja-JP')
    assert.equal(updatedPreferences.theme, 'dark')
    assert.equal(updatedPreferences.palette, 'blue')
    assert.equal(updatedPreferences.automaticModeEnabled, true)

    const persisted = await pool.query<{ data_json: string }>(
      'SELECT data_json FROM user_preferences WHERE user_id=$1', [ownerId],
    )
    assert.deepEqual(JSON.parse(persisted.rows[0]!.data_json), {
      locale: 'ja-JP', theme: 'dark', custom_blob: { keep: true },
      automatic_mode_enabled: true, palette: 'blue',
    })
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
