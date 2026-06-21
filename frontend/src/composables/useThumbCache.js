import { reactive } from 'vue'

const BASE    = import.meta.env.VITE_API_URL ?? '/api/v1'
const cache   = new Map() // `${id}_${size}` → blobUrl
const pending = new Map() // `${id}_${size}` → Promise<string|null>

export const thumbLoadedIds = reactive(new Set())

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
  const p = fetch(`${BASE}/files/${id}/thumb?size=${size}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-cache',
  })
    .then(r => (r.ok ? r.blob() : Promise.reject()))
    .then(blob => {
      const url = URL.createObjectURL(blob)
      cache.set(key, url)
      if (size === 'card') thumbLoadedIds.add(id)
      pending.delete(key)
      return url
    })
    .catch(() => { pending.delete(key); return null })

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
}
