import { describe, expect, it } from 'vitest'
import { isLiveEventPayload } from './live-events'

describe('live-event-v1', () => {
  it('接受待发队列变更事件供聊天窗口即时同步', () => {
    expect(isLiveEventPayload({
      protocol_version: 'live-event-v1',
      event_id: 'evt-pending-queue',
      type: 'resource.changed',
      resource: 'pending_queues',
      operation: 'update',
      entity_id: 388,
      revision: 1,
      created_at: '2026-09-12T00:00:00Z',
    })).toBe(true)
  })
})
