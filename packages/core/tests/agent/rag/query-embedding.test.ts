import { describe, expect, it, vi } from 'vitest'
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
