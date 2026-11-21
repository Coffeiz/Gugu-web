import { computed, inject, shallowRef, watch } from 'vue'
import { post } from '@/api/client'
import { pLimit } from '@/utils/concurrency'
import { chatCitationSiteKey } from './chatPresentationAccess'
import type { ChatSource } from './chatSources'

const fetchName = pLimit(3)
const caches = new WeakMap<SiteReader, Map<string, { expires: number; result: Promise<string | null> }>>()
type SiteReader = (url: string) => Promise<{ name: string | null }>
const readWebSite: SiteReader = url => post('/chat/citation-site', { url })

function lookup(read: SiteReader, url: URL) {
  const cache = caches.get(read) ?? new Map<string, { expires: number; result: Promise<string | null> }>()
  caches.set(read, cache)
  const cached = cache.get(url.origin)
  if (cached && cached.expires > Date.now()) return cached.result
  const result = fetchName(() => read(url.origin + url.pathname))
    .then(({ name }) => typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : null)
    .catch(() => null)
  const entry = { expires: Date.now() + 60_000, result }
  cache.delete(url.origin)
  cache.set(url.origin, entry)
  if (cache.size > 256) cache.delete(cache.keys().next().value!)
  void result.then(name => { if (name) entry.expires = Date.now() + 24 * 60 * 60_000 })
  return result
}

export function useCitationSiteNames(sources: () => readonly ChatSource[]) {
  const read = inject(chatCitationSiteKey, readWebSite)
  const names = shallowRef(new Map<string, string>())
  const missing = computed(() => {
    const pages = new Map<string, URL>()
    for (const source of sources()) {
      if (!source.needsSiteName) continue
      const url = new URL(source.url)
      if (!pages.has(url.origin)) pages.set(url.origin, url)
    }
    return pages
  })
  const keys = computed(() => JSON.stringify([...missing.value.keys()]))
  watch(keys, (_keys, _previous, onCleanup) => {
    let active = true
    onCleanup(() => { active = false })
    names.value = new Map()
    for (const [origin, page] of missing.value) {
      void lookup(read, page).then(name => {
        if (active && name) names.value = new Map(names.value).set(origin, name)
      })
    }
  }, { immediate: true })
  return computed(() => sources().map(source => {
    const name = source.needsSiteName && names.value.get(new URL(source.url).origin)
    return name ? { ...source, site: name } : source
  }))
}
