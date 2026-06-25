import { reactive } from 'vue'

const BASE    = import.meta.env.VITE_API_URL ?? '/api/v1'
const cache   = new Map() // `${id}_${size}` → blobUrl
const pending = new Map() // `${id}_${size}` → Promise<string|null>

// 并发限流：浏览器 HTTP/1.1 单域名 6 连接，批量上传时同时发几十个缩略图请求会导致尾部超时
const MAX_CONCURRENT = 6
let _active = 0
const _queue = []
function _acquire() {
  if (_active < MAX_CONCURRENT) { _active++; return Promise.resolve() }
  return new Promise(resolve => _queue.push(resolve))
}
function _release() {
  const next = _queue.shift()
  if (next) { next() } else { _active-- }
}

export const thumbLoadedIds   = reactive(new Set())
// card blob 已渲染过的 id（模块级，session 内持久）：首次 @load 后写入，
// 二次访问同一文件时 fc-loaded 直接就绪，跳过渐进动画直接显示
export const cardBlobReadyIds = reactive(new Set())

export function getCachedThumb(id, size = 'card') {
  const url = cache.get(`${id}_${size}`)
  if (url && size === 'card') thumbLoadedIds.add(id)
  return url ?? null
}

export function getThumb(id, size = 'card') {
  const key = `${id}_${size}`
  if (cache.has(key)) {
    if (size === 'card') thumbLoadedIds.add(id)
    return Promise.resolve(cache.get(key))
  }
  if (pending.has(key)) return pending.get(key)

  const token = localStorage.getItem('user_token') ?? ''
  const p = _acquire().then(() =>
    fetch(`${BASE}/files/${id}/thumb?size=${size}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-cache',
    })
      .then(r => (r.ok ? r.blob() : Promise.reject()))
      .then(blob => {
        const url = URL.createObjectURL(blob)
        cache.set(key, url)
        if (size === 'card') thumbLoadedIds.add(id)
        pending.delete(key)
        _release()
        return url
      })
      .catch(() => { pending.delete(key); _release(); return null })
  )

  pending.set(key, p)
  return p
}

// 通用：按任意 URL 取缩略图并以自定义 key 缓存（聊天暂存附件缩略图等，走 file id 之外的端点）
export function getCachedThumbUrl(key) {
  return cache.get(key) ?? null
}

export function getThumbUrl(key, url) {
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  if (pending.has(key)) return pending.get(key)

  const token = localStorage.getItem('user_token') ?? ''
  const p = _acquire().then(() =>
    fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-cache',
    })
      .then(r => (r.ok ? r.blob() : Promise.reject()))
      .then(blob => {
        const blobUrl = URL.createObjectURL(blob)
        cache.set(key, blobUrl)
        pending.delete(key)
        _release()
        return blobUrl
      })
      .catch(() => { pending.delete(key); _release(); return null })
  )

  pending.set(key, p)
  return p
}

const _IMG_EXTS = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','heic','heif','svg'])

export function preloadTinyThumbs(files) {
  for (const f of files) {
    if (_IMG_EXTS.has((f.ext || '').toLowerCase()) && !cache.has(`${f.id}_tiny`)) {
      getThumb(f.id, 'tiny').catch(() => {})
    }
  }
}

export function clearThumbCache(id) {
  for (const size of ['tiny', 'card', 'full']) {
    const key = `${id}_${size}`
    const url = cache.get(key)
    if (url) { URL.revokeObjectURL(url); cache.delete(key) }
  }
  thumbLoadedIds.delete(id)
  cardBlobReadyIds.delete(id)
}
