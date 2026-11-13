import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EventUpdateError,
  updateCalendarEvent,
  type EventUpdateStore,
} from '../../src/domains/calendar/application/event-update.js'
import {
  deleteCalendarEvent,
  EventDeleteError,
  type CalendarEventDeleteStore,
} from '../../src/domains/calendar/application/event-delete.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

test('calendar update looks up zero and negative IDs before returning the owner-scoped 404', async () => {
  const lookedUp: number[] = []
  const store = {
    transaction: async (_ownerId: string, work: (tx: never) => Promise<unknown>) => work({
      findOwnedActiveEvent: async (eventId: number) => {
        lookedUp.push(eventId)
        return null
      },
    } as never),
  } as unknown as EventUpdateStore

  for (const eventId of [0, -13]) {
    await assert.rejects(
      updateCalendarEvent(store, { ownerId, eventId, body: { version: 1 } }),
      (error: unknown) => error instanceof EventUpdateError && error.statusCode === 404,
    )
  }
  assert.deepEqual(lookedUp, [0, -13])
})

test('calendar delete looks up signed IDs before comparing signed versions', async () => {
  const lookedUp: number[] = []
  const missingStore = {
    transaction: async (_ownerId: string, work: (tx: never) => Promise<unknown>) => work({
      findOwnedActiveEvent: async (eventId: number) => {
        lookedUp.push(eventId)
        return null
      },
    } as never),
  } as unknown as CalendarEventDeleteStore

  await assert.rejects(
    deleteCalendarEvent(missingStore, { ownerId, eventId: -13, version: 0 }),
    (error: unknown) => error instanceof EventDeleteError && error.statusCode === 404,
  )
  assert.deepEqual(lookedUp, [-13])

  const existingStore = {
    transaction: async (_ownerId: string, work: (tx: never) => Promise<unknown>) => work({
      findOwnedActiveEvent: async () => ({ id: 13, version: 4 }),
    } as never),
  } as unknown as CalendarEventDeleteStore
  for (const version of [0, -1]) {
    await assert.rejects(
      deleteCalendarEvent(existingStore, { ownerId, eventId: 13, version }),
      (error: unknown) => error instanceof EventDeleteError && error.statusCode === 409,
    )
  }
})
