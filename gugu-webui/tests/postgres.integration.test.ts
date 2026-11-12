import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { createUserRepository } from '../src/users.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-postgres-integration-secret'

function userToken(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    role: 'user',
    sv: 4,
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url')
  const content = `${header}.${payload}`
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`
}

test('Node /auth/me reads an isolated PostgreSQL user and updates activity after authentication', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_webui_test_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: { secret, ...createUserRepository(pool) },
  })

  try {
    const namespace = await pool.query<{ schema: string }>('SELECT current_schema() AS schema')
    assert.equal(namespace.rows[0]?.schema, schema)
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        username varchar(100) NOT NULL,
        display_name varchar(100),
        email varchar(300) NOT NULL,
        is_active boolean NOT NULL,
        account_status varchar(16),
        security_version integer,
        avatar varchar(500),
        created_at timestamptz,
        timezone varchar(64),
        email_subscribed boolean,
        last_active_at timestamptz
      )
    `)
    await pool.query(`
      CREATE TABLE user_bots (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id),
        platform varchar(20) NOT NULL,
        enabled boolean NOT NULL
      )
    `)
    const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
    await pool.query(
      `INSERT INTO users
        (id, username, display_name, email, is_active, account_status, security_version,
         created_at, timezone, email_subscribed)
       VALUES ($1, $2, $3, $4, TRUE, 'active', 4, $5, $6, FALSE)`,
      [userId, 'integration-user', '合成集成用户', 'integration@example.test', '2026-11-02T00:00:00Z', 'Asia/Shanghai'],
    )
    await pool.query(
      'INSERT INTO user_bots (user_id, platform, enabled) VALUES ($1, $2, TRUE)',
      [userId, 'qq'],
    )

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${userToken(userId)}` },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      id: userId,
      username: 'integration-user',
      display_name: '合成集成用户',
      email: 'integration@example.test',
      is_active: true,
      avatar_url: null,
      created_at: '2026-11-02',
      im_channels: ['qq'],
      timezone: 'Asia/Shanghai',
      email_subscribed: false,
    })
    const stored = await pool.query<{ last_active_at: Date | null }>(
      'SELECT last_active_at FROM users WHERE id = $1',
      [userId],
    )
    assert.ok(stored.rows[0]?.last_active_at instanceof Date)
  } finally {
    await app.close()
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
})
