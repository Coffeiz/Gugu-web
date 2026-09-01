import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import { InteractionSyncEventQueue } from '@/interaction/sync/InteractionSyncEventQueue'
import type { LiveEventPayload } from '@/types/live-events'

const event = (overrides: Partial<LiveEventPayload> = {}): LiveEventPayload => ({
  protocol_version: 'live-event-v1', event_id: 'evt-1', type: 'resource.changed',
  resource: 'projects', operation: 'update', revision: 1, created_at: '2026-09-02T00:00:00Z',
  ...overrides,
})

describe('InteractionSync Phase 2/3', () => {
  beforeEach(() => InteractionSync.reset())
  afterEach(() => vi.useRealTimers())

  it('execute 统一提供即时 apply、请求确认和失败回滚', async () => {
    const order: string[] = []
    const result = await InteractionSync.execute({
      scope: 'test.note.update', entityKey: 'note:1',
      apply: () => order.push('apply'),
      afterMutate: () => order.push('after'),
      rollback: () => order.push('rollback'),
      request: async mutation => { order.push(`request:${mutation.clientId === InteractionSync.clientId}`); return 'ok' },
      onCommit: value => order.push(`commit:${value}`),
    })
    expect(result).toBe('ok')
    expect(order).toEqual(['apply', 'after', 'request:true', 'commit:ok'])

    await expect(InteractionSync.execute({
      scope: 'test.note.update', entityKey: 'note:2',
      apply: () => order.push('apply-fail'), afterMutate: () => {},
      rollback: () => order.push('rollback-fail'),
      request: async () => { throw new Error('failed') },
    })).rejects.toThrow('failed')
    expect(order.at(-1)).toBe('rollback-fail')
    expect(InteractionSync.pending()).toEqual([])
  })

  it('事件队列抑制本端回声，增量成功时不触发刷新，无法合并的事件按资源合并刷新', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const apply = vi.fn((current: LiveEventPayload) => current.operation === 'update')
    const queue = new InteractionSyncEventQueue()
    queue.register('projects', apply, refresh)

    expect(queue.receive(event({ origin: InteractionSync.clientId }))).toBe('echo')
    expect(queue.receive(event({ event_id: 'evt-update' }))).toBe('applied')
    expect(refresh).not.toHaveBeenCalled()

    expect(queue.receive(event({ event_id: 'evt-delete', operation: 'delete' }))).toBe('queued')
    expect(queue.receive(event({ event_id: 'evt-delete-2', operation: 'delete' }))).toBe('queued')
    vi.advanceTimersByTime(80)
    expect(refresh).toHaveBeenCalledOnce()

    queue.receive(event({ event_id: 'evt-delete-3', operation: 'delete' }))
    queue.flush('projects')
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('不同资源分别保序，并将无法增量合并的事件各自合并刷新', async () => {
    vi.useFakeTimers()
    const applied: string[] = []
    const refreshed: string[] = []
    const queue = new InteractionSyncEventQueue()
    queue.register('projects', current => {
      applied.push(`projects:${current.event_id}`)
      return false
    }, () => refreshed.push('projects'))
    queue.register('calendar', current => {
      applied.push(`calendar:${current.event_id}`)
      return false
    }, () => refreshed.push('calendar'))

    queue.receive(event({ resource: 'projects', event_id: 'project-1' }))
    queue.receive(event({ resource: 'calendar', event_id: 'calendar-1' }))
    queue.receive(event({ resource: 'projects', event_id: 'project-2' }))
    expect(applied).toEqual(['projects:project-1', 'calendar:calendar-1', 'projects:project-2'])
    vi.advanceTimersByTime(80)
    expect(refreshed).toEqual(['projects', 'calendar'])
  })
})
