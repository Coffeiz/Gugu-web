import assert from 'node:assert/strict'
import test from 'node:test'
import type { EventCreatePublication } from '../../src/domains/calendar/application/event-create.js'
import { createCalendarEventPostCommitPublisher } from '../../src/domains/calendar/persistence/calendar-create-post-commit-postgres.js'

const publication: EventCreatePublication = {
  ownerId: '9e51a4bf-07e1-4db8-9050-54a8c7356e8d',
  origin: 'browser-tab-synthetic',
  operation: 'create',
  entityId: 41,
  eventPayload: {
    id: 41, title: 'Synthetic event', date: '2026-11-13', time: null, endTime: null,
    type: 'event', client: null, projectId: null, description: null, version: 1,
  },
}

test('calendar create post-commit effects bump context then publish resource change', async () => {
  const calls: unknown[] = []
  const publish = createCalendarEventPostCommitPublisher({
    async bumpContextRevision(ownerId) { calls.push({ kind: 'context', ownerId }); return true },
    async publishResourceChanged(input) { calls.push({ kind: 'resource', input }); return true },
  })

  await publish(publication)

  assert.deepEqual(calls.map((call) => (call as { kind: string }).kind), ['context', 'resource'])
  assert.deepEqual(calls[0], { kind: 'context', ownerId: publication.ownerId })
  assert.deepEqual(calls[1], {
    kind: 'resource',
    input: {
      ownerId: publication.ownerId,
      resource: 'calendar',
      operation: 'create',
      entityId: 41,
      origin: publication.origin,
      payload: publication.eventPayload,
    },
  })
})

test('a failed post-commit effect is isolated and cannot suppress the later live event', async () => {
  const attempted: string[] = []
  const reports: string[] = []
  const publish = createCalendarEventPostCommitPublisher({
    async bumpContextRevision() { attempted.push('context'); throw new Error('synthetic context detail') },
    async publishResourceChanged() { attempted.push('resource'); throw new Error('synthetic redis detail') },
  }, (operation) => reports.push(operation))

  await assert.doesNotReject(publish(publication))
  assert.deepEqual(attempted, ['context', 'resource'])
  assert.deepEqual(reports, [
    'calendar context revision', 'calendar resource notification',
  ])
})
