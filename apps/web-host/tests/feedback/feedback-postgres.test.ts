import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFeedbackOperations } from '../../src/domains/feedback/persistence/postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '74dc11bf-f2b6-47c7-a167-682b82a4af24'
const anotherOwnerId = '8eb6937d-b481-42d3-93b6-8215a431e784'

async function withDatabase(work: (pool: Pool) => Promise<void>) {
  const schema = `gugu_feedback_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  try {
    await pool.query(`CREATE TABLE feedbacks (
      id serial PRIMARY KEY,
      user_id uuid,
      username varchar(64) NOT NULL,
      category varchar(32) NOT NULL,
      content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await work(pool)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
}

test('feedback persists the authenticated owner and admin listing filters and pages the canonical rows', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const operations = createPostgresFeedbackOperations(pool)
  await operations.submit(ownerId, 'Moon Example', 'bug', 'Synthetic issue')
  await operations.submit(anotherOwnerId, 'Example User', 'suggestion', 'Synthetic idea')
  await operations.submit(ownerId, 'Moon Example', 'bug', 'Second issue')

  const stored = await pool.query<{ user_id: string; username: string; content: string }>(
    'SELECT user_id, username, content FROM feedbacks WHERE category = $1', ['bug'],
  )
  assert.deepEqual(stored.rows.map((row) => [row.user_id, row.username, row.content]), [
    [ownerId, 'Moon Example', 'Synthetic issue'],
    [ownerId, 'Moon Example', 'Second issue'],
  ])
  const page = await operations.list(2, 1, 'bug')
  assert.equal(page.total, 2)
  assert.equal(page.items.length, 1)
  assert.equal((page.items[0] as { category: string }).category, 'bug')
  const all = await operations.list(1, 30, '')
  assert.equal(all.total, 3)
  assert.equal(all.items.length, 3)
}))
