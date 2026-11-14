import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken, type PublicUserRecord } from '../../src/domains/auth/auth.js'
import { createPostgresPreferencesStore } from '../../src/domains/preferences/persistence/postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('PostgreSQL preferences Host route persists partial updates per authenticated owner', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL preference integration',
}, async () => {
  const schema = `gugu_preferences_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const ownerId = randomUUID()
  const otherOwnerId = randomUUID()
  const secret = 'synthetic-test-secret-for-preferences-pg'
  const makeUser = (id: string): PublicUserRecord => ({
    id,
    username: `prefs-${id.slice(0, 8)}`,
    displayName: '偏好测试用户',
    email: `prefs-${id.slice(0, 8)}@example.test`,
    isActive: true,
    accountStatus: 'active',
    securityVersion: 1,
    avatarUrl: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    emailSubscribed: false,
    imChannels: [],
  })
  const users = new Map<string, PublicUserRecord>([[ownerId, makeUser(ownerId)], [otherOwnerId, makeUser(otherOwnerId)]])

  try {
    await pool.query(`
      CREATE TABLE user_preferences (
        id bigserial PRIMARY KEY,
        user_id uuid NOT NULL UNIQUE,
        data_json text NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    const app = createApp({
      appName: 'preferences-postgres-test',
      async isReady() { return true },
      userAuth: {
        secret,
        async lookupUser(userId) { return users.get(userId) ?? null },
      },
      preferences: createPostgresPreferencesStore(pool),
    })
    try {
      const ownerAuthorization = `Bearer ${createUserToken(ownerId, 1, secret)}`
      const otherAuthorization = `Bearer ${createUserToken(otherOwnerId, 1, secret)}`
      const initial = await app.inject({
        method: 'GET', url: '/api/v1/preferences', headers: { authorization: ownerAuthorization },
      })
      assert.equal(initial.statusCode, 200)
      assert.equal(initial.json().theme, 'light')
      assert.equal(initial.json().shellEnabled, true)

      const first = await app.inject({
        method: 'PATCH', url: '/api/v1/preferences',
        headers: { authorization: ownerAuthorization },
        payload: { locale: 'ja-JP', theme: 'dark', automaticModeEnabled: true },
      })
      assert.equal(first.statusCode, 200)

      const second = await app.inject({
        method: 'PATCH', url: '/api/v1/preferences',
        headers: { authorization: ownerAuthorization },
        payload: { palette: 'blue' },
      })
      assert.equal(second.statusCode, 200)
      assert.equal(second.json().locale, 'ja-JP')
      assert.equal(second.json().theme, 'dark')
      assert.equal(second.json().palette, 'blue')
      assert.equal(second.json().automaticModeEnabled, true)

      const other = await app.inject({
        method: 'GET', url: '/api/v1/preferences', headers: { authorization: otherAuthorization },
      })
      assert.equal(other.statusCode, 200)
      assert.equal(other.json().theme, 'light')
      assert.equal(other.json().locale, null)

      const rows = await pool.query<{ user_id: string; data_json: string } & Record<string, unknown>>(
        'SELECT user_id, data_json FROM user_preferences ORDER BY user_id',
      )
      assert.equal(rows.rowCount, 1)
      assert.equal(rows.rows[0]?.user_id, ownerId)
      assert.deepEqual(JSON.parse(rows.rows[0]!.data_json), {
        locale: 'ja-JP', theme: 'dark', automatic_mode_enabled: true, palette: 'blue',
      })
    } finally {
      await app.close()
    }
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
