import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createCalendarEvent } from '../../src/domains/calendar/application/event-create.js'
import { createCalendarEventPostCommitPublisher } from '../../src/domains/calendar/persistence/calendar-create-post-commit-postgres.js'
import { createPostgresEventCreateStore } from '../../src/domains/calendar/persistence/event-create-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

async function withDatabase(work: (pool: Pool) => Promise<void>) {
  const schema = `gugu_calendar_postcommit_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 5,
  })
  try {
    await pool.query(`
      CREATE TABLE projects (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        deleted_at timestamptz
      )
    `)
    await pool.query(`
      CREATE TABLE calendar_events (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        title varchar(300) NOT NULL,
        date varchar(10) NOT NULL,
        time varchar(5),
        end_time varchar(5),
        type varchar(50) NOT NULL,
        contact_name varchar(200),
        project_id integer,
        description text,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        deleted_at timestamptz,
        idempotency_key varchar(64),
        idempotency_fingerprint varchar(64),
        CONSTRAINT uq_calendar_events_user_idempotency_key UNIQUE(user_id, idempotency_key)
      )
    `)
    await pool.query(`
      CREATE TABLE undo_operations (
        id varchar(80) PRIMARY KEY,
        user_id uuid NOT NULL,
        undo_context_id varchar(128) NOT NULL,
        group_id varchar(80) NOT NULL,
        resource varchar(32) NOT NULL,
        action varchar(32) NOT NULL,
        target_refs json NOT NULL,
        before_state json NOT NULL,
        after_state json NOT NULL,
        base_versions json NOT NULL,
        artifact_refs json NOT NULL,
        actor_type varchar(32) NOT NULL DEFAULT 'web',
        status varchar(24) NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL,
        undone_at timestamptz,
        expires_at timestamptz,
        failure_code varchar(80)
      )
    `)
    // Mirrors the Alembic-owned production table contract. The test schema is isolated.
    await pool.query(`
      CREATE TABLE rag_index_jobs (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        source_type varchar(32) NOT NULL,
        source_id varchar(255) NOT NULL DEFAULT '',
        version varchar(64) NOT NULL DEFAULT '',
        operation varchar(24) NOT NULL DEFAULT 'upsert',
        status varchar(16) NOT NULL DEFAULT 'queued',
        generation integer NOT NULL DEFAULT 1,
        completed_generation integer NOT NULL DEFAULT 0,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        lease_until timestamptz,
        last_started_at timestamptz,
        last_succeeded_at timestamptz,
        last_error_code varchar(64),
        pending_source_ids json,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT uq_rag_index_job_user_source UNIQUE(user_id, source_type)
      )
    `)
    await work(pool)
  } finally {
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
}

test('calendar create commits before context/live effects and coalesces durable RAG entity IDs', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const effectOrder: string[] = []
  const failures: Array<{ operation: string; code?: string; message?: string }> = []
  const postCommit = createCalendarEventPostCommitPublisher({
    async bumpContextRevision(userId) {
      assert.equal(userId, ownerId)
      const committed = await pool.query('SELECT count(*)::int AS count FROM calendar_events')
      assert.ok(Number(committed.rows[0]?.count) >= 1, 'revision bump runs after event commit')
      const jobs = await pool.query('SELECT count(*)::int AS count FROM rag_index_jobs WHERE user_id=$1', [ownerId])
      assert.equal(jobs.rows[0]?.count, 1, 'RAG job commits with the event before post-commit effects')
      effectOrder.push('context')
      return true
    },
    async publishResourceChanged(event) {
      const committed = await pool.query('SELECT count(*)::int AS count FROM calendar_events')
      assert.ok(Number(committed.rows[0]?.count) >= 1, 'live event runs after event commit')
      assert.equal(event.resource, 'calendar')
      assert.equal(event.operation, 'create')
      effectOrder.push('resource')
      return true
    },
  }, (operation, code, message) => failures.push({ operation, code, message }))
  const store = createPostgresEventCreateStore(pool, postCommit)

  const first = await createCalendarEvent(store, {
    ownerId,
    input: { title: 'First', date: '2026-11-13' },
    undoContextId: 'synthetic-tab',
    clientId: 'synthetic-browser',
  })
  const second = await createCalendarEvent(store, {
    ownerId,
    input: { title: 'Second', date: '2026-11-14' },
  })

  assert.deepEqual(failures, [], 'post-commit effects must execute against the isolated schema contract')
  assert.deepEqual(effectOrder, ['context', 'resource', 'context', 'resource'])
  const job = await pool.query<{
    source_id: string; source_type: string; version: string; operation: string; status: string;
    generation: number; pending_source_ids: string[];
  }>(`SELECT source_id, source_type, version, operation, status, generation, pending_source_ids
      FROM rag_index_jobs WHERE user_id = $1`, [ownerId])
  assert.deepEqual(job.rows[0], {
    source_id: String(second.event.id),
    source_type: 'calendar',
    version: '',
    operation: 'create',
    status: 'queued',
    generation: 2,
    pending_source_ids: [String(first.event.id), String(second.event.id)],
  })
  const undoCount = await pool.query('SELECT count(*)::int AS count FROM undo_operations')
  assert.equal(undoCount.rows[0]?.count, 1, 'Undo still commits with the event transaction')
}))
