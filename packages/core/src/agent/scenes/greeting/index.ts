import { buildGreetingPrompt, normalizeGreetingLocale, type GreetingLocale, type GreetingPromptInput } from './context.js'
export { buildGreetingPrompt, createGreetingContext as createGreetingScene, normalizeGreetingLocale } from './context.js'
export type { GreetingLocale, GreetingMemory, GreetingProject, GreetingPromptInput, GreetingSourceId, GreetingSourceReaders } from './context.js'

export interface GreetingLock { release(): Promise<void> }
export interface GreetingCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  acquire(key: string, ttlSeconds: number, waitSeconds: number, signal?: AbortSignal): Promise<GreetingLock | null>
}
export interface GreetingGeneratorPorts {
  enabled(): boolean
  readContext(ownerId: string, signal: AbortSignal): Promise<Omit<GreetingPromptInput, 'locale' | 'now'>>
  complete(ownerId: string, prompt: string, maxTokens: number, signal: AbortSignal): Promise<string>
  cache?: GreetingCache
  now?(): Date
  onFailure?(stage: 'context' | 'provider' | 'cache', error: unknown): void
}

export function cleanGreeting(value: string): string { return value.trim().replace(/^["「」]+|["「」]+$/gu, '') }

/** Python generate() 的 10 分钟缓存和跨进程互斥；模型/文件/Redis transport 留给 Host 注入。 */
export function createGreetingGenerator(ports: GreetingGeneratorPorts | (Omit<GreetingGeneratorPorts, 'readContext'> & {
  preparePrompt(ownerId: string, locale: GreetingLocale, now: () => Date, signal: AbortSignal): Promise<string>
})) {
  const now = ports.now ?? (() => new Date())
  const generateUncached = async (ownerId: string, locale: GreetingLocale, signal: AbortSignal): Promise<string> => {
    try {
      let prompt: string
      if ('preparePrompt' in ports) {
        prompt = await ports.preparePrompt(ownerId, locale, now, signal)
      } else {
        const context = await ports.readContext(ownerId, signal)
        signal.throwIfAborted()
        prompt = buildGreetingPrompt({ ...context, locale, now: now() })
      }
      signal.throwIfAborted()
      const text = await ports.complete(ownerId, prompt, 180, signal)
      signal.throwIfAborted()
      return cleanGreeting(text)
    } catch (error) {
      signal.throwIfAborted()
      ports.onFailure?.('provider', error)
      return ''
    }
  }
  return async function generate(ownerId: string, requestedLocale: string | null | undefined, signal = new AbortController().signal): Promise<{ text: string; enabled: boolean }> {
    if (!ownerId.trim()) throw new TypeError('问候身份无效')
    if (!ports.enabled()) return { text: '', enabled: false }
    const locale = normalizeGreetingLocale(requestedLocale), key = `agent:greeting:v2:${ownerId}:${locale}`
    if (!ports.cache) return { text: await generateUncached(ownerId, locale, signal), enabled: true }
    let lock: GreetingLock | null = null
    try {
      const cached = await ports.cache.get(key)
      if (cached) return { text: cached, enabled: true }
      lock = await ports.cache.acquire(`${key}:lock`, 60, 15, signal)
    } catch (error) {
      signal.throwIfAborted()
      ports.onFailure?.('cache', error)
      return { text: await generateUncached(ownerId, locale, signal), enabled: true }
    }
    if (!lock) { signal.throwIfAborted(); return { text: '', enabled: true } }
    try {
      signal.throwIfAborted()
      const cached = await ports.cache.get(key)
      if (cached) return { text: cached, enabled: true }
      const text = await generateUncached(ownerId, locale, signal)
      if (text) {
        try { await ports.cache.set(key, text, 600) }
        catch (error) { signal.throwIfAborted(); ports.onFailure?.('cache', error) }
      }
      return { text, enabled: true }
    } catch (error) {
      signal.throwIfAborted()
      ports.onFailure?.('cache', error)
      return { text: await generateUncached(ownerId, locale, signal), enabled: true }
    } finally {
      try { await lock.release() } catch (error) { ports.onFailure?.('cache', error) }
    }
  }
}
