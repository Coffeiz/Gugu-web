import type { FileMeta } from '@/stores/filesCache'
import { getAccountBoundaryEpoch } from '@/utils/accountBoundary'

const PREVIEW_CACHE_MAX = 20
const previewCache = new Map<string, { url: string; accountEpoch: number }>()
const previewFileMeta = new Map<number, { file: Partial<FileMeta>; filesRevision: number | null; accountEpoch: number }>()

function clearPreviewBlobCache(): void {
  for (const { url } of previewCache.values()) URL.revokeObjectURL(url)
  previewCache.clear()
  previewFileMeta.clear()
}

export function previewBlobCacheKey(file: Partial<FileMeta>): string {
  const accountEpoch = getAccountBoundaryEpoch()
  if (file.attach_id) return `account:${accountEpoch}:attach:${file.attach_id}`
  if (file.id != null) return `account:${accountEpoch}:file:${file.id}:${file.version ?? 0}`
  return ''
}

function getCachedPreview(key: string): string | null {
  if (!key) return null
  const entry = previewCache.get(key)
  if (!entry || entry.accountEpoch !== getAccountBoundaryEpoch()) return null
  previewCache.delete(key)
  previewCache.set(key, entry)
  return entry.url
}

function putCachedPreview(key: string, url: string, accountEpoch = getAccountBoundaryEpoch()): boolean {
  if (!key || accountEpoch !== getAccountBoundaryEpoch()) {
    URL.revokeObjectURL(url)
    return false
  }
  const previous = previewCache.get(key)
  if (previous && previous.url !== url) URL.revokeObjectURL(previous.url)
  previewCache.delete(key)
  previewCache.set(key, { url, accountEpoch })
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldestKey = previewCache.keys().next().value as string | undefined
    if (!oldestKey) break
    const oldestUrl = previewCache.get(oldestKey)?.url
    previewCache.delete(oldestKey)
    if (oldestUrl) URL.revokeObjectURL(oldestUrl)
  }
  return true
}

function rememberPreviewFile(file: Partial<FileMeta>, filesRevision?: number, accountEpoch = getAccountBoundaryEpoch()): void {
  if (file.id == null || accountEpoch !== getAccountBoundaryEpoch()) return
  const previousRevision = previewFileMeta.get(file.id)?.filesRevision
  previewFileMeta.delete(file.id)
  previewFileMeta.set(file.id, { file, filesRevision: filesRevision ?? previousRevision ?? null, accountEpoch })
  while (previewFileMeta.size > PREVIEW_CACHE_MAX * 2) {
    const oldestId = previewFileMeta.keys().next().value as number | undefined
    if (oldestId == null) break
    previewFileMeta.delete(oldestId)
  }
}

function getRememberedPreviewFile(id: number, filesRevision?: number): Partial<FileMeta> | null {
  const entry = previewFileMeta.get(id)
  if (!entry || entry.accountEpoch !== getAccountBoundaryEpoch()
    || (filesRevision !== undefined && entry.filesRevision !== filesRevision)) return null
  previewFileMeta.delete(id)
  previewFileMeta.set(id, entry)
  return entry.file
}

function releasePreview(key: string, url: string | null): void {
  if (url && (!key || previewCache.get(key)?.url !== url)) URL.revokeObjectURL(url)
}

function discardPreview(key: string, url?: string | null): void {
  const cached = previewCache.get(key)?.url
  if (!cached || (url && cached !== url)) return
  previewCache.delete(key)
  URL.revokeObjectURL(cached)
}

/** 页面会话级 blob URL LRU；缓存拥有 URL 的释放责任。 */
export function usePreviewBlobCache() {
  return {
    get: getCachedPreview,
    put: putCachedPreview,
    release: releasePreview,
    discard: discardPreview,
    rememberFile: rememberPreviewFile,
    getFile: getRememberedPreviewFile,
    clear: clearPreviewBlobCache,
    keyOf: previewBlobCacheKey,
  }
}

/** 仅供单元测试清空会话缓存，生产代码不要调用。 */
export function clearPreviewBlobCacheForTests(): void {
  clearPreviewBlobCache()
}
