// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isLiveEventPayload, isTrashPurgeProgressEvent } from '@/types/live-events'

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

describe('回收站清理进度事件', () => {
  const event = {
    protocol_version: 'live-event-v1',
    event_id: 'evt-purge-1',
    type: 'task.progress',
    task_type: 'trash_purge',
    task_id: 12,
    status: 'running',
    progress_current: 10,
    progress_total: 24,
    failed_count: 0,
    created_at: '2026-10-06T00:00:00Z',
  }

  it('接受有效进度，并拒绝错误任务或非法计数', () => {
    expect(isTrashPurgeProgressEvent(event)).toBe(true)
    expect(isTrashPurgeProgressEvent({ ...event, task_type: 'other' })).toBe(false)
    expect(isTrashPurgeProgressEvent({ ...event, progress_current: -1 })).toBe(false)
  })
})
