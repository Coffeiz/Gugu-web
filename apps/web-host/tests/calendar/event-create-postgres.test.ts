import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { createKyselyCalendarCreateStore } from '../../../../packages/core/src/calendar/create-store.js'
import test from 'node:test'
import { createCalendarEvent, EventCreateError } from '@gugu/core/calendar'
import { calendarCreateStore } from './calendar-core-stores.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = '3f5cfa3d-9cb7-46af-923e-8ef0eb3e7da2'
const input = {
  title: 'Review design', date: '2026-11-13', time: '09:30', end_time: '10:00',
  type: 'meeting', client: 'Synthetic client', project_id: 12,
  description: 'Synthetic description',
}

async function withDatabase(work: (pool: Pool, coreRuntime: Awaited<ReturnType<typeof createPostgresRuntime>>) => Promise<void>) {
  const schema = `gugu_event_create_${randomUUID().replaceAll('-', '')}`
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
    const coreRuntime = await createPostgresRuntime({ url: databaseUrl!, schema })
    try { await work(pool, coreRuntime) } finally { await coreRuntime.close() }
  } finally {
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
}

test('PostgreSQL store scopes project and idempotency, writes Undo in the event transaction, then publishes', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool, coreRuntime) => {
  await pool.query('INSERT INTO projects(id, user_id, name) VALUES ($1, $2, $3)', [12, ownerId, 'Owned'])
  const publications: unknown[] = []
  const store = calendarCreateStore(coreRuntime, async (publication) => {
    const eventCount = await pool.query('SELECT count(*)::int AS count FROM calendar_events')
    const undoCount = await pool.query('SELECT count(*)::int AS count FROM undo_operations')
    const jobCount = await pool.query('SELECT count(*)::int AS count FROM rag_index_jobs')
    assert.equal(eventCount.rows[0]?.count, 1, 'publication runs after the event commit')
    assert.equal(undoCount.rows[0]?.count, 1, 'Undo commits with the event')
    assert.equal(jobCount.rows[0]?.count, 1, 'durable RAG job commits with the event')
    publications.push(publication)
  })
  const result = await createCalendarEvent(store, {
    ownerId, input, idempotencyKey: 'create-once', undoContextId: 'tab-1', clientId: 'browser-tab',
  })

  assert.equal(result.created, true)
  assert.equal(result.event.id, 1)
  const undo = await pool.query<{
    id: string; group_id: string; created_at: Date; expires_at: Date | null;
    user_id: string; undo_context_id: string; resource: string; action: string;
    target_refs: unknown; before_state: unknown; after_state: unknown; base_versions: unknown;
    actor_type: string; status: string;
  }>('SELECT * FROM undo_operations')
  assert.deepEqual(undo.rows[0], {
    id: undo.rows[0]?.id,
    user_id: ownerId,
    undo_context_id: 'tab-1',
    group_id: undo.rows[0]?.group_id,
    resource: 'calendar',
    action: 'create',
    target_refs: [{ kind: 'event', id: 1 }],
    before_state: { items: {} },
    after_state: { items: { 'event:1': {
      id: 1, title: input.title, date: input.date, time: input.time, end_time: input.end_time,
      type: input.type, client: input.client, project_id: 12, description: input.description,
      version: 1, deleted_at: null,
    } } },
    base_versions: { 'event:1': { version: 0 } },
    artifact_refs: {},
    actor_type: 'web',
    status: 'active',
    created_at: undo.rows[0]?.created_at,
    undone_at: null,
    expires_at: undo.rows[0]?.expires_at,
    failure_code: null,
  })
  assert.equal(publications.length, 1)
  assert.deepEqual(publications[0], {
    ownerId,
    origin: 'browser-tab',
    operation: 'create',
    entityId: 1,
    eventPayload: result.event,
  })
}))

test('PostgreSQL idempotency replays by owner, conflicts on changed payload, and survives concurrent inserts', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool, coreRuntime) => {
  let publicationCount = 0
  const store = calendarCreateStore(coreRuntime, async () => { publicationCount += 1 })
  const noProjectInput = { ...input, project_id: null }
  const [first, concurrent] = await Promise.all([
    createCalendarEvent(store, { ownerId, input: noProjectInput, idempotencyKey: 'same-key', undoContextId: 'tab-1' }),
    createCalendarEvent(store, { ownerId, input: noProjectInput, idempotencyKey: 'same-key', undoContextId: 'tab-1' }),
  ])
  assert.equal(first.event.id, concurrent.event.id)
  assert.equal(Number(first.created) + Number(concurrent.created), 1)

  const replay = await createCalendarEvent(store, { ownerId, input: noProjectInput, idempotencyKey: 'same-key' })
  assert.equal(replay.created, false)
  await assert.rejects(
    createCalendarEvent(store, {
      ownerId, input: { ...noProjectInput, title: 'Changed' }, idempotencyKey: 'same-key',
    }),
    (error: unknown) => error instanceof EventCreateError && error.statusCode === 409,
  )

  const otherOwner = await createCalendarEvent(store, {
    ownerId: otherOwnerId, input: noProjectInput, idempotencyKey: 'same-key',
  })
  assert.notEqual(otherOwner.event.id, first.event.id)
  const rows = await pool.query('SELECT count(*)::int AS count FROM calendar_events')
  assert.equal(rows.rows[0]?.count, 2)
  assert.equal(publicationCount, 2)
}))

test('PostgreSQL rejects missing, foreign, and soft-deleted projects before inserting', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool, coreRuntime) => {
  await pool.query('INSERT INTO projects(id, user_id, name, deleted_at) VALUES (12, $1, $2, NULL), (13, $3, $4, NULL), (14, $1, $5, CURRENT_TIMESTAMP)', [
    ownerId, 'Owned', otherOwnerId, 'Foreign', 'Deleted',
  ])
  let publications = 0
  const store = calendarCreateStore(coreRuntime, async () => { publications++ })
  for (const projectId of [99, 13, 14]) {
    await assert.rejects(
      createCalendarEvent(store, { ownerId, input: { ...input, project_id: projectId } }),
      (error: unknown) => error instanceof EventCreateError && error.statusCode === 400,
    )
  }
  const rows = await pool.query('SELECT count(*)::int AS count FROM calendar_events')
  assert.equal(rows.rows[0]?.count, 0)
  assert.equal(publications, 0)
}))

test('PostgreSQL rolls event back when Undo insert fails and keeps unrelated unique errors distinct', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool, coreRuntime) => {
  const store = calendarCreateStore(coreRuntime, async () => undefined)
  const noProjectInput = { ...input, project_id: null }
  await pool.query(`
    CREATE FUNCTION fail_event_undo() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic undo failure'; END
    $$
  `)
  await pool.query(`CREATE TRIGGER fail_event_undo BEFORE INSERT ON undo_operations
                    FOR EACH ROW EXECUTE FUNCTION fail_event_undo()`)
  await assert.rejects(createCalendarEvent(store, {
    ownerId, input: noProjectInput, undoContextId: 'tab-1',
  }), /synthetic undo failure/)
  let rows = await pool.query('SELECT count(*)::int AS count FROM calendar_events')
  assert.equal(rows.rows[0]?.count, 0)

  await pool.query('DROP TRIGGER fail_event_undo ON undo_operations')
  await pool.query('DROP FUNCTION fail_event_undo()')
  await pool.query('ALTER TABLE calendar_events ADD CONSTRAINT uq_test_event_title UNIQUE(title)')
  await createCalendarEvent(store, { ownerId, input: noProjectInput })
  await assert.rejects(
    createCalendarEvent(store, { ownerId, input: noProjectInput }),
    (error: unknown) => typeof error === 'object' && error !== null
      && 'constraint' in error && (error as { constraint?: unknown }).constraint === 'uq_test_event_title'
      && !(error instanceof Error && error.name === 'CalendarEventIdempotencyUniqueViolation'),
  )
  rows = await pool.query('SELECT count(*)::int AS count FROM calendar_events')
  assert.equal(rows.rows[0]?.count, 1)
}))

test('PostgreSQL rolls back event and Undo when the durable RAG job cannot be enqueued', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool, coreRuntime) => {
  let publications = 0
  const store = calendarCreateStore(coreRuntime, async () => { publications++ })
  await pool.query(`
    CREATE FUNCTION fail_calendar_rag_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic RAG enqueue failure'; END
    $$
  `)
  await pool.query(`CREATE TRIGGER fail_calendar_rag_enqueue BEFORE INSERT ON rag_index_jobs
                    FOR EACH ROW EXECUTE FUNCTION fail_calendar_rag_enqueue()`)

  await assert.rejects(createCalendarEvent(store, {
    ownerId, input: { ...input, project_id: null }, undoContextId: 'tab-1',
  }), /synthetic RAG enqueue failure/)
  const events = await pool.query('SELECT count(*)::int AS count FROM calendar_events')
  const undo = await pool.query('SELECT count(*)::int AS count FROM undo_operations')
  const jobs = await pool.query('SELECT count(*)::int AS count FROM rag_index_jobs')
  assert.equal(events.rows[0]?.count, 0)
  assert.equal(undo.rows[0]?.count, 0)
  assert.equal(jobs.rows[0]?.count, 0)
  assert.equal(publications, 0)
}))

test('PostgreSQL publisher failure is logged and does not fail the committed create', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool, coreRuntime) => {
  const diagnostics: string[] = []
  const noProjectInput = { ...input, project_id: null }
  const store = calendarCreateStore(
    coreRuntime,
    async () => { throw new Error('synthetic publisher failure') },
    (operation) => diagnostics.push(operation),
  )
  const result = await createCalendarEvent(store, { ownerId, input: noProjectInput, undoContextId: 'tab-1' })
  assert.equal(result.created, true)
  assert.deepEqual(diagnostics, ['calendar event notification'])
  const events = await pool.query('SELECT count(*)::int AS count FROM calendar_events')
  const undo = await pool.query('SELECT count(*)::int AS count FROM undo_operations')
  assert.equal(events.rows[0]?.count, 1)
  assert.equal(undo.rows[0]?.count, 1)
}))


test('PostgreSQL 独立 Core 连接并发合并同一日历索引任务', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool, coreRuntime) => {
  const schema = (await pool.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]!.schema
  const runtime = await createPostgresRuntime({ url: databaseUrl!, schema })
  try {
    let corePublications = 0
    let otherPublications = 0
    const core = createKyselyCalendarCreateStore(runtime.db, 'postgres', async () => { corePublications++ })
    const otherCore = calendarCreateStore(coreRuntime, async () => { otherPublications++ })
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => createCalendarEvent(
      index % 2 === 0 ? core : otherCore,
      { ownerId, input: { title: `混合并发 ${index}`, date: '2026-11-18' }, undoContextId: 'tab' },
    )))
    const job = (await pool.query<{ generation: number; pending_source_ids: string[]; status: string }>(
      "SELECT generation, pending_source_ids, status FROM rag_index_jobs WHERE user_id = $1 AND source_type = 'calendar'", [ownerId],
    )).rows[0]!
    assert.equal(job.generation, 12)
    assert.equal(job.status, 'queued')
    assert.equal(job.pending_source_ids.length, 12)
    assert.deepEqual(new Set(job.pending_source_ids), new Set(results.map(result => String(result.event.id))))
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM calendar_events')).rows[0].count, 12)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM undo_operations')).rows[0].count, 12)
    assert.equal(corePublications, 6)
    assert.equal(otherPublications, 6)
  } finally {
    await runtime.close()
  }
}))
