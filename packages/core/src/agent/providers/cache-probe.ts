import type { Usage } from '../harness/contracts.js'
import type { HistorySanitization, JsonObject } from './contracts.js'
import { ProviderError } from './errors.js'
import { clone, observe, record } from './values.js'
import { stableJson } from '../harness/history/canonical-history.js'

export interface ProviderCacheDiagnostics {
  readonly cache_supported: boolean
  readonly conversation_messages: number
  readonly cache_anchor_count: number
  readonly cache_anchor_indices: readonly number[]
  readonly cache_anchor_last_index: number | null
  readonly cache_prefix_digest: string
  readonly stable_prefix_digest: string
  readonly volatile_image_present: boolean
  readonly volatile_image_first_index: number | null
  readonly stable_message_count: number
  readonly turn_batch_count: number
  readonly tool_count: number
  readonly tool_schema_bytes: number
  readonly tool_schema_digest: string
}

function containsCache(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCache)
  return !!value && typeof value === 'object' && (!!record(record(value).cache_control).type || Object.values(value).some(containsCache))
}
function inlineImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(inlineImage)
  const block = record(value), source = record(block.source)
  if (block.type === 'image' && source.type === 'base64' && source.data) return true
  if (block.type === 'image_url' && String(record(block.image_url).url ?? block.image_url ?? '').startsWith('data:')) return true
  return inlineImageContent(block.content)
}
function inlineImageContent(value: unknown): boolean { return Array.isArray(value) && value.some(inlineImage) }

/** 只基于最终wire的实际断点生成大小/摘要；不推算token，也不公开正文。 */
export function providerCacheDiagnostics(request: JsonObject, digest: (value: unknown) => string, options: { cacheSupported?: boolean; stableRowCount?: number } = {}): ProviderCacheDiagnostics {
  const rows = (Array.isArray(request.messages) ? request.messages : Array.isArray(request.input) ? request.input : []) as JsonObject[]
  const anchors = rows.flatMap((row, index) => row.role !== 'system' && containsCache(row) ? [index] : [])
  const volatile = rows.findIndex(inlineImage), boundary = Math.max(0, Math.min(rows.length, options.stableRowCount ?? rows.length, volatile < 0 ? rows.length : volatile))
  const tools = Array.isArray(request.tools) ? request.tools : []
  const latest = anchors.at(-1) ?? null
  return { cache_supported: options.cacheSupported === true, conversation_messages: rows.length,
    cache_anchor_count: anchors.length, cache_anchor_indices: anchors, cache_anchor_last_index: latest,
    cache_prefix_digest: digest({ system: request.system ?? request.instructions ?? null, tools, rows: rows.slice(0, latest === null ? 0 : latest + 1) }),
    stable_prefix_digest: digest(rows.slice(0, boundary)), volatile_image_present: volatile >= 0, volatile_image_first_index: volatile < 0 ? null : volatile,
    stable_message_count: boundary, turn_batch_count: 0, tool_count: tools.length,
    tool_schema_bytes: new TextEncoder().encode(stableJson(tools)).byteLength, tool_schema_digest: digest(tools).slice(0, 16) }
}

export interface ProviderRequestProbe {
  readonly id: string
  readonly request: JsonObject
  readonly outcome: 'active' | 'success' | 'error'
  readonly requestStartedAt: string
  readonly durationMs: number | null
  readonly normalizedUsage: Usage | null
  readonly rawUsage: unknown
  readonly errorCode: string | null
  readonly errorStatus: number | null
  readonly wirePrefix: { readonly digest: string; readonly rowsKey: string; readonly rowCount: number; readonly anchorPaths: readonly string[] }
  readonly cacheDiagnostics: ProviderCacheDiagnostics
  readonly historySanitization: HistorySanitization | null
}
export type ProviderProbeSink = (probe: ProviderRequestProbe) => void

function credentialFree<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return secrets.reduce((text, secret) => secret ? text.split(secret).join('[凭据]') : text, value) as T
  if (Array.isArray(value)) return value.map(item => credentialFree(item, secrets)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, credentialFree(item, secrets)])) as T
  return value
}

/** 完整正文只交显式受控开发sink；普通事件/日志只能使用另行允许的结构metadata。 */
export class RequestProbe {
  readonly #started: number
  #value: ProviderRequestProbe
  constructor(request: JsonObject, readonly options: { id: string; digest: (value: unknown) => string; now: () => number; sink: ProviderProbeSink; secrets?: readonly string[]; diagnose?: (error: unknown) => void; cacheSupported?: boolean; stableRowCount?: number; historySanitization?: HistorySanitization }) {
    this.#started = options.now()
    const paths: string[] = []
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`))
      else if (value && typeof value === 'object') {
        if (record(record(value).cache_control).type) paths.push(path)
        for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key)
      }
    }
    walk(request, '')
    const rowsKey = Array.isArray(request.messages) ? 'messages' : Array.isArray(request.input) ? 'input' : ''
    const rows = rowsKey ? request[rowsKey] as JsonObject[] : []
    const { messages: _messages, input: _input, stream: _stream, ...base } = request
    const anchored = paths.flatMap(path => {
      const match = new RegExp(`^${rowsKey}\\[(\\d+)\\]`).exec(path)
      return match ? [Number(match[1])] : []
    })
    const prefixRows = anchored.length ? rows.slice(0, Math.max(...anchored) + 1) : rows
    this.#value = {
      id: options.id, request: credentialFree(clone(request), options.secrets ?? []), outcome: 'active', requestStartedAt: new Date(this.#started).toISOString(), durationMs: null,
      normalizedUsage: null, rawUsage: null, errorCode: null, errorStatus: null,
      wirePrefix: { digest: options.digest({ base, rowsKey, rows: prefixRows }), rowsKey, rowCount: prefixRows.length, anchorPaths: paths },
      cacheDiagnostics: providerCacheDiagnostics(request, options.digest, options),
      historySanitization: options.historySanitization ? clone(options.historySanitization) : null,
    }
    this.#publish()
  }
  success(usage: Usage): void { this.#finish({ outcome: 'success', normalizedUsage: clone(usage) }) }
  usage(rawUsage: unknown, normalizedUsage: Usage): void {
    if (this.#value.outcome === 'active') this.#value = { ...this.#value, rawUsage: credentialFree(clone(rawUsage), this.options.secrets ?? []), normalizedUsage: clone(normalizedUsage) }
  }
  fail(error: ProviderError): void { this.#finish({ outcome: 'error', errorCode: error.code, errorStatus: error.options.status ?? null }) }
  #finish(change: Partial<ProviderRequestProbe>): void {
    if (this.#value.outcome !== 'active') return
    this.#value = { ...this.#value, ...change, durationMs: Math.max(0, this.options.now() - this.#started) }
    this.#publish()
  }
  #publish(): void {
    try { this.options.sink(clone(this.#value)) }
    catch (error) { observe(() => this.options.diagnose?.(error)) }
  }
}
