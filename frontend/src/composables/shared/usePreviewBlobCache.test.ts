import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPreviewBlobCacheForTests,
  previewBlobCacheKey,
  usePreviewBlobCache,
} from './usePreviewBlobCache'

describe('usePreviewBlobCache', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(),
      revokeObjectURL: vi.fn(),
    })
    clearPreviewBlobCacheForTests()
    vi.mocked(URL.revokeObjectURL).mockClear()
  })

  it('按文件 id 区分库文件和聊天附件，并命中后刷新 LRU 顺序', () => {
    expect(previewBlobCacheKey({ id: 7 })).toBe('file:7')
    expect(previewBlobCacheKey({ attach_id: 'a-7', id: 7 })).toBe('attach:a-7')

    const cache = usePreviewBlobCache()
    cache.put('file:1', 'blob:1')
    cache.put('file:2', 'blob:2')
    expect(cache.get('file:1')).toBe('blob:1')
    cache.put('file:3', 'blob:3')
    expect(cache.get('file:2')).toBe('blob:2')
  })

  it('超过 20 条时只释放最久未使用的 blob，缓存中的 URL 不随组件卸载释放', () => {
    const cache = usePreviewBlobCache()
    for (let i = 0; i < 20; i += 1) cache.put(`file:${i}`, `blob:${i}`)
    expect(cache.get('file:0')).toBe('blob:0')
    cache.put('file:20', 'blob:20')

    expect(cache.get('file:1')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')
    expect(cache.get('file:0')).toBe('blob:0')
    cache.release('file:0', 'blob:0')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:0')
    cache.release('', 'blob:unmanaged')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:unmanaged')
  })

  it('强制刷新后用新 blob 替换同一文件的旧缓存', () => {
    const cache = usePreviewBlobCache()
    cache.put('file:1', 'blob:v1')
    cache.put('file:1', 'blob:v2')

    expect(cache.get('file:1')).toBe('blob:v2')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:v1')
  })
})
