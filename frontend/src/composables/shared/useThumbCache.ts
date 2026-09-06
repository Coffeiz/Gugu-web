import { reactive } from 'vue'
import { pLimit, THUMB_CONCURRENCY } from '@/utils/concurrency'

const BASE    = import.meta.env.VITE_API_URL ?? '/api/v1'
const cache   = new Map<string, string>() // `${id}_${size}` 或 `${id}_${size}_${revision}` → blobUrl
const pending = new Map<string, Promise<string | null>>()

type ThumbRevision = number | string
function thumbKey(id: number | string, size: string, revision?: ThumbRevision): string {
  return revision == null ? `${id}_${size}` : `${id}_${size}_${revision}`
}

// 并发限流：浏览器 HTTP/1.1 单域名约 6 连接，批量加载几十张缩略图会导致尾部超时；
// 与上传共用 @/utils/concurrency 的限流器实现，阈值集中在那里调
const thumbLimit = pLimit(THUMB_CONCURRENCY)

export const thumbLoadedIds   = reactive(new Set())
// card blob 已渲染过的 id（模块级，session 内持久）：首次 @load 后写入，
// 二次访问同一文件时 fc-loaded 直接就绪，跳过渐进动画直接显示
export const cardBlobReadyIds = reactive(new Set())

export function getCachedThumb(id: number | string, size = 'card', revision?: ThumbRevision) {
  const url = cache.get(thumbKey(id, size, revision))
  if (url && size === 'card') thumbLoadedIds.add(id)
  return url ?? null
}

export function getThumb(id: number | string, size = 'card', revision?: ThumbRevision) {
  const key = thumbKey(id, size, revision)
  if (cache.has(key)) {
    if (size === 'card') thumbLoadedIds.add(id)
    return Promise.resolve(cache.get(key))
  }
  if (pending.has(key)) return pending.get(key)

  const token = localStorage.getItem('user_token') ?? ''
  const p = thumbLimit(() => {
    // ⚠️ 必须带超时：fetch 默认永不超时，卡住的请求会一直占着并发槽（pLimit 只 6 个）→
    //   批量改名/上传时一波请求里只要有几个卡住，后面的缩略图就永远排不上 → 永久没缩略图。
    //   abort 后 reject → 释放槽位 + 让懒加载指令下次进视口重试。
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    const revisionQuery = revision == null ? '' : `&revision=${encodeURIComponent(String(revision))}`
    return fetch(`${BASE}/files/${id}/thumb?size=${size}${revisionQuery}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-cache',
      signal: ctrl.signal,
    })
      .then(r => (r.ok ? r.blob() : Promise.reject()))
      .then(blob => {
        const url = URL.createObjectURL(blob)
        cache.set(key, url)
        if (size === 'card') thumbLoadedIds.add(id)
        return url
      })
      .finally(() => clearTimeout(timer))
  })
    .then(url => { pending.delete(key); return url })
    .catch(() => { pending.delete(key); return null })

  pending.set(key, p)
  return p
}

// 通用：按任意 URL 取缩略图并以自定义 key 缓存（聊天暂存附件缩略图等，走 file id 之外的端点）
export function getCachedThumbUrl(key: string) {
  return cache.get(key) ?? null
}

export function getThumbUrl(key: string, url: string) {
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  if (pending.has(key)) return pending.get(key)

  const token = localStorage.getItem('user_token') ?? ''
  const p = thumbLimit(() => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)   // 同 getThumb：卡住的请求别永久占并发槽
    return fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-cache',
      signal: ctrl.signal,
    })
      .then(r => (r.ok ? r.blob() : Promise.reject()))
      .then(blob => {
        const blobUrl = URL.createObjectURL(blob)
        cache.set(key, blobUrl)
        return blobUrl
      })
      .finally(() => clearTimeout(timer))
  })
    .then(blobUrl => { pending.delete(key); return blobUrl })
    .catch(() => { pending.delete(key); return null })

  pending.set(key, p)
  return p
}

const _IMG_EXTS = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','heic','heif','svg'])

export function preloadTinyThumbs(files: Array<{ id: number | string; ext?: string | null; version?: ThumbRevision }>) {
  for (const f of files) {
    const key = thumbKey(f.id, 'tiny', f.version)
    if (_IMG_EXTS.has((f.ext || '').toLowerCase()) && !cache.has(key)) {
      getThumb(f.id, 'tiny', f.version).catch(() => {})
    }
  }
}

export function clearThumbCache(id: number | string) {
  const prefix = `${id}_`
  for (const [key, url] of cache) {
    if (key.startsWith(prefix)) {
      URL.revokeObjectURL(url)
      cache.delete(key)
    }
  }
  thumbLoadedIds.delete(id)
  cardBlobReadyIds.delete(id)
}
