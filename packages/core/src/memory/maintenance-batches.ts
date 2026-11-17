import { createHash } from 'node:crypto'

export const MAX_BATCH_CHARS = 24_000
export const MAX_EXISTING_MEMORY_CHARS = 12_000

export interface MaintenanceContextBudget {
  outputTokens: number
  batchChars: number
  existingMemoryChars: number
}

export function resolveMaintenanceBudget(modelConfig: unknown): MaintenanceContextBudget {
  const outer = object(modelConfig)
  const config = object(outer?.ai) ?? outer
  const contextTokens = integer(config?.context_tokens)
  const configuredOutput = integer(config?.max_tokens)
  if (contextTokens <= 1 || configuredOutput <= 0) throw new RangeError('当前模型缺少有效的 context_tokens/max_tokens')
  const outputTokens = Math.min(configuredOutput, Math.max(1, Math.floor(contextTokens / 4)))
  const tiers: readonly [number, number, number][] = [
    [4096, 1000, 400], [8192, 2500, 1000], [16384, 6000, 2000], [32768, 12000, 6000],
  ]
  for (const [window, batchChars, existingMemoryChars] of tiers) {
    if (contextTokens <= window) return { outputTokens, batchChars, existingMemoryChars }
  }
  return { outputTokens, batchChars: MAX_BATCH_CHARS, existingMemoryChars: MAX_EXISTING_MEMORY_CHARS }
}

export interface MaintenanceBatch<T> {
  items: readonly T[]
  sourceIds: readonly string[]
  inputChars: number
  hasOversizedItem: boolean
}

export function splitMaintenanceBatches<T>(
  items: readonly T[], render: (item: T) => string, sourceId: (item: T) => unknown, maxChars: number,
): MaintenanceBatch<T>[] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new RangeError('maintenance batch budget must be positive')
  const batches: MaintenanceBatch<T>[] = []
  let current: T[] = [], currentChars = 0
  const flush = () => {
    if (!current.length) return
    batches.push({ items: current, sourceIds: current.map(item => String(sourceId(item))), inputChars: currentChars, hasOversizedItem: false })
    current = []; currentChars = 0
  }
  for (const item of items) {
    const itemChars = Array.from(render(item)).length
    if (itemChars > maxChars) {
      flush()
      batches.push({ items: [item], sourceIds: [String(sourceId(item))], inputChars: itemChars, hasOversizedItem: true })
      continue
    }
    if (current.length && currentChars + 1 + itemChars > maxChars) flush()
    currentChars += itemChars + Number(current.length > 0)
    current.push(item)
  }
  flush()
  return batches
}

export function messageBatches<T>(items: readonly T[], render: (item: T) => string, sourceId: (item: T) => unknown, options: { maxChars?: number } = {}): MaintenanceBatch<T>[] {
  return splitMaintenanceBatches(items, render, sourceId, options.maxChars ?? MAX_BATCH_CHARS)
}

export function scopeRevision(current: unknown, sourceIds: readonly unknown[], sourceText: string): string {
  const stable = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
    if (Array.isArray(value)) return `[${value.map(stable).join(', ')}]`
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${stable(item)}`).join(', ')}}`
  }
  const payload = stable({ current, source_ids: sourceIds.map(String), source_text: sourceText })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function boundedScopeMemory(current: unknown, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? MAX_EXISTING_MEMORY_CHARS
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new RangeError('scope memory budget must be non-negative')
  const source = object(current), parts: string[] = []
  let used = 0
  for (const key of ['summary', 'profile', 'pattern', 'memory', 'daily']) {
    const value = source?.[key]
    if (!value) continue
    const text = typeof value === 'object' ? pythonJson(value) : String(value)
    const separator = Number(parts.length > 0), label = `${key}: `
    const remaining = maxChars - used - label.length - separator
    if (remaining <= 0) break
    const bounded = Array.from(text).slice(0, remaining).join('').trimEnd()
    if (bounded) { parts.push(label + bounded); used += Array.from(parts.at(-1)!).length + separator }
  }
  return parts.join('\n')
}

/** Python json.dumps 的默认分隔符会在逗号和冒号后加入一个空格。 */
function pythonJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
    .join(', ')}}`
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function integer(value: unknown): number {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? Math.trunc(number) : 0
}
