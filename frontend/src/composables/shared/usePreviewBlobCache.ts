import type { FileMeta } from '@/stores/filesCache'

const PREVIEW_CACHE_MAX = 20
const previewCache = new Map<string, string>()
const previewFileMeta = new Map<number, { file: Partial<FileMeta>; filesRevision: number | null }>()

export function previewBlobCacheKey(file: Partial<FileMeta>): string {
  if (file.attach_id) return `attach:${file.attach_id}`
  if (file.id != null) return `file:${file.id}:${file.version ?? 0}`
  return ''
}

/** 页面会话级 blob URL LRU；缓存拥有 URL 的释放责任。 */
export function usePreviewBlobCache() {
  function get(key: string): string | null {
    if (!key) return null
    const url = previewCache.get(key)
    if (!url) return null
    previewCache.delete(key)
    previewCache.set(key, url)
    return url
  }

  function put(key: string, url: string): void {
    if (!key) return
    const previous = previewCache.get(key)
    if (previous && previous !== url) URL.revokeObjectURL(previous)
    previewCache.delete(key)
    previewCache.set(key, url)
    while (previewCache.size > PREVIEW_CACHE_MAX) {
      const oldestKey = previewCache.keys().next().value as string | undefined
      if (!oldestKey) break
      const oldestUrl = previewCache.get(oldestKey)
      previewCache.delete(oldestKey)
      if (oldestUrl) URL.revokeObjectURL(oldestUrl)
    }
  }

  function rememberFile(file: Partial<FileMeta>, filesRevision?: number): void {
    if (file.id == null) return
    const previousRevision = previewFileMeta.get(file.id)?.filesRevision
    previewFileMeta.delete(file.id)
    previewFileMeta.set(file.id, {
      file,
      filesRevision: filesRevision ?? previousRevision ?? null,
    })
    while (previewFileMeta.size > PREVIEW_CACHE_MAX * 2) {
      const oldestId = previewFileMeta.keys().next().value as number | undefined
      if (oldestId == null) break
      previewFileMeta.delete(oldestId)
    }
  }

  function getFile(id: number, filesRevision?: number): Partial<FileMeta> | null {
    const entry = previewFileMeta.get(id)
    if (!entry || (filesRevision !== undefined && entry.filesRevision !== filesRevision)) return null
    previewFileMeta.delete(id)
    previewFileMeta.set(id, entry)
    return entry.file
  }

  function release(key: string, url: string | null): void {
    if (url && (!key || previewCache.get(key) !== url)) URL.revokeObjectURL(url)
  }

  function discard(key: string, url?: string | null): void {
    const cached = previewCache.get(key)
    if (!cached || (url && cached !== url)) return
    previewCache.delete(key)
    URL.revokeObjectURL(cached)
  }

  return { get, put, release, discard, rememberFile, getFile, keyOf: previewBlobCacheKey }
}

/** 仅供单元测试清空会话缓存，生产代码不要调用。 */
export function clearPreviewBlobCacheForTests(): void {
  for (const url of previewCache.values()) URL.revokeObjectURL(url)
  previewCache.clear()
  previewFileMeta.clear()
}
