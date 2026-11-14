import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { EventUpdateError, updateCalendarEvent } from '../../src/domains/calendar/application/event-update.js'
import { createPostgresEventUpdateStore } from '../../src/domains/calendar/persistence/event-update-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = '3f5cfa3d-9cb7-46af-923e-8ef0eb3e7da2'

async function withDatabase(work: (pool: Pool) => Promise<void>) {
  const schema = `gugu_event_update_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 6,
  })
  try {
    await pool.query(`
      CREATE TABLE projects (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
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
        type varchar(50) NOT NULL DEFAULT 'event',
        contact_name varchar(200),
        project_id integer,
        description text,
        version integer NOT NULL,
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
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await pool.query(`
      CREATE UNIQUE INDEX uq_scheduled_tasks_event_fire
      ON scheduled_tasks(user_id, event_id, cron) WHERE event_id IS NOT NULL
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

async function seed(pool: Pool, withReminders = true) {
  await pool.query('INSERT INTO projects(id, user_id) VALUES (12, $1), (13, $2), (14, $1)', [ownerId, otherOwnerId])
  await pool.query('UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = 14')
  const event = await pool.query<{ id: number }>(
    `INSERT INTO calendar_events(user_id, title, date, time, project_id, version)
     VALUES ($1, 'Old title', '2099-01-02', '10:00', 12, 3) RETURNING id`, [ownerId],
  )
  const eventId = event.rows[0]!.id
  const taskIds: number[] = []
  if (withReminders) {
    const tasks = [
      { lead: 30, enabled: true, cron: '@once:2099-01-02T01:30:00+00:00', start: '2099-01-02T01:30:00.000Z' },
      { lead: 150, enabled: true, cron: '@once:2099-01-01T23:30:00+00:00', start: '2099-01-01T23:30:00.000Z' },
      { lead: 60, enabled: false, cron: '@once:2099-01-02T01:00:00+00:00', start: '2099-01-02T01:00:00.000Z' },
    ]
    for (const [index, task] of tasks.entries()) {
      const result = await pool.query<{ id: number }>(
        `INSERT INTO scheduled_tasks (
           user_id, event_id, reminder_lead_minutes, name, payload, cron,
           schedule_kind, start_at, channels, enabled, delivery_targets
         ) VALUES ($1, $2, $3, $4, $5, $6, 'once', $7, $8, $9, $10::json)
         RETURNING id`,
        [ownerId, eventId, task.lead, 'Old title 提醒', '提醒：Old title（2099-01-02 10:00）',
          task.cron, task.start, index === 1 ? 'qq,web' : 'web', task.enabled,
          JSON.stringify({ target: `synthetic-${index}` })],
      )
      taskIds.push(result.rows[0]!.id)
    }
  }
  return { eventId, taskIds }
}

test('PATCH validates owner project and atomically updates event, enabled reminders, Undo, and post-commit calendar event', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const { eventId, taskIds } = await seed(pool)
  const publications: unknown[] = []
  const store = createPostgresEventUpdateStore(pool, async (publication) => {
    const event = await pool.query<{ version: number; title: string }>(
      'SELECT version, title FROM calendar_events WHERE id = $1', [eventId],
    )
    const undo = await pool.query('SELECT id FROM undo_operations')
    assert.equal(event.rows[0]?.version, 4)
    assert.equal(event.rows[0]?.title, 'New title')
    assert.equal(undo.rows.length, 1, 'Undo is committed before publication')
    publications.push(publication)
  })

  const result = await updateCalendarEvent(store, {
    ownerId,
    eventId,
    body: { title: 'New title', date: '2099-01-03', time: '12:00', projectId: 12, version: 3 },
    undoContextId: 'calendar-tab',
    clientId: 'browser-tab',
  })

  assert.deepEqual(result, {
    id: eventId, title: 'New title', date: '2099-01-03', time: '12:00', endTime: null,
    type: 'event', client: null, projectId: 12, description: null, version: 4,
  })
  const reminders = await pool.query<{
    id: number; name: string; payload: string; cron: string; start_at: Date;
    reminder_lead_minutes: number; channels: string; enabled: boolean; delivery_targets: unknown;
  }>('SELECT * FROM scheduled_tasks WHERE event_id = $1 ORDER BY id', [eventId])
  assert.deepEqual(reminders.rows.map((task) => task.id), taskIds)
  assert.equal(reminders.rows[0]?.cron, '@once:2099-01-03T03:30:00+00:00')
  assert.equal(reminders.rows[0]?.start_at.toISOString(), '2099-01-03T03:30:00.000Z')
  assert.equal(reminders.rows[0]?.reminder_lead_minutes, 30)
  assert.equal(reminders.rows[1]?.cron, '@once:2099-01-03T01:30:00+00:00')
  assert.equal(reminders.rows[1]?.channels, 'qq,web')
  assert.equal(reminders.rows[2]?.cron, '@once:2099-01-02T01:00:00+00:00', 'disabled reminder schedule remains unchanged')
  assert.equal(reminders.rows[2]?.start_at.toISOString(), '2099-01-02T01:00:00.000Z')
  assert.equal(reminders.rows[2]?.enabled, false)
  assert.ok(reminders.rows.every((task) => task.name === 'New title 提醒'))
  assert.ok(reminders.rows.every((task) => task.payload === '提醒：New title（2099-01-03 12:00）'))

  const undo = await pool.query<{
    context: string; resource: string; action: string;
    target_refs: Array<{ kind: string; id: number }>;
    before_state: { items: Record<string, Record<string, unknown>> };
    after_state: { items: Record<string, Record<string, unknown>> };
    base_versions: Record<string, { version: number }>;
  }>(`SELECT undo_context_id AS context, resource, action, target_refs, before_state,
             after_state, base_versions FROM undo_operations`)
  const operation = undo.rows[0]!
  assert.equal(operation.context, 'calendar-tab')
  assert.equal(operation.resource, 'calendar')
  assert.equal(operation.action, 'update')
  assert.deepEqual(operation.target_refs.map((ref) => ref.kind), ['event', 'task', 'task', 'task'])
  assert.equal(operation.before_state.items[`event:${eventId}`]?.version, 3)
  assert.equal(operation.after_state.items[`event:${eventId}`]?.version, 4)
  assert.equal(operation.before_state.items[`event:${eventId}`]?.title, 'Old title')
  assert.equal(operation.after_state.items[`event:${eventId}`]?.title, 'New title')
  assert.equal(operation.before_state.items[`task:${taskIds[0]}`]?.cron, '@once:2099-01-02T01:30:00+00:00')
  assert.equal(operation.after_state.items[`task:${taskIds[0]}`]?.cron, '@once:2099-01-03T03:30:00+00:00')
  assert.equal(operation.before_state.items[`task:${taskIds[2]}`]?.cron, operation.after_state.items[`task:${taskIds[2]}`]?.cron)
  assert.equal(operation.base_versions[`event:${eventId}`]?.version, 3)
  assert.equal(operation.base_versions[`task:${taskIds[0]}`]?.version, 0)
  assert.deepEqual(publications, [{
    ownerId, resource: 'calendar', origin: 'browser-tab', operation: 'update',
    entityId: eventId, payload: result,
  }])
}))

test('empty PATCH returns the current event without a version change, Undo, reminder write, or publication', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const { eventId } = await seed(pool)
  let publicationCount = 0
  const store = createPostgresEventUpdateStore(pool, async () => { publicationCount += 1 })
  const result = await updateCalendarEvent(store, { ownerId, eventId, body: { version: 3 } })
  assert.equal(result.version, 3)
  const undo = await pool.query('SELECT id FROM undo_operations')
  assert.equal(undo.rows.length, 0)
  assert.equal(publicationCount, 0)
  const task = await pool.query<{ cron: string }>(
    'SELECT cron FROM scheduled_tasks WHERE event_id = $1 ORDER BY id LIMIT 1', [eventId],
  )
  assert.equal(task.rows[0]?.cron, '@once:2099-01-02T01:30:00+00:00')
}))

test('PATCH stages enabled reminder crons before rescheduling into another reminder’s old slot', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const { eventId } = await seed(pool)
  const store = createPostgresEventUpdateStore(pool, async () => undefined)
  await updateCalendarEvent(store, {
    ownerId, eventId, body: { time: '08:00', version: 3 },
  })
  const tasks = await pool.query<{ cron: string }>(
    'SELECT cron FROM scheduled_tasks WHERE event_id = $1 AND enabled ORDER BY id', [eventId],
  )
  assert.deepEqual(tasks.rows.map((task) => task.cron), [
    '@once:2099-01-01T23:30:00+00:00',
    '@once:2099-01-01T21:30:00+00:00',
  ])
}))

test('PATCH rejects missing, foreign, soft-deleted, stale events and foreign/deleted projects without writes', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const { eventId } = await seed(pool, false)
  const deleted = await pool.query<{ id: number }>(
    `INSERT INTO calendar_events(user_id, title, date, version, deleted_at)
     VALUES ($1, 'Deleted', '2099-01-02', 3, CURRENT_TIMESTAMP) RETURNING id`, [ownerId],
  )
  const store = createPostgresEventUpdateStore(pool, async () => assert.fail('rejected PATCH must not publish'))
  const requests = [
    { ownerId: otherOwnerId, eventId, body: { title: 'No', version: 3 }, status: 404 },
    { ownerId, eventId: deleted.rows[0]!.id, body: { title: 'No', version: 3 }, status: 404 },
    { ownerId, eventId: 999, body: { title: 'No', version: 3 }, status: 404 },
    { ownerId, eventId, body: { title: 'No', version: 2 }, status: 409 },
    { ownerId, eventId, body: { projectId: 13, version: 3 }, status: 400 },
    { ownerId, eventId, body: { projectId: 14, version: 3 }, status: 400 },
  ] as const
  for (const request of requests) {
    await assert.rejects(
      updateCalendarEvent(store, request),
      (error: unknown) => error instanceof EventUpdateError && error.statusCode === request.status,
    )
  }
  const event = await pool.query<{ title: string; version: number; project_id: number }>(
    'SELECT title, version, project_id FROM calendar_events WHERE id = $1', [eventId],
  )
  assert.deepEqual(event.rows[0], { title: 'Old title', version: 3, project_id: 12 })
  const undo = await pool.query('SELECT id FROM undo_operations')
  assert.equal(undo.rows.length, 0)
}))

test('invalid reminder reschedule rolls back event and reminder changes without Undo or publication', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const { eventId } = await seed(pool)
  let publicationCount = 0
  const store = createPostgresEventUpdateStore(pool, async () => { publicationCount += 1 })
  await assert.rejects(
    updateCalendarEvent(store, {
      ownerId, eventId, body: { title: 'Rejected', date: '2000-01-01', time: '12:00', version: 3 },
      undoContextId: 'calendar-tab',
    }),
    (error: unknown) => error instanceof EventUpdateError
      && error.statusCode === 422 && error.message.includes('跳过'),
  )
  const event = await pool.query<{ title: string; date: string; version: number }>(
    'SELECT title, date, version FROM calendar_events WHERE id = $1', [eventId],
  )
  assert.deepEqual(event.rows[0], { title: 'Old title', date: '2099-01-02', version: 3 })
  const tasks = await pool.query<{ cron: string; name: string }>(
    'SELECT cron, name FROM scheduled_tasks WHERE event_id = $1 ORDER BY id', [eventId],
  )
  assert.equal(tasks.rows[0]?.cron, '@once:2099-01-02T01:30:00+00:00')
  assert.equal(tasks.rows[0]?.name, 'Old title 提醒')
  assert.equal((await pool.query('SELECT id FROM undo_operations')).rows.length, 0)
  assert.equal(publicationCount, 0)
}))

test('PATCH rolls event and reminder edits back when the Undo write fails', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const { eventId } = await seed(pool)
  let publicationCount = 0
  const store = createPostgresEventUpdateStore(pool, async () => { publicationCount += 1 })
  await pool.query(`
    CREATE FUNCTION fail_update_undo() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic undo failure'; END
    $$
  `)
  await pool.query(`CREATE TRIGGER fail_update_undo BEFORE INSERT ON undo_operations
                    FOR EACH ROW EXECUTE FUNCTION fail_update_undo()`)
  await assert.rejects(
    updateCalendarEvent(store, {
      ownerId, eventId, body: { title: 'Rejected', time: '12:00', version: 3 },
      undoContextId: 'calendar-tab',
    }),
    /synthetic undo failure/,
  )
  const event = await pool.query<{ title: string; time: string; version: number }>(
    'SELECT title, time, version FROM calendar_events WHERE id = $1', [eventId],
  )
  assert.deepEqual(event.rows[0], { title: 'Old title', time: '10:00', version: 3 })
  const tasks = await pool.query<{ cron: string; name: string }>(
    'SELECT cron, name FROM scheduled_tasks WHERE event_id = $1 ORDER BY id', [eventId],
  )
  assert.equal(tasks.rows[0]?.cron, '@once:2099-01-02T01:30:00+00:00')
  assert.equal(tasks.rows[0]?.name, 'Old title 提醒')
  assert.equal(publicationCount, 0)
}))

test('PATCH notification failure is diagnostic-only after the event and Undo commit', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const { eventId } = await seed(pool, false)
  const diagnostics: string[] = []
  const store = createPostgresEventUpdateStore(
    pool,
    async () => { throw new Error('synthetic publisher failure') },
    (operation) => diagnostics.push(operation),
  )
  const result = await updateCalendarEvent(store, {
    ownerId, eventId, body: { title: 'Committed title', version: 3 }, undoContextId: 'calendar-tab',
  })
  assert.equal(result.title, 'Committed title')
  assert.deepEqual(diagnostics, ['calendar event notification'])
  const event = await pool.query<{ title: string; version: number }>(
    'SELECT title, version FROM calendar_events WHERE id = $1', [eventId],
  )
  assert.deepEqual(event.rows[0], { title: 'Committed title', version: 4 })
  assert.equal((await pool.query('SELECT id FROM undo_operations')).rows.length, 1)
}))

test('concurrent PATCHes with the same version cannot overwrite one another', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const { eventId } = await seed(pool, false)
  let publicationCount = 0
  const store = createPostgresEventUpdateStore(pool, async () => { publicationCount += 1 })
  const results = await Promise.allSettled([
    updateCalendarEvent(store, {
      ownerId, eventId, body: { title: 'Winner A', version: 3 }, undoContextId: 'calendar-tab',
    }),
    updateCalendarEvent(store, {
      ownerId, eventId, body: { title: 'Winner B', version: 3 }, undoContextId: 'calendar-tab',
    }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = results.find((result) => result.status === 'rejected')
  assert.ok(rejected && rejected.status === 'rejected')
  assert.ok(rejected.reason instanceof EventUpdateError)
  assert.equal(rejected.reason.statusCode, 409)
  const event = await pool.query<{ title: string; version: number }>(
    'SELECT title, version FROM calendar_events WHERE id = $1', [eventId],
  )
  assert.ok(['Winner A', 'Winner B'].includes(event.rows[0]?.title ?? ''))
  assert.equal(event.rows[0]?.version, 4)
  assert.equal(publicationCount, 1)
  assert.equal((await pool.query('SELECT id FROM undo_operations')).rows.length, 1)
}))
