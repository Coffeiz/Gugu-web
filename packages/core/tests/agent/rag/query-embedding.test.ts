import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ProviderHttpRequest, ProviderHttpResponse, ProviderTransport } from '../../../src/agent/providers/contracts.js'
import { embedRagQuery, type RagQueryEmbeddingSettings } from '../../../src/agent/rag/query-embedding.js'

const settings = (overrides: Partial<RagQueryEmbeddingSettings> = {}): RagQueryEmbeddingSettings => ({
  provider: 'compatible', baseUrl: 'https://embedding.example/v1', model: 'embed-v1',
  apiKey: 'synthetic-secret', dimensions: 2, ...overrides,
})

function response(status: number, body: AsyncIterable<Uint8Array>, cancel = vi.fn()): ProviderHttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body, cancel }
}

function jsonBody(value: unknown): AsyncIterable<Uint8Array> {
  return (async function* () { yield Buffer.from(JSON.stringify(value)) })()
}

describe('1.7.7 RAG query embedding transport boundary', () => {
  it('sends a trimmed OpenAI-compatible request and never includes the credential in its result', async () => {
    let received: ProviderHttpRequest | undefined
    const transport: ProviderTransport = { async request(request) {
      received = request
      return response(200, jsonBody({ data: [{ embedding: [0.25, -0.75] }] }))
    } }
    const result = await embedRagQuery(settings(), '  查询词  ', transport, new AbortController().signal)
    expect(result).toEqual({ vector: [0.25, -0.75], outcome: 'success', httpStatus: 200 })
    expect(received).toMatchObject({ url: 'https://embedding.example/v1/embeddings', method: 'POST',
      headers: { authorization: 'Bearer synthetic-secret', 'content-type': 'application/json' },
      body: { model: 'embed-v1', input: '查询词', dimensions: 2 }, timeoutMs: 4000, allowLocal: false })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })

  it('keeps Bailian multimodal endpoint and payload shape', async () => {
    let received: ProviderHttpRequest | undefined
    const transport: ProviderTransport = { async request(request) {
      received = request
      return response(200, jsonBody({ output: { embeddings: [{ embedding: [1, 0] }] } }))
    } }
    const result = await embedRagQuery(settings({ provider: 'dashscope',
      baseUrl: 'https://dashscope.example/compatible-mode/v1', multimodal: true }),
    '图片描述', transport, new AbortController().signal)
    expect(result.outcome).toBe('success')
    expect(received).toMatchObject({ url: 'https://dashscope.example/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding',
      body: { model: 'embed-v1', input: { contents: [{ text: '图片描述' }] },
        parameters: { output_type: 'dense', dimension: 2, enable_fusion: false } } })
  })

  it('caches successful query vectors for the same model and returns isolated copies', async () => {
    let requests = 0
    const transport: ProviderTransport = { async request() {
      requests += 1
      return response(200, jsonBody({ data: [{ embedding: [0.25, -0.5] }] }))
    } }
    const query = `synthetic cache query ${randomUUID()}`
    const ownerId = randomUUID()
    const first = await embedRagQuery(settings(), query, transport, new AbortController().signal, ownerId)
    first.vector[0] = 99

    const cachedTransport: ProviderTransport = { async request() { throw new Error('cache hit must not call transport') } }
    const second = await embedRagQuery(settings(), ` ${query} `, cachedTransport, new AbortController().signal, ownerId)

    expect(first.outcome).toBe('success')
    expect(second).toMatchObject({ vector: [0.25, -0.5], outcome: 'success' })
    expect(requests).toBe(1)
  })

  it('keeps query vectors isolated by model and dimensions', async () => {
    const requests: string[] = []
    const transport: ProviderTransport = { async request(request) {
      const model = String(request.body.model)
      requests.push(`${model}:${String(request.body.dimensions)}`)
      const vector = model === 'embed-v1' ? [0.25, -0.5] : [0.75, -1, 0.5]
      return response(200, jsonBody({ data: [{ embedding: vector }] }))
    } }
    const query = `synthetic model cache query ${randomUUID()}`
    const ownerId = randomUUID()

    expect((await embedRagQuery(settings(), query, transport, new AbortController().signal, ownerId)).vector)
      .toEqual([0.25, -0.5])
    expect((await embedRagQuery(settings({ model: 'embed-v2', dimensions: 3 }), query, transport,
      new AbortController().signal, ownerId)).vector).toEqual([0.75, -1, 0.5])

    expect(requests).toEqual(['embed-v1:2', 'embed-v2:3'])
  })

  it('isolates the same text by owner, endpoint, and credential and skips cache without a trusted owner', async () => {
    let requests = 0
    const transport: ProviderTransport = { async request() {
      requests += 1
      return response(200, jsonBody({ data: [{ embedding: [requests, 1] }] }))
    } }
    const ownerId = randomUUID()
    const query = `合成权限回归 ${randomUUID()}`
    const signal = new AbortController().signal
    expect((await embedRagQuery(settings(), query, transport, signal, ownerId)).vector).toEqual([1, 1])
    expect((await embedRagQuery(settings(), query, transport, signal, randomUUID())).vector).toEqual([2, 1])
    expect((await embedRagQuery(settings({ baseUrl: 'https://other-embedding.example/v1' }), query, transport, signal, ownerId)).vector).toEqual([3, 1])
    expect((await embedRagQuery(settings({ apiKey: 'synthetic-rotated' }), query, transport, signal, ownerId)).vector).toEqual([4, 1])
    expect((await embedRagQuery(settings(), query, transport, signal)).vector).toEqual([5, 1])
    expect((await embedRagQuery(settings(), query, transport, signal)).vector).toEqual([6, 1])
    expect((await embedRagQuery(settings(), query, transport, signal, ownerId)).vector).toEqual([1, 1])
  })

  it('does not cache failed responses', async () => {
    let requests = 0
    const transport: ProviderTransport = { async request() {
      requests += 1
      return requests === 1
        ? response(503, jsonBody({ error: 'synthetic outage' }))
        : response(200, jsonBody({ data: [{ embedding: [0.25, -0.5] }] }))
    } }
    const query = `synthetic retry cache query ${randomUUID()}`
    const ownerId = randomUUID()

    expect(await embedRagQuery(settings(), query, transport, new AbortController().signal, ownerId))
      .toMatchObject({ vector: [], outcome: 'http_error', httpStatus: 503 })
    expect(await embedRagQuery(settings(), query, transport, new AbortController().signal, ownerId))
      .toMatchObject({ vector: [0.25, -0.5], outcome: 'success', httpStatus: 200 })
    expect(requests).toBe(2)
  })

  it('rejects unsafe endpoint configuration before transport and does not follow a redirect response', async () => {
    const request = vi.fn(async () => response(302, jsonBody({ data: [{ embedding: [1, 0] }] })))
    const transport: ProviderTransport = { request }
    for (const baseUrl of ['file:///private/data', 'https://user:pass@embedding.example/v1',
      'https://embedding.example/v1?token=secret', 'https://embedding.example/v1#fragment']) {
      expect(await embedRagQuery(settings({ baseUrl }), 'query', transport, new AbortController().signal))
        .toMatchObject({ vector: [], outcome: 'invalid_config' })
    }
    expect(request).not.toHaveBeenCalled()

    const cancelled = vi.fn()
    request.mockResolvedValueOnce(response(302, jsonBody({ data: [{ embedding: [1, 0] }] }), cancelled))
    expect(await embedRagQuery(settings(), 'query', transport, new AbortController().signal))
      .toEqual({ vector: [], outcome: 'http_error', httpStatus: 302 })
    expect(request).toHaveBeenCalledTimes(1)
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('cancels over-limit responses and returns only a safe status', async () => {
    const cancelled = vi.fn()
    const body = (async function* () { yield new Uint8Array(2 * 1024 * 1024 + 1) })()
    const transport: ProviderTransport = { async request() { return response(200, body, cancelled) } }
    expect(await embedRagQuery(settings(), 'query', transport, new AbortController().signal))
      .toEqual({ vector: [], outcome: 'response_too_large', httpStatus: 200 })
    expect(cancelled).toHaveBeenCalledOnce()
  })
})
