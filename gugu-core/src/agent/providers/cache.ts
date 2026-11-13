import { throwIfCancelled } from './errors.js'
import type { JsonObject, ProviderConfig, ProviderPolicy } from './contracts.js'
import { clone, record } from './values.js'
import { ProviderError } from './errors.js'

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, item]) => [key, strip(item)]))
  return value
}
function volatile(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(volatile)
  if (!value || typeof value !== 'object') return false
  const node = record(value)
  if (node.type === 'image' && record(node.source).type === 'base64' && record(node.source).data) return true
  if (node.type === 'image_url' && String(record(node.image_url).url ?? node.image_url ?? '').startsWith('data:')) return true
  return Object.values(node).some(volatile)
}

/** Anthropic历史只在稳定prefix放锚点，不改变原wire的native块或边界。 */
export function prepareAnthropicCache(history: readonly JsonObject[], policy: ProviderPolicy, config: ProviderConfig, digest: (value: unknown) => string, stableCount: number, previous?: unknown) {
  const messages = strip(clone(history)) as JsonObject[]
  const strategy = policy.singleHistoryCacheAnchor(config) ? 'single' : 'multi'
  const old = record(previous), limit = Math.max(0, Math.min(stableCount, messages.length))
  const firstVolatile = messages.slice(0, limit).findIndex(volatile), stable = firstVolatile < 0 ? limit : firstVolatile
  const hashes = messages.slice(0, stable).map(item => digest(item))
  const compatible = old.provider === policy.name && old.api_format === 'anthropic' && old.model === config.model && old.strategy === strategy
  let baseline = compatible ? hashes.indexOf(String(old.baseline_digest ?? '')) : -1
  if (baseline < 0) {
    baseline = stable - 1
    for (let index = stable - 2; index >= 0; index--) {
      const row = messages[index]!, content = row.content
      if (row.role !== 'user' || Array.isArray(content) && content.length > 0 && content.every(block => record(block).type === 'tool_result')) continue
      baseline = index; break
    }
  }
  if (policy.capabilities(config).cache_mode === 'active') for (const index of new Set(policy.singleHistoryCacheAnchor(config) ? [stable - 1] : [baseline, stable - 1])) {
    const row = messages[index]
    if (!row || index >= stable) continue
    const content = typeof row.content === 'string' ? [{ type: 'text', text: row.content }] : clone(row.content)
    if (!Array.isArray(content) || !content.length) continue
    const last = content.at(-1)
    if (last && typeof last === 'object' && !Array.isArray(last)) content[content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } }
    row.content = content
  }
  return { messages, anchor: { provider: policy.name, api_format: 'anthropic', model: config.model, strategy, baseline_digest: hashes[baseline] ?? digest([]) } }
}

/** 同prefix只协调顺序，不复用模型答案；跨进程租约由共享runtime实现注入。 */
export interface PrefixCoordinator { run<T>(key: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> }
export function providerCacheSupported(policy: ProviderPolicy, config: ProviderConfig): boolean {
  return policy.capabilities(config).cache_mode === 'active' || policy.explicitCache(config)
}
export class InProcessPrefixCoordinator implements PrefixCoordinator {
  readonly #tails = new Map<string, Promise<void>>()
  async run<T>(key: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const current = previous.then(() => gate)
    this.#tails.set(key, current)
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new ProviderError('cancelled')); return }
        const cancel = () => { signal.removeEventListener('abort', cancel); reject(new ProviderError('cancelled')) }
        signal.addEventListener('abort', cancel, { once: true })
        void previous.then(() => { signal.removeEventListener('abort', cancel); resolve() })
      })
      throwIfCancelled(signal)
      return await operation()
    } finally {
      release()
      void current.then(() => { if (this.#tails.get(key) === current) this.#tails.delete(key) })
    }
  }
}

export function stableRequestFingerprint(request: JsonObject, rowsKey: string, stableCount: number, digest: (value: unknown) => string): string | null {
  const rows = request[rowsKey]
  if (!Array.isArray(rows) || stableCount <= 0) return null
  const { [rowsKey]: _rows, stream: _stream, ...base } = request
  return digest({ ...base, stable_rows_key: rowsKey, stable_rows: rows.slice(0, stableCount) })
}
