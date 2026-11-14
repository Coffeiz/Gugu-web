import { runBestEffort } from '../../../adapters/best-effort.js'
import type { EventCreatePublication } from '../application/event-create.js'

export interface CalendarCreatePostCommitEffects {
  /** Bump the user's context snapshot revision after the event transaction commits. */
  bumpContextRevision(ownerId: string): Promise<unknown>
  /** Publish the live resource.changed event after the event transaction commits. */
  publishResourceChanged(input: {
    ownerId: string
    resource: 'calendar'
    operation: 'create'
    entityId: number
    origin: string | null
    payload: EventCreatePublication['eventPayload']
  }): Promise<unknown>
}

export type CalendarCreatePostCommitFailureReporter = (operation: string, errorCode?: string, errorMessage?: string) => void

/**
 * Creates post-commit side effects for a committed calendar create.
 *
 * The durable RAG job is committed with the event. This adapter owns only
 * post-commit context and live-event effects.
 */
export function createCalendarEventPostCommitPublisher(
  effects: CalendarCreatePostCommitEffects,
  reportFailure: CalendarCreatePostCommitFailureReporter = (operation) => {
    console.error(`gugu-webui ${operation} failed`)
  },
): (publication: EventCreatePublication) => Promise<void> {
  return async (publication) => {
    await runBestEffort('calendar context revision', () =>
      effects.bumpContextRevision(publication.ownerId), reportFailure)

    await runBestEffort('calendar resource notification', () =>
      effects.publishResourceChanged({
        ownerId: publication.ownerId,
        resource: 'calendar',
        operation: 'create',
        entityId: publication.entityId,
        origin: publication.origin,
        payload: publication.eventPayload,
      }), reportFailure)
  }
}
