import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ProviderEvent } from '../../../src/agent/harness/contracts.js'
import type { JsonObject, ProviderDriverDependencies, ProviderHttpRequest, ProviderInvocation, ProviderPolicy } from '../../../src/agent/providers/contracts.js'
import { openaiPolicy } from '../../../src/agent/providers/openai/driver.js'

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function invocation(overrides: Partial<ProviderInvocation> = {}): ProviderInvocation {
  return { config: { provider: 'openai', model: 'gpt-test', api_key: 'synthetic-api-key' }, policy: openaiPolicy,
    history: [{ role: 'user', content: '合成问题' }], system: '固定规则', tools: [], signal: new AbortController().signal,
    scope: { ownerId: 'owner-synthetic', sessionId: 'session-synthetic', runId: 'run-synthetic', round: 1, modelIdentity: 'model-synthetic', accessScopeHash: 'scope-synthetic' }, purpose: 'chat', ...overrides }
}
export function transport(payload: unknown, options: { status?: number; raw?: boolean; chunkSize?: number; afterChunk?: () => void } = {}): {
  deps: ProviderDriverDependencies; requests: ProviderHttpRequest[]; cancel: Mock<() => Promise<undefined>>; diagnose: Mock; pulls: () => number
} {
  const requests: ProviderHttpRequest[] = [], cancel = vi.fn(async () => undefined), diagnose = vi.fn()
  let pulls = 0
  const encoded = new TextEncoder().encode(options.raw ? String(payload) : JSON.stringify(payload))
  const deps: ProviderDriverDependencies = { digest, diagnose, transport: { request: async request => {
    requests.push(structuredClone(request))
    return { status: options.status ?? 200, headers: {}, cancel, body: (async function* () {
      const size = options.chunkSize ?? encoded.length
      for (let index = 0; index < encoded.length; index += size) { pulls++; yield encoded.slice(index, index + size); options.afterChunk?.() }
    })() }
  } } }
  return { deps, requests, cancel, diagnose, pulls: () => pulls }
}
export const sse = (...events: unknown[]) => events.map(event => event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`).join('')
export async function events(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> { const output: ProviderEvent[] = []; for await (const event of stream) output.push(event); return output }
export function customPolicy(overrides: Partial<ProviderPolicy>): ProviderPolicy { return { ...openaiPolicy, ...overrides } }
export const tool: JsonObject = { type: 'function', function: { name: 'lookup', description: '合成查询', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }
