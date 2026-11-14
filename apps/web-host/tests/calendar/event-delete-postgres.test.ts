import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { deleteCalendarEvent, EventDeleteError } from '../../src/domains/calendar/application/event-delete.js'
import { createPostgresEventDeleteStore } from '../../src/domains/calendar/persistence/event-delete-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = '3f5cfa3d-9cb7-46af-923e-8ef0eb3e7da2'

async function withDatabase(work: (pool: Pool) => Promise<void>) {
  const schema = `gugu_event_delete_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 5,
  })
  try {
    await pool.query(`
      CREATE TABLE calendar_events (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        title varchar(300) NOT NULL,
        date varchar(10) NOT NULL,
        time varchar(5),
        end_time varchar(5),
        type varchar(50) NOT NULL DEFAULT 'event',
        contact_name varchar(200),
        project_id integer,
        description text,
        version integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at timestamptz
      )
    `)
    await pool.query(`
      CREATE TABLE scheduled_tasks (
        id serial PRIMARY KEY,
        user_id uuid,
        event_id integer,
        reminder_lead_minutes integer,
        name varchar(100) NOT NULL,
        payload text NOT NULL DEFAULT '',
        cron varchar(60) NOT NULL,
        schedule_kind varchar(16) NOT NULL DEFAULT 'cron',
        start_at timestamptz,
        channels varchar(40) NOT NULL DEFAULT 'chat,im',
        enabled boolean NOT NULL DEFAULT true,
        delivery_targets json,
        last_run_at timestamptz,
        last_run_failed boolean
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
    await work(pool)
  } finally {
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
}

async function seedEvent(pool: Pool, taskCount = 0) {
  const event = await pool.query<{ id: number }>(
    `INSERT INTO calendar_events(user_id, title, date, time, version)
     VALUES ($1, 'Design review', '2026-11-13', '09:30', 4) RETURNING id`,
    [ownerId],
  )
  const eventId = event.rows[0]!.id
  for (let index = 0; index < taskCount; index += 1) {
    await pool.query(
      `INSERT INTO scheduled_tasks (
         user_id, event_id, reminder_lead_minutes, name, payload, cron,
         schedule_kind, start_at, channels, enabled, delivery_targets
       ) VALUES ($1, $2, $3, $4, $5, $6, 'once', $7, 'web,qq', $8, $9::json)`,
      [ownerId, eventId, 30 + index, `Review reminder ${index}`, 'Reminder body',
        `@once:2026-11-13T09:${String(index).padStart(2, '0')}:00+00:00`,
        new Date('2026-11-13T09:00:00.000Z'), index === 1 ? false : true,
        JSON.stringify({ target: 'synthetic' })],
    )
  }
  return eventId
}

test('DELETE soft-deletes at the supplied version, disables reminders, records compatible Undo, and publishes after commit', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const eventId = await seedEvent(pool, 2)
  const publications: unknown[] = []
  const store = createPostgresEventDeleteStore(pool, async (publication) => {
    const event = await pool.query<{ version: number; deleted_at: Date | null }>(
      'SELECT version, deleted_at FROM calendar_events WHERE id = $1', [eventId],
    )
    const tasks = await pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM scheduled_tasks WHERE event_id = $1 ORDER BY id', [eventId],
    )
    const undo = await pool.query('SELECT id FROM undo_operations')
    assert.equal(event.rows[0]?.version, 5, 'publisher observes the committed event version')
    assert.ok(event.rows[0]?.deleted_at)
    assert.deepEqual(tasks.rows.map((task) => task.enabled), [false, false])
    assert.equal(undo.rows.length, 1, 'Undo is committed before publication')
    publications.push(publication)
  })

  await deleteCalendarEvent(store, {
    ownerId, eventId, version: 4, undoContextId: 'calendar-tab', clientId: 'browser-tab',
  })

  const undo = await pool.query<{
    user_id: string; undo_context_id: string; resource: string; action: string;
    target_refs: Array<{ kind: string; id: number }>;
    before_state: { items: Record<string, Record<string, unknown>> };
    after_state: { items: Record<string, Record<string, unknown>> };
    base_versions: Record<string, { version: number }>;
    actor_type: string; status: string;
  }>('SELECT * FROM undo_operations')
  const row = undo.rows[0]!
  assert.equal(row.user_id, ownerId)
  assert.equal(row.undo_context_id, 'calendar-tab')
  assert.equal(row.resource, 'calendar')
  assert.equal(row.action, 'delete')
  assert.deepEqual(row.target_refs.map((ref) => ref.kind), ['event', 'task', 'task'])
  assert.deepEqual(row.target_refs.map((ref) => ref.id).sort((a, b) => a - b), [1, 2, eventId].sort((a, b) => a - b))
  assert.equal(row.before_state.items[`event:${eventId}`]?.version, 4)
  assert.equal(row.after_state.items[`event:${eventId}`]?.version, 5)
  assert.ok(row.after_state.items[`event:${eventId}`]?.deleted_at)
  assert.deepEqual(row.before_state.items['task:1']?.enabled, true)
  assert.deepEqual(row.before_state.items['task:2']?.enabled, false)
  assert.deepEqual(row.after_state.items['task:1']?.enabled, false)
  assert.deepEqual(row.after_state.items['task:2']?.enabled, false)
  assert.equal(row.base_versions[`event:${eventId}`]?.version, 4)
  assert.equal(row.base_versions['task:1']?.version, 0)
  assert.equal(row.actor_type, 'web')
  assert.equal(row.status, 'active')

  assert.deepEqual(publications, [
    { ownerId, resource: 'calendar', origin: 'browser-tab', operation: 'delete', entityId: eventId },
    { ownerId, resource: 'scheduled_tasks', origin: 'browser-tab', operation: 'update', entityIds: [1, 2] },
  ])
}))

test('DELETE rejects missing, foreign, deleted, and stale event versions without side effects', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const eventId = await seedEvent(pool)
  const deletedId = await seedEvent(pool)
  await pool.query('UPDATE calendar_events SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [deletedId])
  const publications: unknown[] = []
  const store = createPostgresEventDeleteStore(pool, async (publication) => { publications.push(publication) })

  await assert.rejects(
    deleteCalendarEvent(store, { ownerId, eventId, version: 3 }),
    (error: unknown) => error instanceof EventDeleteError && error.statusCode === 409,
  )
  await assert.rejects(
    deleteCalendarEvent(store, { ownerId: otherOwnerId, eventId, version: 4 }),
    (error: unknown) => error instanceof EventDeleteError && error.statusCode === 404,
  )
  await assert.rejects(
    deleteCalendarEvent(store, { ownerId, eventId: deletedId, version: 4 }),
    (error: unknown) => error instanceof EventDeleteError && error.statusCode === 404,
  )
  await assert.rejects(
    deleteCalendarEvent(store, { ownerId, eventId: 999, version: 4 }),
    (error: unknown) => error instanceof EventDeleteError && error.statusCode === 404,
  )
  await deleteCalendarEvent(store, { ownerId, eventId, version: 4 })
  await assert.rejects(
    deleteCalendarEvent(store, { ownerId, eventId, version: 4 }),
    (error: unknown) => error instanceof EventDeleteError && error.statusCode === 404,
  )
  const event = await pool.query<{ version: number; deleted_at: Date | null }>(
    'SELECT version, deleted_at FROM calendar_events WHERE id = $1', [eventId],
  )
  assert.equal(event.rows[0]?.version, 5)
  assert.ok(event.rows[0]?.deleted_at)
  assert.equal(publications.length, 1)
}))

test('DELETE publishes only the calendar change when no reminders and no Undo context exist', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const eventId = await seedEvent(pool)
  const publications: unknown[] = []
  const store = createPostgresEventDeleteStore(pool, async (publication) => { publications.push(publication) })
  await deleteCalendarEvent(store, { ownerId, eventId, version: 4 })
  const undo = await pool.query('SELECT id FROM undo_operations')
  assert.equal(undo.rows.length, 0)
  assert.deepEqual(publications, [
    { ownerId, resource: 'calendar', origin: null, operation: 'delete', entityId: eventId },
  ])
}))

test('a new DELETE expires the existing undone branch in the same Undo history context', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const eventId = await seedEvent(pool)
  await pool.query(`
    INSERT INTO undo_operations (
      id, user_id, undo_context_id, group_id, resource, action,
      target_refs, before_state, after_state, base_versions, artifact_refs,
      actor_type, status, created_at, expires_at
    ) VALUES ('op-previous', $1, 'calendar-tab', 'group-previous', 'calendar', 'delete',
      '[]'::json, '{}'::json, '{}'::json, '{}'::json, '{}'::json,
      'web', 'undone', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days')
  `, [ownerId])
  const store = createPostgresEventDeleteStore(pool, async () => undefined)
  await deleteCalendarEvent(store, { ownerId, eventId, version: 4, undoContextId: 'calendar-tab' })
  const rows = await pool.query<{ id: string; status: string; failure_code: string | null }>(
    `SELECT id, status, failure_code FROM undo_operations WHERE user_id = $1`, [ownerId],
  )
  const previous = rows.rows.find((row) => row.id === 'op-previous')
  const created = rows.rows.find((row) => row.id !== 'op-previous')
  assert.equal(previous?.status, 'expired')
  assert.equal(previous?.failure_code, 'redo_cleared_by_new_operation')
  assert.equal(created?.status, 'active')
}))

test('DELETE rolls back event and reminder state if the Undo write fails', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const eventId = await seedEvent(pool, 1)
  const store = createPostgresEventDeleteStore(pool, async () => assert.fail('failed delete must not publish'))
  await pool.query(`
    CREATE FUNCTION fail_delete_undo() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic undo failure'; END
    $$
  `)
  await pool.query(`CREATE TRIGGER fail_delete_undo BEFORE INSERT ON undo_operations
                    FOR EACH ROW EXECUTE FUNCTION fail_delete_undo()`)
  await assert.rejects(
    deleteCalendarEvent(store, { ownerId, eventId, version: 4, undoContextId: 'calendar-tab' }),
    /synthetic undo failure/,
  )
  const event = await pool.query<{ version: number; deleted_at: Date | null }>(
    'SELECT version, deleted_at FROM calendar_events WHERE id = $1', [eventId],
  )
  const tasks = await pool.query<{ enabled: boolean }>(
    'SELECT enabled FROM scheduled_tasks WHERE event_id = $1', [eventId],
  )
  assert.deepEqual(event.rows[0], { version: 4, deleted_at: null })
  assert.deepEqual(tasks.rows.map((task) => task.enabled), [true])
}))

test('concurrent DELETE requests with the same version allow only one commit and publish', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const eventId = await seedEvent(pool, 1)
  let publicationCount = 0
  const store = createPostgresEventDeleteStore(pool, async () => { publicationCount += 1 })
  const results = await Promise.allSettled([
    deleteCalendarEvent(store, { ownerId, eventId, version: 4 }),
    deleteCalendarEvent(store, { ownerId, eventId, version: 4 }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejection = results.find((result) => result.status === 'rejected')
  assert.ok(rejection && rejection.status === 'rejected')
  assert.ok(rejection.reason instanceof EventDeleteError)
  assert.ok([404, 409].includes(rejection.reason.statusCode))
  const event = await pool.query<{ version: number; deleted_at: Date | null }>(
    'SELECT version, deleted_at FROM calendar_events WHERE id = $1', [eventId],
  )
  const task = await pool.query<{ enabled: boolean }>(
    'SELECT enabled FROM scheduled_tasks WHERE event_id = $1', [eventId],
  )
  assert.equal(event.rows[0]?.version, 5)
  assert.ok(event.rows[0]?.deleted_at)
  assert.deepEqual(task.rows.map((row) => row.enabled), [false])
  assert.equal(publicationCount, 2)
}))

test('DELETE notification failures are diagnostic-only after commit', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const eventId = await seedEvent(pool)
  const diagnostics: string[] = []
  const store = createPostgresEventDeleteStore(
    pool,
    async () => { throw new Error('synthetic publisher failure') },
    (operation) => diagnostics.push(operation),
  )
  await deleteCalendarEvent(store, { ownerId, eventId, version: 4 })
  assert.deepEqual(diagnostics, ['calendar event notification'])
  const event = await pool.query<{ version: number; deleted_at: Date | null }>(
    'SELECT version, deleted_at FROM calendar_events WHERE id = $1', [eventId],
  )
  assert.equal(event.rows[0]?.version, 5)
  assert.ok(event.rows[0]?.deleted_at)
}))
