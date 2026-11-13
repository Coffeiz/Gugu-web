import type { JsonObject, ProviderConfig, ProviderDriverDependencies, ProviderHttpRequest, ProviderHttpResponse, ProviderInvocation, ProviderPolicy } from '../../../../src/agent/providers/contracts.js'
import { createHash } from 'node:crypto'
import { record } from '../../../../src/agent/providers/values.js'

const encoder = new TextEncoder()
export function fakeResponse(value: unknown, options: { status?: number; headers?: Record<string, string>; raw?: string; chunks?: Uint8Array[] } = {}): ProviderHttpResponse & { closed: boolean; chunksRead: number } {
  let closed = false, chunksRead = 0
  const result: ProviderHttpResponse & { closed: boolean; chunksRead: number } = {
    status: options.status ?? 200, headers: options.headers ?? {}, get closed() { return closed }, get chunksRead() { return chunksRead },
    body: (async function* () { for (const chunk of options.chunks ?? [encoder.encode(options.raw ?? JSON.stringify(value))]) { chunksRead++; yield chunk } })(),
    cancel() { closed = true },
  }
  return result
}
export function fakeDependencies(responses: ProviderHttpResponse[] | ((request: ProviderHttpRequest, signal: AbortSignal) => Promise<ProviderHttpResponse>)) {
  const requests: ProviderHttpRequest[] = [], diagnostics: { code: string; error: unknown }[] = []
  const dependencies: ProviderDriverDependencies = {
    transport: { request: async (request, signal) => {
      signal.throwIfAborted(); requests.push(request)
      const response = typeof responses === 'function' ? await responses(request, signal) : responses.shift()
      if (!response) throw new Error('合成响应已耗尽')
      return response
    } },
    digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    diagnose: (code, error) => { diagnostics.push({ code, error }) },
  }
  return { dependencies, requests, diagnostics }
}
export async function readRequestBody(request: ProviderHttpRequest): Promise<string> {
  const body = request.body
  if (!body) return ''
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (Symbol.asyncIterator in body) {
    let text = ''
    for await (const bytes of body as AsyncIterable<Uint8Array>) text += new TextDecoder().decode(bytes)
    return text
  }
  return JSON.stringify(body)
}
export function invocation(policy: ProviderPolicy, config: Partial<ProviderConfig> = {}, input: Partial<ProviderInvocation> = {}): ProviderInvocation {
  return {
    config: { provider: policy.name, model: '合成模型', api_key: 'synthetic-key', ...config }, policy,
    history: [], system: '', tools: [], purpose: 'chat', signal: new AbortController().signal,
    scope: { ownerId: '小北', sessionId: 'session', runId: 'run', round: 1, modelIdentity: 'synthetic-model', accessScopeHash: 'scope-hash' },
    ...input,
  }
}
export function requestJsonBody(request: ProviderHttpRequest): JsonObject { return record(request.body) as JsonObject }
