import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CalendarEventIdempotencyUniqueViolation,
  calendarEventFingerprint,
  createCalendarEvent,
  EventCreateError,
  parseEventCreateInput,
  type CalendarEventCreateInput,
  type CalendarEventRecord,
  type EventCreateStore,
  type EventCreateTransaction,
} from '../../src/domains/calendar/application/event-create.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const input: CalendarEventCreateInput = {
  title: 'Review design',
  date: '2026-11-13',
  time: '09:30',
  end_time: '10:00',
  type: 'meeting',
  client: 'Synthetic client',
  project_id: 12,
  description: 'Synthetic description',
}

function event(overrides: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id: 31,
    ...input,
    version: 1,
    deleted_at: null,
    ...overrides,
  }
}

function makeStore(options: {
  existing?: { fingerprint: string; event: CalendarEventRecord } | null
  projectOwned?: boolean
  insertError?: Error
  publishedError?: Error
} = {}) {
  const calls: string[] = []
  let committed = false
  const tx: EventCreateTransaction = {
    async findIdempotent() {
      calls.push('findIdempotent')
      return options.existing ?? null
    },
    async projectExistsForOwner(projectId) {
      calls.push(`project:${projectId}`)
      return options.projectOwned ?? true
    },
    async insertWithSavepoint(payload) {
      calls.push('insertWithSavepoint')
      if (options.insertError) throw options.insertError
      assert.deepEqual(payload, input)
      return event()
    },
    async recordUndo(record) {
      calls.push('recordUndo')
      assert.deepEqual(record, {
        contextId: 'tab-1',
        resource: 'calendar',
        action: 'create',
        targetRefs: [{ kind: 'event', id: 31 }],
        beforeState: { items: {} },
        afterState: { items: { 'event:31': event() } },
        baseVersions: { 'event:31': { version: 0 } },
      })
    },
  }
  const store: EventCreateStore = {
    async transaction(actualOwner, work) {
      calls.push(`transaction:${actualOwner}:begin`)
      try {
        const result = await work(tx)
        committed = true
        calls.push('transaction:commit')
        return result
      } catch (error) {
        calls.push('transaction:rollback')
        throw error
      }
    },
    async publishCalendarEvent(publication) {
      calls.push('publish')
      assert.equal(committed, true, 'event notification must happen after the transaction commits')
      assert.deepEqual(publication, {
        ownerId,
        origin: 'browser-tab-1',
        operation: 'create',
        entityId: 31,
        eventPayload: {
          id: 31,
          title: input.title,
          date: input.date,
          time: input.time,
          endTime: input.end_time,
          type: input.type,
          client: input.client,
          projectId: input.project_id,
          description: input.description,
          version: 1,
        },
      })
      if (options.publishedError) throw options.publishedError
    },
  }
  return { store, calls }
}

test('a new event checks an owner project, records undo atomically, then publishes the committed response', async () => {
  const { store, calls } = makeStore()
  const result = await createCalendarEvent(store, {
    ownerId,
    input,
    idempotencyKey: 'create-event-1',
    undoContextId: 'tab-1',
    clientId: 'browser-tab-1',
  })

  assert.equal(result.created, true)
  assert.deepEqual(result.event, {
    id: 31,
    title: input.title,
    date: input.date,
    time: input.time,
    endTime: input.end_time,
    type: input.type,
    client: input.client,
    projectId: input.project_id,
    description: input.description,
    version: 1,
  })
  assert.deepEqual(calls, [
    `transaction:${ownerId}:begin`, 'findIdempotent', 'project:12',
    'insertWithSavepoint', 'recordUndo', 'transaction:commit', 'publish',
  ])
})

test('same owner key and payload return the original event without a second write, undo, or publication', async () => {
  const { store, calls } = makeStore({
    existing: { fingerprint: calendarEventFingerprint(input), event: event({ id: 8 }) },
  })
  const result = await createCalendarEvent(store, { ownerId, input, idempotencyKey: 'replay-key' })

  assert.equal(result.created, false)
  assert.equal(result.event.id, 8)
  assert.deepEqual(calls, [`transaction:${ownerId}:begin`, 'findIdempotent', 'transaction:commit'])
})

test('reusing a key with different content conflicts without creating or publishing', async () => {
  const { store, calls } = makeStore({
    existing: {
      fingerprint: calendarEventFingerprint({ ...input, title: 'Different event' }),
      event: event({ id: 8 }),
    },
  })

  await assert.rejects(
    createCalendarEvent(store, { ownerId, input, idempotencyKey: 'replay-key' }),
    (error: unknown) => error instanceof EventCreateError && error.statusCode === 409,
  )
  assert.deepEqual(calls, [`transaction:${ownerId}:begin`, 'findIdempotent', 'transaction:rollback'])
})

test('a missing or another owner’s project is rejected before writing', async () => {
  const { store, calls } = makeStore({ projectOwned: false })

  await assert.rejects(
    createCalendarEvent(store, { ownerId, input, idempotencyKey: 'new-key' }),
    (error: unknown) => error instanceof EventCreateError
      && error.statusCode === 400 && error.message === '关联的项目不存在',
  )
  assert.deepEqual(calls, [
    `transaction:${ownerId}:begin`, 'findIdempotent', 'project:12', 'transaction:rollback',
  ])
})

test('a concurrent idempotency winner is reread after the insert savepoint rolls back', async () => {
  const winner = event({ id: 42 })
  const calls: string[] = []
  let committed = false
  let findCount = 0
  const tx: EventCreateTransaction = {
    async findIdempotent() {
      calls.push('findIdempotent')
      findCount += 1
      return findCount === 1 ? null : { fingerprint: calendarEventFingerprint(input), event: winner }
    },
    async projectExistsForOwner() { calls.push('project'); return true },
    async insertWithSavepoint() {
      calls.push('insert')
      throw new CalendarEventIdempotencyUniqueViolation()
    },
    async recordUndo() { calls.push('undo') },
  }
  const store: EventCreateStore = {
    async transaction(_owner, work) {
      const result = await work(tx)
      committed = true
      return result
    },
    async publishCalendarEvent() { calls.push('publish') },
  }
  const result = await createCalendarEvent(store, { ownerId, input, idempotencyKey: 'new-key' })

  assert.equal(result.created, false)
  assert.equal(result.event.id, winner.id)
  assert.equal(committed, true)
  assert.deepEqual(calls, ['findIdempotent', 'project', 'insert', 'findIdempotent'])
})

test('invalid idempotency keys are rejected before opening a transaction', async () => {
  const { store, calls } = makeStore()
  for (const idempotencyKey of ['   ', 'x'.repeat(257)]) {
    await assert.rejects(
      createCalendarEvent(store, { ownerId, input, idempotencyKey }),
      (error: unknown) => error instanceof EventCreateError && error.statusCode === 422,
    )
  }
  assert.deepEqual(calls, [])
})

test('input aliases normalize to Python model_dump fields and malformed fields are rejected', () => {
  assert.deepEqual(parseEventCreateInput({
    title: 'Review design', date: '2026-11-13', endTime: '10:00', projectId: 12,
  }), {
    title: 'Review design', date: '2026-11-13', time: null, end_time: '10:00',
    type: 'event', client: null, project_id: 12, description: null,
  })
  assert.throws(
    () => parseEventCreateInput({ ...input, project_id: 1.5 }),
    (error: unknown) => error instanceof EventCreateError && error.statusCode === 422,
  )
  assert.throws(
    () => parseEventCreateInput({ title: 'Missing date' }),
    (error: unknown) => error instanceof EventCreateError && error.statusCode === 422,
  )
  assert.throws(
    () => parseEventCreateInput({ ...input, time: 930 }),
    (error: unknown) => error instanceof EventCreateError && error.statusCode === 422,
  )
})

test('a publication failure is best-effort after event and undo have committed', async () => {
  const { store, calls } = makeStore({ publishedError: new Error('event publisher unavailable') })
  const result = await createCalendarEvent(store, {
    ownerId, input, undoContextId: 'tab-1', clientId: 'browser-tab-1',
  })
  assert.equal(result.created, true)
  assert.equal(result.event.id, 31)
  assert.equal(calls.at(-2), 'transaction:commit')
  assert.equal(calls.at(-1), 'publish')
})
