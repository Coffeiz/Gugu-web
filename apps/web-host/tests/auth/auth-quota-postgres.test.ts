import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresUserQuotaReader } from '../../src/domains/auth/persistence/quota.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('PostgreSQL quota reads isolate owners and match local BYOK day, month and cache usage', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL quota integration',
}, async () => {
  const schema = `gugu_auth_quota_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const owner = randomUUID()
  const otherOwner = randomUUID()
  const instant = new Date('2026-11-16T01:00:00.000Z')

  try {
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        quota_window_started_at timestamptz,
        token_limit_6h integer,
        token_limit_weekly integer,
        timezone varchar(64)
      )
    `)
    await pool.query(`
      CREATE TABLE user_provider_credentials (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        capability varchar(32) NOT NULL,
        enabled boolean NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE agent_usage (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        is_byok boolean NOT NULL,
        tokens_in integer NOT NULL DEFAULT 0,
        tokens_out integer NOT NULL DEFAULT 0,
        cache_read integer NOT NULL DEFAULT 0,
        cache_write integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL
      )
    `)
    await pool.query(`
      INSERT INTO users (id, quota_window_started_at, token_limit_6h, token_limit_weekly, timezone)
      VALUES ($1, $3, 500, NULL, 'America/Los_Angeles'),
             ($2, $3, NULL, NULL, NULL)
    `, [owner, otherOwner, new Date('2026-11-16T00:00:00.000Z')])
    await pool.query(
      `INSERT INTO user_provider_credentials (user_id, capability, enabled) VALUES ($1, 'llm', TRUE)`,
      [owner],
    )
    await pool.query(`
      INSERT INTO agent_usage (user_id, is_byok, tokens_in, tokens_out, cache_read, cache_write, created_at)
      VALUES
        ($1, TRUE, 5, 2, 1, 1, '2026-11-16T00:30:00Z'),
        ($1, TRUE, 100, 20, 40, 10, '2026-11-15T09:00:00Z'),
        ($1, TRUE, 300, 100, 260, 90, '2026-11-01T07:00:00Z'),
        ($1, TRUE, 10000, 10000, 10000, 10000, '2026-10-31T23:00:00Z'),
        ($2, TRUE, 50000, 50000, 50000, 50000, '2026-11-16T00:30:00Z')
    `, [owner, otherOwner])

    const getQuota = createPostgresUserQuotaReader(pool, {
      defaultLimit6h: 2000,
      defaultLimitWeekly: 8000,
      byokEnabled: true,
      localDeployment: false,
      serverTimezone: 'Asia/Shanghai',
    }, () => instant)

    const quota = await getQuota(owner)
    assert.equal(quota.usage_kind, 'byok')
    assert.equal(quota.used_6h, 7)
    assert.equal(quota.used_weekly, 7)
    assert.equal(quota.limit_6h, null)
    assert.equal(quota.limit_weekly, null)
    assert.equal(quota.byok_tokens_today, 179)
    assert.equal(quota.byok_tokens_month, 929)
    assert.equal(quota.byok_cache_rate, 0.372986)

    const trends = await getQuota.getUsageTrends!(owner, 3)
    assert.deepEqual(trends, {
      labels: ['11/13', '11/14', '11/15'],
      tokens_in: [0, 0, 105],
      cache_read: [0, 0, 41],
      cache_write: [0, 0, 11],
      tokens_out: [0, 0, 22],
      total: 179,
      daily_avg: 60,
      today: 179,
      cache_rate: 41 / 157,
    })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
