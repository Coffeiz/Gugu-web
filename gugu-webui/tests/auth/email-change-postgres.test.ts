import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import {
  createPostgresEmailChangeStore,
  hashEmailChangeToken,
} from '../../src/domains/auth/email-change.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('PostgreSQL email change rotates pending requests and atomically updates email plus token version', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL email-change integration',
}, async () => {
  const schema = `gugu_email_change_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const ownerId = randomUUID()
  const firstToken = 'synthetic-email-change-first-token-0123456789'
  const secondToken = 'synthetic-email-change-second-token-0123456789'
  const replacementToken = 'synthetic-email-change-replacement-token-0123456789'
  const store = createPostgresEmailChangeStore(pool)

  try {
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY, username varchar(100) NOT NULL UNIQUE, display_name varchar(100),
        email varchar(300) NOT NULL UNIQUE, hashed_password varchar(200), security_version integer NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE email_change_requests (
        id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        new_email varchar(300) NOT NULL, token_hash varchar(64) NOT NULL UNIQUE,
        purpose varchar(32) NOT NULL DEFAULT 'email_change', expires_at timestamptz NOT NULL,
        used_at timestamptz, revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        request_ip_hash varchar(64), user_agent_hash varchar(64)
      )
    `)
    await pool.query(
      `INSERT INTO users (id, username, display_name, email, hashed_password, security_version)
       VALUES ($1, 'email-change-user', '小北', 'cedarz@example.test', 'synthetic-hash', 4)`, [ownerId],
    )

    await store.createRequest(ownerId, 'first@example.test', hashEmailChangeToken(firstToken), new Date(Date.now() + 60_000))
    await store.createRequest(ownerId, 'fresh@example.test', hashEmailChangeToken(secondToken), new Date(Date.now() + 60_000))
    const oldState = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM email_change_requests WHERE token_hash = $1', [hashEmailChangeToken(firstToken)],
    )
    assert.ok(oldState.rows[0]?.revoked_at)

    const active = await store.activeRequest(ownerId)
    assert.equal(active?.email, 'fresh@example.test')
    assert.equal(await store.emailOccupied('fresh@example.test', ownerId), false)
    const replaced = await store.replaceActiveToken(
      ownerId, hashEmailChangeToken(replacementToken), new Date(Date.now() + 60_000),
    )
    assert.equal(replaced?.email, 'fresh@example.test')
    assert.equal(await store.completeToken(hashEmailChangeToken(secondToken)).then((result) => result.kind), 'invalid')

    const completed = await store.completeToken(hashEmailChangeToken(replacementToken))
    assert.equal(completed.kind, 'completed')
    if (completed.kind !== 'completed') return
    assert.equal(completed.user.email, 'fresh@example.test')
    const persisted = await pool.query<{ email: string; security_version: number }>(
      'SELECT email, security_version FROM users WHERE id = $1', [ownerId],
    )
    assert.deepEqual(persisted.rows[0], { email: 'fresh@example.test', security_version: 5 })
    assert.equal(await store.completeToken(hashEmailChangeToken(replacementToken)).then((result) => result.kind), 'invalid')

    await store.createRequest(ownerId, 'another@example.test', hashEmailChangeToken(firstToken), new Date(Date.now() + 60_000))
    await store.revokeActive(ownerId)
    assert.equal(await store.activeRequest(ownerId), null)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
