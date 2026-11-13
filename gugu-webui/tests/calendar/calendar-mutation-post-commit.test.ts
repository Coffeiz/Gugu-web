import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import type { EventUpdatePublication } from '../../src/domains/calendar/application/event-update.js'
import type { CalendarEventDeletePublication } from '../../src/domains/calendar/application/event-delete.js'
import { createCalendarMutationPostCommitPublisher } from '../../src/domains/calendar/persistence/calendar-mutation-post-commit-postgres.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const updatePublication: EventUpdatePublication = {
  ownerId, resource: 'calendar', origin: 'synthetic-tab', operation: 'update', entityId: 51,
  payload: {
    id: 51, title: 'Updated synthetic event', date: '2026-11-14', time: null,
    endTime: null, type: 'event', client: null, projectId: null,
    description: null, version: 2,
  },
}

test('PATCH bumps context, durably enqueues calendar upsert, and delegates one live event', async () => {
  const calls: Array<{ kind: string; value?: unknown; sql?: string; values?: unknown[] }> = []
  const pool = {
    async query(sql: string, values: unknown[]) {
      calls.push({ kind: 'queue', sql, values })
      return { rows: [], rowCount: 1 }
    },
  } as unknown as Pool
  const publish = createCalendarMutationPostCommitPublisher(pool, {
    async bumpContextRevision(id) { calls.push({ kind: 'context', value: id }); return true },
    async publishResourceChanged(event) { calls.push({ kind: 'live', value: event }); return true },
  })

  await publish(updatePublication)

  assert.deepEqual(calls.map((call) => call.kind), ['context', 'queue', 'live'])
  assert.equal(calls[0]?.value, ownerId)
  assert.match(calls[1]?.sql ?? '', /INSERT INTO rag_index_jobs/)
  assert.deepEqual(calls[1]?.values, [ownerId, 'calendar', '51', 'update'])
  assert.deepEqual(calls[2]?.value, updatePublication)
})

test('DELETE coalesces calendar and reminder IDs while publishing each existing live change once', async () => {
  const calls: Array<{ kind: string; value?: unknown; values?: unknown[] }> = []
  const pool = {
    async query(_sql: string, values: unknown[]) {
      calls.push({ kind: 'queue', values })
      return { rows: [], rowCount: 1 }
    },
  } as unknown as Pool
  const publish = createCalendarMutationPostCommitPublisher(pool, {
    async bumpContextRevision(id) { calls.push({ kind: 'context', value: id }); return true },
    async publishResourceChanged(event) { calls.push({ kind: 'live', value: event }); return true },
  })
  const calendarDelete: CalendarEventDeletePublication = {
    ownerId, resource: 'calendar', origin: 'synthetic-tab', operation: 'delete', entityId: 51,
  }
  const reminderUpdate: CalendarEventDeletePublication = {
    ownerId, resource: 'scheduled_tasks', origin: 'synthetic-tab', operation: 'update', entityIds: [7, 8],
  }

  await publish(calendarDelete)
  await publish(reminderUpdate)

  assert.deepEqual(calls.map((call) => call.kind), [
    'context', 'queue', 'live', 'queue', 'queue', 'live',
  ])
  assert.deepEqual(calls.filter((call) => call.kind === 'queue').map((call) => call.values), [
    [ownerId, 'calendar', '51', 'delete'],
    [ownerId, 'scheduled_task', '7', 'update'],
    [ownerId, 'scheduled_task', '8', 'update'],
  ])
  assert.deepEqual(calls.filter((call) => call.kind === 'live').map((call) => call.value), [
    calendarDelete, reminderUpdate,
  ])
})

test('failed context, queue, or live effects do not block later post-commit effects', async () => {
  const attempted: string[] = []
  const report: string[] = []
  const pool = {
    async query(_sql: string, values: unknown[]) {
      attempted.push(`queue:${String(values[2])}`)
      throw new Error('synthetic database detail')
    },
  } as unknown as Pool
  const publish = createCalendarMutationPostCommitPublisher(pool, {
    async bumpContextRevision() { attempted.push('context'); throw new Error('synthetic redis detail') },
    async publishResourceChanged(event) {
      attempted.push(`live:${event.resource}`)
      throw new Error('synthetic publisher detail')
    },
  }, (operation) => report.push(operation))

  await assert.doesNotReject(publish(updatePublication))
  assert.deepEqual(attempted, ['context', 'queue:51', 'live:calendar'])
  assert.deepEqual(report, [
    'calendar context revision', 'calendar RAG index enqueue', 'calendar resource notification',
  ])
})
