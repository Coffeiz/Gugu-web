import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Fastify from 'fastify'
import { afterEach, test } from 'node:test'
import type { ProviderHttpRequest } from '@gugu/core/providers'
import { createByokCredentialTestProbe, registerCredentialTestPreviewRoute } from '../../src/modules/byok/credential-test-preview.js'

const ownerId = '00000000-0000-4000-8000-000000000141'
const apps: Array<ReturnType<typeof Fastify>> = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

test('test-preview authenticates, validates the draft and returns safe HTTP error details', async () => {
  const app = Fastify()
  apps.push(app)
  registerCredentialTestPreviewRoute(app, {
    requireUser: async (request, reply) => {
      if (request.headers.authorization !== 'Bearer test') return reply.code(401).send({ detail: '未授权' })
    },
    ownerIdFromRequest: () => ownerId,
    savedTest: async (owner, id) => {
      assert.equal(owner, ownerId)
      assert.equal(id, 7)
      throw Object.assign(new Error('凭据不存在'), { code: 'not_found' })
    },
    preview: async (owner, input) => {
      assert.equal(owner, ownerId)
      assert.equal(input.capability, 'llm')
      throw Object.assign(new Error('凭据不存在'), { code: 'not_found' })
    },
  })
  const denied = await app.inject({ method: 'POST', url: '/api/v1/byok/test-preview', payload: {} })
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/byok/test-preview', headers: { authorization: 'Bearer test' }, payload: { provider: 'x', capability: 'other' } })
  const missing = await app.inject({ method: 'POST', url: '/api/v1/byok/test-preview', headers: { authorization: 'Bearer test' }, payload: { provider: 'x', capability: 'llm' } })
  const savedMissing = await app.inject({ method: 'POST', url: '/api/v1/byok/7/test', headers: { authorization: 'Bearer test' } })
  assert.equal(denied.statusCode, 401)
  assert.equal(invalid.statusCode, 422)
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), { detail: '凭据不存在' })
  assert.equal(savedMissing.statusCode, 404)
  assert.deepEqual(savedMissing.json(), { detail: '凭据不存在' })
})

test('test-preview preserves Pydantic integer coercion for numeric-string integer fields', async () => {
  const app = Fastify()
  apps.push(app)
  let receivedId: number | null | undefined
  let receivedDimensions: number | null | undefined
  registerCredentialTestPreviewRoute(app, {
    requireUser: async () => {},
    ownerIdFromRequest: () => ownerId,
    savedTest: async () => ({ ok: true, status: 'stored', message: '凭据正常' }),
    preview: async (_owner, input) => {
      receivedId = input.credential_id
      receivedDimensions = input.dimensions
      throw Object.assign(new Error('凭据不存在'), { code: 'not_found' })
    },
  })

  const response = await app.inject({ method: 'POST', url: '/api/v1/byok/test-preview',
    payload: { provider: 'deepseek', capability: 'embedding', credential_id: '7', dimensions: '1536' } })
  const malformed = await app.inject({ method: 'POST', url: '/api/v1/byok/test-preview',
    payload: { provider: 'deepseek', capability: 'llm', credential_id: '7.0' } })

  assert.equal(response.statusCode, 404)
  assert.equal(receivedId, 7)
  assert.equal(receivedDimensions, 1536)
  assert.equal(malformed.statusCode, 422)
})

test('saved credential test rejects exponent-form IDs like FastAPI int path parameters', async () => {
  const app = Fastify()
  apps.push(app)
  let reads = 0
  registerCredentialTestPreviewRoute(app, {
    requireUser: async () => {},
    ownerIdFromRequest: () => ownerId,
    preview: async () => ({ ok: true, status: 200, message: 'unused' }),
    savedTest: async () => { reads++; return { ok: true, status: 'stored', message: '凭据正常' } },
  })

  const response = await app.inject({ method: 'POST', url: '/api/v1/byok/1e2/test' })

  assert.equal(response.statusCode, 422)
  assert.equal(reads, 0)
})

test('LLM draft probe performs a real local request via the pinned Node transport without following redirects', async () => {
  let captured: { path?: string; authorization?: string; body?: { model?: string } } = {}
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      captured = { path: request.url, authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()) as { model?: string } }
      response.writeHead(302, { location: '/unexpected' }).end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const probe = createByokCredentialTestProbe({})
    const result = await probe({ provider: 'local', capability: 'llm', apiFormat: 'openai',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-model', apiKey: 'synthetic-key' })
    assert.deepEqual(result, { ok: true, status: 302, detail: '' })
    assert.equal(captured.path, '/v1/chat/completions')
    assert.equal(captured.authorization, 'Bearer synthetic-key')
    assert.equal(captured.body?.model, 'synthetic-model')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('keyless local Embedding probe requires a returned vector and sends no Authorization header', async () => {
  let captured: { path?: string; authorization?: string; body?: { model?: string; input?: string; dimensions?: number } } = {}
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      captured = { path: request.url, authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()) as typeof captured.body }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"embedding":[0.25,0.5]}]}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const probe = createByokCredentialTestProbe({})
    const result = await probe({ provider: 'local', capability: 'embedding', apiFormat: 'openai',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'bge-m3', dimensions: 2, apiKey: '' })
    assert.deepEqual(result, { ok: true, status: 200, detail: '', message: 'Embedding 连接正常' })
    assert.equal(captured.path, '/v1/embeddings')
    assert.equal(captured.authorization, undefined)
    assert.deepEqual(captured.body, { model: 'bge-m3', input: 'ping', dimensions: 2 })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('Embedding upstream errors hide the submitted key and provider URLs', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
      .end('{"error":{"message":"bad key sk-synthetic-secret at https://internal.example/private"}}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const probe = createByokCredentialTestProbe({})
    const result = await probe({ provider: 'local', capability: 'embedding', apiFormat: 'openai',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'bge-m3', apiKey: 'sk-synthetic-secret' })
    assert.equal(result.status, 401)
    assert.doesNotMatch(result.message ?? '', /sk-synthetic-secret|internal\.example|private/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('BYOK语音草稿经Core DashScope ASR协议发送静音探针且不改写完整端点', async () => {
  let captured: ProviderHttpRequest | undefined
  let closed = false
  const probe = createByokCredentialTestProbe({}, {
    createTransport: () => ({
      async request(request: ProviderHttpRequest) {
        captured = request
        return {
          status: 200, headers: {},
          body: (async function* () { yield new TextEncoder().encode('{"output":{"sentence":{"text":""}}}') })(),
          async cancel() {},
        }
      },
      async close() { closed = true },
    }),
  })

  const result = await probe({ provider: 'qwen', capability: 'speech_to_text', apiFormat: 'dashscope',
    baseUrl: 'http://127.0.0.1:39999/api/v1/services/aigc/multimodal-generation/generation',
    model: 'Qwen3-ASR-Flash', apiKey: 'synthetic-key' })

  assert.ok(captured, 'ASR 探测应通过注入的传输发出协议请求')
  assert.deepEqual(result, { ok: true, status: 200, detail: '', message: '连接正常（静音测试已收到响应）' })
  assert.equal(captured?.url, 'http://127.0.0.1:39999/api/v1/services/aigc/multimodal-generation/generation')
  assert.equal(captured?.headers.Authorization, 'Bearer synthetic-key')
  assert.deepEqual(captured?.body && typeof captured.body === 'object' && !(captured.body instanceof Uint8Array)
    ? captured.body.parameters : undefined, { asr_options: { enable_itn: false } })
  const body = captured?.body as Record<string, any>
  assert.equal(body.input.messages[0].content[0].audio.startsWith('data:audio/wav;base64,'), true)
  assert.equal(closed, true)
})

test('BYOK MiniMax原生ASR通过共享Provider传输上传一分钟内的wav静音探针', async () => {
  let captured: ProviderHttpRequest | undefined
  let body = ''
  const probe = createByokCredentialTestProbe({}, {
    createTransport: () => ({
      async request(request: ProviderHttpRequest) {
        captured = request
        for await (const chunk of request.body as AsyncIterable<Uint8Array>) body += new TextDecoder().decode(chunk)
        return {
          status: 200, headers: {},
          body: (async function* () { yield new TextEncoder().encode('{"text":""}') })(),
          async cancel() {},
        }
      },
      async close() {},
    }),
  })

  const result = await probe({ provider: 'minimax', capability: 'speech_to_text', apiFormat: 'minimax-asr',
    baseUrl: '', model: 'asr-1.0', apiKey: 'synthetic-key' })

  assert.ok(captured, 'MiniMax ASR 探测应通过注入的传输发出multipart请求')
  assert.deepEqual(result, { ok: true, status: 200, detail: '', message: 'MiniMax ASR 连接正常' })
  assert.equal(captured?.url, 'https://api.minimax.cn/v1/speech_to_text')
  assert.equal(captured?.headers.Authorization, 'Bearer synthetic-key')
  assert.match(body, /filename="audio\.wav"/)
  assert.match(body, /name="model"\r\n\r\nasr-1\.0/)
  assert.doesNotMatch(body, /synthetic-key/)
})

test('BYOK深度研究草稿按Python Tavily协议用固定Provider传输发送探针', async () => {
  let captured: ProviderHttpRequest | undefined
  let closed = false
  const probe = createByokCredentialTestProbe({}, {
    createTransport: () => ({
      async request(request: ProviderHttpRequest) {
        captured = request
        return {
          status: 200, headers: {},
          body: (async function* () {
            yield new TextEncoder().encode('{"answer":"合成结论","results":[{"title":"来源","url":"https://source.example.test","content":"合成正文"}]}')
          })(),
          async cancel() {},
        }
      },
      async close() { closed = true },
    }),
  })

  const result = await probe({ provider: 'tavily', capability: 'deep_research', apiFormat: '',
    baseUrl: '', model: '', apiKey: 'synthetic-key' })

  assert.ok(captured, 'Tavily试呼应经Provider传输发出请求')
  assert.equal(captured.url, 'https://api.tavily.com/search')
  assert.equal(captured.headers['Content-Type'], 'application/json')
  assert.deepEqual(captured.body, { api_key: 'synthetic-key', query: '测试深度研究连接', max_results: 1,
    search_depth: 'basic', include_answer: true })
  assert.deepEqual(result, { ok: true, status: 200, detail: '',
    message: 'tavily 深度研究连接正常（本次测试可能消耗 1 次调用）' })
  assert.equal(closed, true)
})

test('BYOK相似图草稿用有效静态PNG按Python百度协议发起安全探针', async () => {
  let captured: ProviderHttpRequest | undefined
  const probe = createByokCredentialTestProbe({}, {
    createTransport: () => ({
      async request(request: ProviderHttpRequest) {
        captured = request
        return {
          status: 200, headers: {},
          body: (async function* () { yield new TextEncoder().encode('{"result":{"res_data":{"res_items":[]}}}') })(),
          async cancel() {},
        }
      },
      async close() {},
    }),
  })

  const result = await probe({ provider: 'baidu', capability: 'similar_image_search', apiFormat: '',
    baseUrl: '', model: '', apiKey: 'synthetic-key' })

  assert.ok(captured, '百度相似图探测应经固定Provider传输发出请求')
  assert.equal(captured.url, 'https://qianfan.baidubce.com/v2/tools/image_similar_info')
  assert.equal(captured.headers.Authorization, 'Bearer synthetic-key')
  assert.equal(captured.headers['Content-Type'], 'application/json')
  assert.deepEqual(captured.body, { image: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAlklEQVR4nO3QMQ0AMAzAsPLHWC4rDB/L4T/K7O772egArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0A6OSM1jeqEVYAAAAAElFTkSuQmCC', count: 1 })
  assert.deepEqual(result, { ok: true, status: 200, detail: '',
    message: '百度千帆相似图搜索连接正常（本次测试可能消耗 1 次调用）' })
})
