// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFileSyncAdminEvents } from '@/composables/filesync/useFileSyncAdminEvents'

function event(eventId: string, revision: number) {
  return {
    protocol_version: 'live-event-v1', event_id: eventId,
    type: 'filesync.run.changed', run_id: 'run-synthetic-1', binding_id: 3,
    revision, created_at: '2026-10-07T00:00:00Z',
  }
}

function responseWithEvents(events: unknown[]) {
  const frames = events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (frames) controller.enqueue(new TextEncoder().encode(frames))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

afterEach(() => vi.useRealTimers())

describe('Admin 文件同步 SSE 失效订阅', () => {
  it('首次连接和重连补读快照，重复或旧修订事件不重复刷新', async () => {
    vi.useFakeTimers()
    const authFetch = vi.fn()
      .mockResolvedValueOnce(responseWithEvents([
        event('event-2', 2),
        event('event-2', 2),
        event('event-1', 1),
        event('event-3', 3),
      ]))
      .mockResolvedValue(responseWithEvents([]))
    const onInvalidate = vi.fn()
    const events = useFileSyncAdminEvents(authFetch, onInvalidate)

    events.start()
    await flushPromises()

    expect(authFetch).toHaveBeenCalledTimes(1)
    expect(authFetch.mock.calls[0][0]).toBe('/api/v1/admin/filesync/events')
    expect(onInvalidate).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(authFetch).toHaveBeenCalledTimes(2)
    expect(onInvalidate).toHaveBeenCalledTimes(4)
    events.stop()
    await flushPromises()
  })
})
