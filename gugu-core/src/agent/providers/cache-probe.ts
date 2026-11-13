import type { Usage } from '../harness/contracts.js'
import type { JsonObject } from './contracts.js'
import { ProviderError } from './errors.js'
import { clone, observe, record } from './values.js'

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
  constructor(request: JsonObject, readonly options: { id: string; digest: (value: unknown) => string; now: () => number; sink: ProviderProbeSink; secrets?: readonly string[]; diagnose?: (error: unknown) => void }) {
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
