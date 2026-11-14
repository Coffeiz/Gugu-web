import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { revokeUserSessions, UserNotFoundError } from '../../src/domains/auth/persistence/auth-revocation.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('security-version revocation commits a null-safe increment and rejects a missing user', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_auth_revoke_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1 })
  const userId = randomUUID()

  try {
    await pool.query(`CREATE TABLE users (id uuid PRIMARY KEY, security_version integer)`)
    await pool.query('INSERT INTO users (id, security_version) VALUES ($1, NULL)', [userId])

    assert.equal(await revokeUserSessions(pool, userId), 1)
    assert.equal((await pool.query<{ security_version: number }>(
      'SELECT security_version FROM users WHERE id = $1', [userId],
    )).rows[0]?.security_version, 1)

    await pool.query('UPDATE users SET security_version = 7 WHERE id = $1', [userId])
    assert.equal(await revokeUserSessions(pool, userId), 8)
    await assert.rejects(revokeUserSessions(pool, randomUUID()), UserNotFoundError)
  } finally {
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
})
