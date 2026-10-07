// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'
import { useLiveStore } from '@/stores/live'

vi.mock('@/services/api', () => ({ getToken: () => 'synthetic-session-token' }))
vi.mock('@/stores/ui', () => ({ useUiStore: () => ({ pushNotification: vi.fn() }) }))
vi.mock('@/stores/preview', () => ({ usePreviewStore: () => ({ open: vi.fn() }) }))
vi.mock('@/services/authSession', () => ({ isUnauthorizedResponse: () => false }))

function sseFrame(value: unknown) {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
}

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('等待实时事件状态超时')
}

afterEach(() => vi.unstubAllGlobals())

describe('用户级文件同步 SSE 分发', () => {
  it('按 run/binding 修订分发事件，忽略重复 ID 与旧修订', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const fetcher = vi.fn((_url: string, options: RequestInit) => Promise.resolve(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
          options.signal?.addEventListener('abort', () => controller.close(), { once: true })
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )))
    vi.stubGlobal('fetch', fetcher)
    setActivePinia(createPinia())
    const store = useLiveStore()
    const received: string[] = []
    watch(() => store.fileSyncEvent, event => {
      if (event) received.push(event.event_id)
    }, { flush: 'sync' })
    store.connect()
    await waitUntil(() => store.connected)

    streamController?.enqueue(sseFrame({
      protocol_version: 'live-event-v1', event_id: 'run-2',
      type: 'filesync.run.changed', run_id: 'run-synthetic', binding_id: 5,
      revision: 2, created_at: '2026-10-07T00:00:00Z',
    }))
    streamController?.enqueue(sseFrame({
      protocol_version: 'live-event-v1', event_id: 'run-2',
      type: 'filesync.run.changed', run_id: 'run-synthetic', binding_id: 5,
      revision: 2, created_at: '2026-10-07T00:00:00Z',
    }))
    streamController?.enqueue(sseFrame({
      protocol_version: 'live-event-v1', event_id: 'run-old',
      type: 'filesync.run.changed', run_id: 'run-synthetic', binding_id: 5,
      revision: 1, created_at: '2026-10-07T00:00:00Z',
    }))
    streamController?.enqueue(sseFrame({
      protocol_version: 'live-event-v1', event_id: 'health-1',
      type: 'filesync.binding.health.changed', binding_id: 5,
      revision: 1, created_at: '2026-10-07T00:00:00Z',
    }))
    await waitUntil(() => store.fileSyncEvent?.event_id === 'health-1')

    expect(store.fileSyncEvent?.type).toBe('filesync.binding.health.changed')
    expect(store.fileSyncEvent?.revision).toBe(1)
    expect(received).toEqual(['run-2', 'health-1'])
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/live/stream')
    expect(fetcher.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer synthetic-session-token' })

    store.disconnect()
    await waitUntil(() => !store.connected)
  })
})
