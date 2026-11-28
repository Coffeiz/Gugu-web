// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/authSession', () => ({ isUnauthorizedResponse: (response: Response) => response.status === 401 }))

let thumbs: typeof import('@/composables/shared/useThumbCache')
const fetchMock = vi.fn<typeof fetch>()

beforeEach(async () => {
  vi.resetModules()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  let nextUrl = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:thumb-${++nextUrl}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  thumbs = await import('@/composables/shared/useThumbCache')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('缩略图请求与缓存', () => {
  it('同一文件版本并发读取共用请求，命中缓存后仍恢复卡片已加载状态', async () => {
    fetchMock.mockImplementation(async () => new Response('image'))
    const first = thumbs.getThumb(7, 'card', 2)
    expect(thumbs.getThumb(7, 'card', 2)).toBe(first)
    expect(await first).toBe('blob:thumb-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(thumbs.thumbLoadedIds.has(7)).toBe(true)
    thumbs.thumbLoadedIds.delete(7)
    expect(await thumbs.getThumb(7, 'card', 2)).toBe('blob:thumb-1')
    expect(thumbs.thumbLoadedIds.has(7)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await thumbs.getThumb(7, 'card', 3)).toBe('blob:thumb-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('自定义 URL 按 key 去重并携带 Cookie，不把附件 key 当文件加载标记', async () => {
    fetchMock.mockResolvedValue(new Response('image'))
    const first = thumbs.getThumbUrl('attachment:one', '/api/v1/attachments/one/thumb')
    expect(thumbs.getThumbUrl('attachment:one', '/api/v1/attachments/one/thumb')).toBe(first)
    expect(await first).toBe('blob:thumb-1')
    expect(await thumbs.getThumbUrl('attachment:one', '/api/v1/attachments/one/thumb')).toBe('blob:thumb-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/attachments/one/thumb', expect.objectContaining({ credentials: 'include', cache: 'no-cache' }))
    expect(thumbs.thumbLoadedIds.size).toBe(0)
  })

  it.each([401, 404])('失败响应 %s 不写缓存，下次读取能重新请求', async status => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(new Response('image'))
    expect(await thumbs.getThumb(7)).toBeNull()
    expect(thumbs.getCachedThumb(7)).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(await thumbs.getThumb(7)).toBe('blob:thumb-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('超时中断后清除在途请求，后续读取可重试', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('请求中断')), { once: true })
    })).mockResolvedValueOnce(new Response('image'))
    const first = thumbs.getThumbUrl('attachment:one', '/api/v1/attachments/one/thumb')
    await vi.advanceTimersByTimeAsync(15000)
    expect(await first).toBeNull()
    expect(await thumbs.getThumbUrl('attachment:one', '/api/v1/attachments/one/thumb')).toBe('blob:thumb-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('清理文件会回收全部版本与尺寸的 URL，保留其他文件缓存', async () => {
    fetchMock.mockImplementation(async () => new Response('image'))
    await thumbs.getThumb(7, 'tiny', 1)
    await thumbs.getThumb(7, 'card', 2)
    await thumbs.getThumb(8, 'card', 1)
    thumbs.cardBlobReadyIds.add(7)
    thumbs.clearThumbCache(7)
    expect(thumbs.getCachedThumb(7, 'tiny', 1)).toBeNull()
    expect(thumbs.getCachedThumb(7, 'card', 2)).toBeNull()
    expect(thumbs.getCachedThumb(8, 'card', 1)).toBe('blob:thumb-3')
    expect(thumbs.thumbLoadedIds.has(7)).toBe(false)
    expect(thumbs.cardBlobReadyIds.has(7)).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
})
