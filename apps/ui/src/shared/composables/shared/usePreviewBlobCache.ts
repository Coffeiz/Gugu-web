import type { FileMeta } from '@/stores/filesCache'
import { getAccountBoundaryEpoch } from '@/utils/accountBoundary'

const PREVIEW_CACHE_MAX = 20
const previewCache = new Map<string, { url: string; accountEpoch: number }>()
const previewFileMeta = new Map<string, { file: Partial<FileMeta>; filesRevision: number | null; accountEpoch: number }>()

/** 仅显式刷新预览时追加缓存版本，普通打开保留原 URL。 */
export function withPreviewCacheBust(url: string, refresh: boolean): string {
  if (!refresh) return url
  return `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`
}

function clearPreviewBlobCache(): void {
  for (const { url } of previewCache.values()) URL.revokeObjectURL(url)
  previewCache.clear()
  previewFileMeta.clear()
}

export function previewBlobCacheKey(file: Partial<FileMeta>): string {
  const accountEpoch = getAccountBoundaryEpoch()
  if (file.attach_id) return `account:${accountEpoch}:attach:${file.attach_id}`
  if (file.filePath) return `account:${accountEpoch}:file:${file.filePath}:${file.version ?? 0}`
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
  const key = file.filePath ?? file.attach_id ?? null
  if (key == null || accountEpoch !== getAccountBoundaryEpoch()) return
  const previousRevision = previewFileMeta.get(key)?.filesRevision
  previewFileMeta.delete(key)
  previewFileMeta.set(key, { file, filesRevision: filesRevision ?? previousRevision ?? null, accountEpoch })
  while (previewFileMeta.size > PREVIEW_CACHE_MAX * 2) {
    const oldestId = previewFileMeta.keys().next().value
    if (oldestId == null) break
    previewFileMeta.delete(oldestId)
  }
}

function getRememberedPreviewFile(pathOrAttachId: string, filesRevision?: number): Partial<FileMeta> | null {
  const entry = previewFileMeta.get(pathOrAttachId)
  if (!entry || entry.accountEpoch !== getAccountBoundaryEpoch()
    || (filesRevision !== undefined && entry.filesRevision !== filesRevision)) return null
  previewFileMeta.delete(pathOrAttachId)
  previewFileMeta.set(pathOrAttachId, entry)
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
