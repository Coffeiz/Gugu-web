import { observe } from './values.js'
import { throwIfCancelled } from './errors.js'
import type { ProviderDriverDependencies, ProviderHttpRequest, ProviderHttpResponse } from './contracts.js'
import { classifyProviderError, ProviderError } from './errors.js'
import { record } from './values.js'

export function endpoint(base: string, path: string): string { return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '') }

async function response(deps: ProviderDriverDependencies, request: ProviderHttpRequest, signal: AbortSignal): Promise<ProviderHttpResponse> {
  throwIfCancelled(signal)
  let result: ProviderHttpResponse
  try { result = await deps.transport.request(request, signal) }
  catch (error) {
    observe(() => deps.diagnose?.('provider_transport', error))
    if (signal.aborted) throw new ProviderError('cancelled')
    throw classifyProviderError(error)
  }
  if (result.status < 200 || result.status >= 300) {
    let body: unknown
    try { body = JSON.parse(await readBody(result, signal, 1024 * 1024)) }
    catch { body = undefined }
    finally { await result.cancel() }
    if (signal.aborted) throw new ProviderError('cancelled')
    const detail = JSON.stringify(body ?? '').toLowerCase()
    const responses = /\/responses(?:\?|$)/.test(request.url)
    const incompatible = responses && ([405, 415, 501].includes(result.status)
      || [400, 404, 422].includes(result.status) && /json_parse_error|responseinput|response input|responses endpoint|responses api|does not support responses|unsupported responses/.test(detail))
    const error = classifyProviderError({ status: result.status, body }, { requestStarted: true, outputStarted: false, protocolIncompatible: incompatible, providerUrl: request.url })
    observe(() => deps.diagnose?.('provider_http', { status: result.status, body }))
    throw error
  }
  return result
}

async function readBody(result: ProviderHttpResponse, signal: AbortSignal, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let value = '', size = 0
  for await (const chunk of result.body) {
    throwIfCancelled(signal)
    size += chunk.byteLength
    if (size > maxBytes) throw new ProviderError('protocol')
    value += decoder.decode(chunk, { stream: true })
  }
  throwIfCancelled(signal)
  return value + decoder.decode()
}

export async function requestJson(deps: ProviderDriverDependencies, request: ProviderHttpRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
  const result = await response(deps, request, signal)
  const cancel = () => { void result.cancel() }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const body: unknown = JSON.parse(await readBody(result, signal, 64 * 1024 * 1024))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('protocol')
    return record(body)
  } catch (error) {
    if (signal.aborted) throw new ProviderError('cancelled')
    observe(() => deps.diagnose?.('provider_json', error))
    if (error instanceof SyntaxError || error instanceof TypeError && String(record(error).code).startsWith('ERR_ENCODING_'))
      throw new ProviderError('protocol', { requestStarted: true })
    throw classifyProviderError(error, { requestStarted: true })
  } finally { signal.removeEventListener('abort', cancel); await result.cancel() }
}

async function* lines(result: ProviderHttpResponse, signal: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  for await (const chunk of result.body) {
    throwIfCancelled(signal)
    pending += decoder.decode(chunk, { stream: true })
    let match: RegExpExecArray | null
    while ((match = /\r\n|\n|\r(?!$)/.exec(pending))) {
      yield pending.slice(0, match.index)
      pending = pending.slice(match.index + match[0].length)
    }
    if (pending.length > 16 * 1024 * 1024) throw new ProviderError('protocol', { requestStarted: true })
  }
  throwIfCancelled(signal)
  pending += decoder.decode()
  if (pending.endsWith('\r')) pending = pending.slice(0, -1)
  if (pending) yield pending
}

export async function* requestEvents(deps: ProviderDriverDependencies, request: ProviderHttpRequest, signal: AbortSignal): AsyncGenerator<{ event: string; data: unknown }> {
  const result = await response(deps, request, signal)
  const cancel = () => { void result.cancel() }
  signal.addEventListener('abort', cancel, { once: true })
  let event = '', data: string[] = [], size = 0
  const emit = () => {
    const raw = data.join('\n')
    if (raw === '[DONE]') return { event: 'done', data: null }
    try { return { event: event || 'message', data: JSON.parse(raw) as unknown } }
    catch { throw new ProviderError('protocol', { requestStarted: true }) }
  }
  try {
    for await (const line of lines(result, signal)) {
      if (!line) {
        if (data.length) yield emit()
        event = ''; data = []; size = 0
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') event = value
        if (field === 'data') { data.push(value); size += value.length }
        if (size > 16 * 1024 * 1024) throw new ProviderError('protocol', { requestStarted: true })
      }
    }
    if (data.length) yield emit()
  } catch (error) {
    if (signal.aborted) throw new ProviderError('cancelled')
    observe(() => deps.diagnose?.('provider_stream', error))
    throw error instanceof ProviderError ? error : classifyProviderError(error, { requestStarted: true })
  } finally { signal.removeEventListener('abort', cancel); await result.cancel() }
}

export async function* requestNdjson(deps: ProviderDriverDependencies, request: ProviderHttpRequest, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const result = await response(deps, request, signal)
  const cancel = () => { void result.cancel() }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for await (const line of lines(result, signal)) {
      if (!line.trim()) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { throw new ProviderError('protocol', { requestStarted: true }) }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('protocol')
      yield record(value)
    }
  } catch (error) {
    if (signal.aborted) throw new ProviderError('cancelled')
    throw error instanceof ProviderError ? error : classifyProviderError(error, { requestStarted: true })
  } finally { signal.removeEventListener('abort', cancel); await result.cancel() }
}
