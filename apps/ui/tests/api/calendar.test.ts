// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eventsApi } from '@/api/calendar'
import { eventsApi as compatibilityEventsApi } from '@/services/api'
import { jsonResponse } from './response'

afterEach(() => {
  document.cookie = 'gugu_user_csrf_token=; Max-Age=0; path=/'
  vi.unstubAllGlobals()
})

describe('日历 API 模块', () => {
  it('旧 services 入口继续导出同一个事件 API 模块', () => {
    expect(compatibilityEventsApi).toBe(eventsApi)
  })

  it('按年月读取并使用幂等键创建事件', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: 8, title: '合成事件' }, 201))
    vi.stubGlobal('fetch', fetchMock)

    await eventsApi.list(2026, 11)
    await eventsApi.create({ title: '合成事件' } as never, 'synthetic-event-key')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/events?year=2026&month=11')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/events')
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ 'Idempotency-Key': 'synthetic-event-key' })
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ title: '合成事件' }))
  })

  it('更新传递 mutation 元数据，删除保留版本查询参数', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 8, version: 2 }))
      .mockResolvedValueOnce(jsonResponse(null, 204))
    vi.stubGlobal('fetch', fetchMock)

    await eventsApi.update(8, { version: 1 } as never, { mutationId: 'synthetic-event-mutation' })
    const deleted = await eventsApi.delete(8, 2)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/events/8')
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ 'X-Mutation-Id': 'synthetic-event-mutation' })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/events/8?version=2')
    expect(deleted).toBeNull()
  })
})
