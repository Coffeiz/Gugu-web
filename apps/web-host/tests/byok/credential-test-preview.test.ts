import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Fastify from 'fastify'
import { afterEach, test } from 'node:test'
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
