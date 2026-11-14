// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectsApi } from '@/api/projects'
import { jsonResponse } from './response'

afterEach(() => {
  document.cookie = 'gugu_user_csrf_token=; Max-Age=0; path=/'
  vi.unstubAllGlobals()
})

describe('项目 API 模块', () => {
  it('创建请求保留项目路径、JSON 参数和幂等键', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 42, name: '合成项目' }, 201))
    vi.stubGlobal('fetch', fetchMock)
    const payload = { name: '合成项目' }

    await projectsApi.create(payload as never, 'synthetic-create-key')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/projects')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Idempotency-Key': 'synthetic-create-key',
    })
    expect(init?.body).toBe(JSON.stringify(payload))
  })

  it('更新请求保留 mutation 元数据并接受 204 删除响应', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 42, version: 3 }))
      .mockResolvedValueOnce(jsonResponse(null, 204))
    vi.stubGlobal('fetch', fetchMock)

    await projectsApi.update(42, { version: 2 } as never, {
      mutationId: 'synthetic-mutation',
      undoGroupId: 'synthetic-undo-group',
    })
    const deleted = await projectsApi.delete(42)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/projects/42')
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      'X-Mutation-Id': 'synthetic-mutation',
      'X-Undo-Group-ID': 'synthetic-undo-group',
    })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/projects/42')
    expect(deleted).toBeNull()
  })
})
