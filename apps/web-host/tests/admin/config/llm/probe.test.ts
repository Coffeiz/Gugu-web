import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Fastify from 'fastify'
import { afterEach, test } from 'node:test'
import { createApp } from '../../../../src/app.js'
import { createAdminLlmCapabilityProbe } from '../../../../src/modules/admin/llm-probe.js'
import { LlmCapabilityProbeError } from '@gugu/core/agent/config'

const apps: Array<ReturnType<typeof Fastify>> = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

test('能力探测要求管理员权限，拒绝 Ollama native，并报告不存在预设', async () => {
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    adminAuth: { registerRoutes() {}, async verifyAdmin() { return true }, async requireAdmin(request, reply) {
      if (request.headers.authorization !== 'Bearer admin') return reply.code(401).send({ detail: '未授权' })
    } },
    adminLlmCapabilityProbe: { probe: async id => {
      if (id === 'missing') throw new LlmCapabilityProbeError(404, '预设不存在')
      if (id === 'native') throw new LlmCapabilityProbeError(400, 'Ollama 原生模式请使用连通性/多模态检测；能力探测接口仅支持 OpenAI 兼容模式')
      return { fingerprint: '0123456789abcdef', checked_at: '2026-01-01T00:00:00Z', results: {}, declared_capabilities: {} }
    } },
  })
  apps.push(app)

  const url = '/api/v1/admin/agent/llm-presets/openai/capabilities'
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401)
  const missing = await app.inject({ method: 'POST', url: url.replace('openai', 'missing'), headers: { authorization: 'Bearer admin' } })
  const native = await app.inject({ method: 'POST', url: url.replace('openai', 'native'), headers: { authorization: 'Bearer admin' } })
  assert.equal(missing.statusCode, 404)
  assert.equal(native.statusCode, 400)
})

test('能力探测经真实 App、Core、持久化配置与安全 Provider transport 执行', async () => {
  const received: Array<{ path: string; body: string; authorization: string }> = []
  const upstream = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      received.push({ path: request.url ?? '', body, authorization: String(request.headers.authorization ?? '') })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[] }\n\n')
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const item: Record<string, unknown> = { id: 'local', provider: 'local', api_format: 'openai', model: 'synthetic-model', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'synthetic-key' }
  const document: Record<string, unknown> = { ai_presets: { active_id: 'local', items: [item] } }
  let invalidated = 0
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    adminAuth: { registerRoutes() {}, async verifyAdmin() { return true }, async requireAdmin() {} },
    adminLlmCapabilityProbe: { probe: createAdminLlmCapabilityProbe({
      environment: {}, readDocument: () => structuredClone(document), mutate: async change => change(document),
      invalidate: async () => { invalidated++ },
    }) },
  })
  apps.push(app)
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/local/capabilities' })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(Object.keys(response.json().results), ['chat', 'stream', 'tools', 'json_object', 'json_schema', 'reasoning'])
    assert.ok(received.length >= 6)
    assert.equal(received[0]?.path, '/v1/models')
    assert.ok(received.slice(1).every(request => request.path === '/v1/chat/completions'))
    assert.ok(received.every(request => request.authorization === 'Bearer synthetic-key'))
    assert.ok(received.some(request => request.body && JSON.parse(request.body).tools))
    assert.ok(received.some(request => request.body && JSON.parse(request.body).response_format?.type === 'json_schema'))
    assert.equal(typeof item.capability_fingerprint, 'string')
    assert.deepEqual(item.capability_probe, response.json().results)
    assert.equal((document.ai as Record<string, unknown>).model, 'synthetic-model')
    assert.equal(invalidated, 1)
    assert.equal(JSON.stringify(response.json()).includes('synthetic-key'), false)
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  }
})

test('能力探测期间预设目的地变化时拒绝回写探测结果', async () => {
  const item: Record<string, unknown> = { id: 'local', provider: 'local', api_format: 'openai', model: 'old-model', base_url: 'http://127.0.0.1:8000/v1', api_key: '' }
  const document: Record<string, unknown> = { ai_presets: { active_id: 'local', items: [item] } }
  let invalidated = 0
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    adminAuth: { registerRoutes() {}, async verifyAdmin() { return true }, async requireAdmin() {} },
    adminLlmCapabilityProbe: { probe: createAdminLlmCapabilityProbe({
      readDocument: () => structuredClone(document),
      mutate: async change => { item.model = 'new-model'; return change(document) },
      createTransport: () => ({ async request() { return { status: 200, headers: {}, body: (async function* () {})(), async cancel() {} } } }),
      invalidate: async () => { invalidated++ },
    }) },
  })
  apps.push(app)

  const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/local/capabilities' })
  assert.equal(response.statusCode, 409)
  assert.deepEqual(response.json(), { detail: '探测期间预设已更改，请重新探测' })
  assert.equal(item.model, 'new-model')
  assert.equal(item.capability_probe, undefined)
  assert.equal(invalidated, 0)
})

test('Responses 协议只探测 Responses 形状并按 Python 的成功状态语义分类', async () => {
  const paths: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const upstream = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      paths.push(request.url ?? '')
      bodies.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {"type":"response.created"}\n\n')
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const document = { ai_presets: { active_id: 'responses', items: [
    { id: 'responses', provider: 'local', api_format: 'responses', model: 'synthetic-model', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'synthetic-key' },
  ] } }
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    adminAuth: { registerRoutes() {}, async verifyAdmin() { return true }, async requireAdmin() {} },
    adminLlmCapabilityProbe: { probe: createAdminLlmCapabilityProbe({
      environment: {}, readDocument: () => structuredClone(document), mutate: async change => change(document), invalidate: async () => {},
    }) },
  })
  apps.push(app)
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/responses/capabilities' })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(paths.length, 5)
    assert.ok(paths.every(path => path === '/v1/responses'))
    assert.ok(bodies.some(body => Array.isArray(body.tools) && (body.tools[0] as Record<string, unknown>).name === 'probe_noop'))
    assert.ok(bodies.some(body => (body.text as Record<string, unknown>)?.format))
    assert.deepEqual(response.json().results.chat, { status: '支持', detail: 'Responses HTTP 200' })
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  }
})
