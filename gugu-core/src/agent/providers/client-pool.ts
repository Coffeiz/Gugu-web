import { observe } from './values.js'

export interface ManagedProviderClient { close(): Promise<void> }
export interface PoolTimers { set(callback: () => void, milliseconds: number): unknown; clear(handle: unknown): void }
interface Entry<T> { client: T; scopes: Set<string>; timer?: unknown }

/** 生命周期由Run显式绑定，不依赖Host全局状态或跨用户隐式共享。 */
export class ProviderClientPool<T extends ManagedProviderClient> {
  readonly #entries = new Map<string, Entry<T>>()
  readonly #scopes = new Map<string, Set<string>>()
  readonly #closing = new Set<Promise<void>>()
  constructor(readonly options: { idleCloseMs?: number; timers?: PoolTimers; diagnose?: (error: unknown) => void } = {}) {
    this.#timers = options.timers ?? {
    set: (callback, ms) => { const timer = setTimeout(callback, ms); if (typeof timer === 'object' && 'unref' in timer) timer.unref(); return timer },
    clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
  }
  readonly #timers: PoolTimers
  get(scope: string | null, configKey: string, create: () => T): T {
    // 无run作用域的短调用由调用方用finally关闭，不能偷偷放进永久池。
    if (!scope) return create()
    let entry = this.#entries.get(configKey)
    if (!entry) { entry = { client: create(), scopes: new Set() }; this.#entries.set(configKey, entry) }
    if (entry.timer !== undefined) { this.#timers.clear(entry.timer); entry.timer = undefined }
    entry.scopes.add(scope)
    let keys = this.#scopes.get(scope)
    if (!keys) { keys = new Set(); this.#scopes.set(scope, keys) }
    keys.add(configKey)
    return entry.client
  }
  finish(scope: string): void {
    const keys = this.#scopes.get(scope)
    this.#scopes.delete(scope)
    for (const key of keys ?? []) {
      const entry = this.#entries.get(key)
      if (!entry) continue
      entry.scopes.delete(scope)
      if (!entry.scopes.size && entry.timer === undefined) entry.timer = this.#timers.set(() => {
        if (this.#entries.get(key) !== entry || entry.scopes.size) return
        this.#entries.delete(key)
        this.#close(entry.client)
      }, this.options.idleCloseMs ?? 90_000)
    }
  }
  #close(client: T): void {
    const pending = Promise.resolve().then(() => client.close()).catch(error => observe(() => this.options.diagnose?.(error)))
    this.#closing.add(pending); void pending.finally(() => this.#closing.delete(pending))
  }
  async close(): Promise<void> {
    for (const entry of this.#entries.values()) { if (entry.timer !== undefined) this.#timers.clear(entry.timer); this.#close(entry.client) }
    this.#entries.clear(); this.#scopes.clear()
    await Promise.all([...this.#closing])
  }
}

export function providerConfigKey(kind: string, value: { baseUrl: string; apiKey: string; headers: Readonly<Record<string, string>>; timeout: unknown; networkIdentity?: string }, digest: (value: unknown) => string): string {
  return digest({ kind, ...value, headers: Object.fromEntries(Object.entries(value.headers).sort(([a], [b]) => a.localeCompare(b))) })
}
