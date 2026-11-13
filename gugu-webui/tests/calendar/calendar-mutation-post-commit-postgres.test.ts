import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import type { CalendarEventDeletePublication } from '../../src/domains/calendar/application/event-delete.js'
import { createCalendarMutationPostCommitPublisher } from '../../src/domains/calendar/persistence/calendar-mutation-post-commit-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

async function withDatabase(work: (pool: Pool) => Promise<void>) {
  const schema = `gugu_calendar_mutation_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 3,
  })
  try {
    // Isolated test copy of the existing Alembic-managed durable queue contract.
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

test('calendar update/delete and reminder changes coalesce IDs into their durable source rows', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const contextBumps: string[] = []
  const liveEvents: unknown[] = []
  const failures: Array<{ operation: string; code?: string; message?: string }> = []
  const publish = createCalendarMutationPostCommitPublisher(pool, {
    async bumpContextRevision(id) { contextBumps.push(id); return true },
    async publishResourceChanged(event) { liveEvents.push(event); return true },
  }, (operation, code, message) => failures.push({ operation, code, message }))

  await publish({
    ownerId, resource: 'calendar', origin: null, operation: 'update', entityId: 51,
    payload: {
      id: 51, title: 'Synthetic', date: '2026-11-13', time: null, endTime: null,
      type: 'event', client: null, projectId: null, description: null, version: 2,
    },
  })
  await publish({
    ownerId, resource: 'calendar', origin: null, operation: 'delete', entityId: 52,
  } satisfies CalendarEventDeletePublication)
  await publish({
    ownerId, resource: 'scheduled_tasks', origin: null, operation: 'update', entityIds: [7, 8],
  } satisfies CalendarEventDeletePublication)

  assert.deepEqual(failures, [], 'post-commit effects must execute against the isolated schema contract')
  const jobs = await pool.query<{
    source_type: string; source_id: string; version: string; operation: string; status: string;
    generation: number; pending_source_ids: string[];
  }>(`SELECT source_type, source_id, version, operation, status, generation, pending_source_ids
      FROM rag_index_jobs ORDER BY source_type`)
  assert.deepEqual(jobs.rows, [
    {
      source_type: 'calendar', source_id: '52', version: '', operation: 'delete', status: 'queued',
      generation: 2, pending_source_ids: ['51', '52'],
    },
    {
      source_type: 'scheduled_task', source_id: '8', version: '', operation: 'update', status: 'queued',
      generation: 2, pending_source_ids: ['7', '8'],
    },
  ])
  assert.deepEqual(contextBumps, [ownerId, ownerId])
  assert.equal(liveEvents.length, 3, 'the existing live-event callback is delegated once per publication')
}))
