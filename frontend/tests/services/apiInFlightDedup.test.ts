// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectsApi } from '@/services/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  localStorage.clear()
  document.cookie = 'gugu_user_csrf_token=; Max-Age=0; path=/'
  vi.unstubAllGlobals()
})

describe('API 并发 GET 合并', () => {
  it('A/B 对比：两个页面同时读取项目列表时只保留一条网络请求', async () => {
    document.cookie = 'gugu_user_csrf_token=synthetic-ab-session; path=/'
    const payload = [{ id: 7, name: '合成项目' }]
    const baselineFetch = vi.fn(async () => jsonResponse(payload))
    vi.stubGlobal('fetch', baselineFetch)

    const baseline = await Promise.all([
      fetch('/api/v1/projects').then(response => response.json()),
      fetch('/api/v1/projects').then(response => response.json()),
    ])
    const baselineBytes = JSON.stringify(payload).length * baselineFetch.mock.calls.length
    expect(baselineFetch).toHaveBeenCalledTimes(2)

    const optimizedFetch = vi.fn(async () => jsonResponse(payload))
    vi.stubGlobal('fetch', optimizedFetch)
    const optimized = await Promise.all([projectsApi.list(), projectsApi.list()])
    const optimizedBytes = JSON.stringify(payload).length * optimizedFetch.mock.calls.length

    expect(optimizedFetch).toHaveBeenCalledTimes(1)
    expect(optimized).toEqual(baseline)
    expect(optimizedBytes).toBe(baselineBytes / 2)
  })

  it('同一 token 和路径的并发读取只发一个请求，结果互不共享，完成后刷新会重新请求', async () => {
    document.cookie = 'gugu_user_csrf_token=synthetic-user-session; path=/'
    const response = deferred<Response>()
    const fetchMock = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', fetchMock)

    const first = projectsApi.list()
    const second = projectsApi.list()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    response.resolve(jsonResponse([{ id: 7, name: '合成项目' }]))
    const [firstResult, secondResult] = await Promise.all([first, second])
    firstResult[0].name = '已修改副本'
    expect(secondResult[0].name).toBe('合成项目')

    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 7, name: '服务端新值' }]))
    await expect(projectsApi.list()).resolves.toEqual([{ id: 7, name: '服务端新值' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('不同 Cookie 会话或不同查询参数的读取不会合并', async () => {
    const responses = [deferred<Response>(), deferred<Response>(), deferred<Response>()]
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => responses[0].promise)
      .mockImplementationOnce(() => responses[1].promise)
      .mockImplementationOnce(() => responses[2].promise)
    vi.stubGlobal('fetch', fetchMock)

    document.cookie = 'gugu_user_csrf_token=synthetic-session-a; path=/'
    const userA = projectsApi.list()
    document.cookie = 'gugu_user_csrf_token=synthetic-session-b; path=/'
    const userB = projectsApi.list()
    const archived = projectsApi.list(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    responses.forEach((response, index) => response.resolve(jsonResponse([{ id: index + 1 }])) )
    await Promise.all([userA, userB, archived])
  })
})
