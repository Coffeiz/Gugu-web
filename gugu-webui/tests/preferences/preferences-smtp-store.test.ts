import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createPostgresPreferencesStore } from '../../src/domains/preferences/persistence/postgres.js'

test('PostgreSQL SMTP store encrypts new passwords, preserves omitted ones, and never selects password for GET', async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      statements.push({ sql, values })
      if (/SELECT password FROM user_smtp_configs/.test(sql)) return { rows: [{ password: statements[0]?.values[4] }] }
      return { rows: [] }
    },
  }
  const store = createPostgresPreferencesStore(pool as never, { secretKey: 'synthetic-smtp-store-secret' })
  assert.ok(store.smtp)
  const ownerId = randomUUID()
  await store.smtp.write(ownerId, {
    host: 'smtp.example.test', port: 587, user: 'mailer@example.test',
    fromAddr: 'no-reply@example.test', useSsl: false, enabled: true,
  }, 'synthetic-smtp-password')
  const write = statements[0]!
  assert.match(write.sql, /CASE WHEN \$5::text IS NULL THEN user_smtp_configs\.password/)
  assert.equal(write.values[4] === 'synthetic-smtp-password', false)
  assert.match(String(write.values[4]), /^gcm1:/)

  await store.smtp.write(ownerId, {
    host: 'smtp.example.test', port: 587, user: 'mailer@example.test',
    fromAddr: 'no-reply@example.test', useSsl: false, enabled: true,
  }, null)
  assert.equal(statements[1]?.values[4], null)

  await store.smtp.read(ownerId)
  assert.match(statements[2]!.sql, /SELECT host, port, "user", from_addr, use_ssl, enabled/)
  assert.doesNotMatch(statements[2]!.sql, /SELECT[^;]*password/i)

  assert.equal(await store.smtp.readPassword(ownerId), 'synthetic-smtp-password')
  assert.match(statements[3]!.sql, /SELECT password FROM user_smtp_configs WHERE user_id = \$1/)
  assert.deepEqual(statements[3]!.values, [ownerId])
})
