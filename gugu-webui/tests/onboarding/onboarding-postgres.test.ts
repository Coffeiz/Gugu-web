import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresOnboardingStore } from '../../src/domains/onboarding/persistence/postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('PostgreSQL onboarding updates preserve legacy seed state and isolate each user', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL onboarding integration',
}, async () => {
  const schema = `gugu_onboarding_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const ownerId = randomUUID()
  const otherOwnerId = randomUUID()

  try {
    await pool.query('CREATE TABLE users (id uuid PRIMARY KEY)')
    await pool.query(`
      CREATE TABLE onboarding_state (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        state json,
        created_at timestamp,
        updated_at timestamp
      )
    `)
    await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [ownerId, otherOwnerId])
    await pool.query(
      'INSERT INTO onboarding_state (user_id, state) VALUES ($1, $2::json)',
      [ownerId, JSON.stringify({ seeded: true, seeded_project_id: 41, seeded_project_name: '旧示例', custom: '保留' })],
    )
    const store = createPostgresOnboardingStore(pool)

    const initial = await store.getState(ownerId)
    assert.deepEqual(initial.seed, { seeded: true, project_id: 41, project_name: '旧示例' })
    assert.equal((initial.guide as Record<string, unknown>).enabled, false)

    const saved = await store.updateGuide(ownerId, {
      current_step: 'features', completed_steps: ['locale', 'features'], dismissed: true,
    })
    assert.deepEqual(saved.seed, initial.seed)
    assert.equal((saved.guide as Record<string, unknown>).dismissed, true)

    const reopened = await store.updateGuide(ownerId, { version: 1, dismissed: false, completed_at: null })
    assert.deepEqual((reopened.guide as Record<string, unknown>).completed_steps, ['locale', 'features'])
    assert.equal((reopened.guide as Record<string, unknown>).completed_at, null)

    const other = await store.getState(otherOwnerId)
    assert.deepEqual(other.seed, { seeded: false, project_id: null, project_name: null })
    assert.equal((other.guide as Record<string, unknown>).current_step, 'locale')

    const rows = await pool.query<{ user_id: string; state: Record<string, unknown> } & Record<string, unknown>>(
      'SELECT user_id, state FROM onboarding_state ORDER BY user_id',
    )
    assert.equal(rows.rowCount, 2)
    assert.equal(rows.rows.find((row) => row.user_id === ownerId)?.state.custom, '保留')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
